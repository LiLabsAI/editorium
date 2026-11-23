import { and, eq, inArray } from "drizzle-orm";
import { NonRetryableError } from "cloudflare:workflows";

import { albums, chatMessages, editInstructions, images, jobs, type ImageRow, type Job } from "../../database/schema";
import { notifyUserEvent } from "./events";
import { createDb } from "./lib/db";
import { friendlyError } from "./lib/history";
import { finishJob, refundJob, type JobType } from "./lib/jobs";
import { logWarn } from "./lib/operations";
import { ProviderError } from "./lib/providers";
import { markSegmentStatus } from "./lib/segmentation";
import {
	runBatchEditJob,
	runEnhanceJob,
	runGenerateJob,
	runInpaintJob,
	runLocalEdit,
	runOutpaintJob,
	runPresetJob,
	runRemoveBackgroundJob,
	runSegmentation,
	runWholePhotoEdit,
	type JobResult,
	type OutpaintPad,
} from "./workflows";
import type { PresetTargetScope } from "../shared/presets";

// max_retries = 3 in wrangler.json allows 1 initial delivery + 3 retries (attempts 1..4).
const MAX_ATTEMPTS = 4;

export interface AiJobMessage {
	jobId: string;
	type: JobType;
	userId: string;
	imageId?: string;
	/** Target album for jobs without a source image (chat generation). */
	albumId?: string;
	segmentId?: string;
	prompt?: string;
	aspect?: string;
	instructions?: Array<{ text: string; bbox: { x: number; y: number; w: number; h: number }; maskR2Key?: string }>;
	/** Pinned instructions this batch applies (only these get marked applied). */
	instructionIds?: string[];
	/** Direct region / mask / pad / references payloads. */
	regionBox?: { x: number; y: number; w: number; h: number };
	maskR2Key?: string;
	referenceImageIds?: string[];
	pad?: OutpaintPad;
	label?: string;
	/** Worker origin, for building signed URLs external models can fetch. */
	origin?: string;
	/** Chat message to link the result onto (agent-initiated jobs). */
	chatMessageId?: string;
	/** Server-resolved hidden-prompt preset metadata. */
	presetId?: string;
	presetName?: string;
	presetScope?: PresetTargetScope;
	presetOpClass?: "reimagine" | "style_transfer";
	presetPreferredModel?: "primary" | "flux";
	finishingAdjustmentsJson?: string | null;
}

type Db = ReturnType<typeof createDb>;

async function loadImage(db: Db, imageId: string | undefined): Promise<ImageRow> {
	const [image] = imageId ? await db.select().from(images).where(eq(images.id, imageId)).limit(1) : [];
	if (!image) throw new ProviderError(`image ${imageId ?? "(none)"} not found`);
	return image;
}

/** Run one job. Returns the branched photo, or null for segmentation. */
async function dispatch(env: Env, db: Db, msg: AiJobMessage): Promise<JobResult | null> {
	switch (msg.type) {
		case "segment": {
			const image = await loadImage(db, msg.imageId);
			await runSegmentation(env, msg.jobId, msg.userId, image);
			return null;
		}
		case "generate": {
			if (!msg.prompt) throw new ProviderError("generate job has no prompt");
			const source = msg.imageId ? await loadImage(db, msg.imageId) : null;
			const albumId = msg.albumId ?? source?.albumId;
			const [album] = albumId ? await db.select().from(albums).where(eq(albums.id, albumId)).limit(1) : [];
			if (!album) throw new ProviderError("target album not found");
			return runGenerateJob(env, msg.userId, album.id, msg.prompt, msg.aspect, source);
		}
		case "enhance":
			return runEnhanceJob(env, msg.userId, await loadImage(db, msg.imageId));
		case "remove_bg":
			return runRemoveBackgroundJob(env, msg.userId, await loadImage(db, msg.imageId));
		case "inpaint": {
			const image = await loadImage(db, msg.imageId);
			if (msg.presetId) {
				if (!msg.prompt) throw new ProviderError("preset job has no compiled prompt");
				return runPresetJob(env, msg.userId, image, {
					presetId: msg.presetId,
					presetName: msg.presetName ?? msg.label ?? "Preset",
					prompt: msg.prompt,
					targetScope: msg.presetScope ?? "whole",
					opClass: msg.presetOpClass ?? "reimagine",
					preferredModel: msg.presetPreferredModel,
					finishingAdjustmentsJson: msg.finishingAdjustmentsJson ?? null,
					regionBox: msg.regionBox,
					maskR2Key: msg.maskR2Key,
					segmentId: msg.segmentId,
					referenceImageIds: msg.referenceImageIds,
					origin: msg.origin,
				});
			}
			if (msg.segmentId) {
				return runInpaintJob(env, msg.userId, image, msg.segmentId, msg.prompt ?? "");
			}
			if (!msg.prompt) throw new ProviderError("edit job has no prompt");
			if (msg.regionBox || msg.maskR2Key) {
				const box = msg.regionBox ?? { x: 0, y: 0, w: 1, h: 1 };
				return runLocalEdit(
					env,
					msg.userId,
					image,
					[
						{
							text: msg.prompt,
							box,
							maskR2Key: msg.maskR2Key,
							referenceImageIds: msg.referenceImageIds,
						},
					],
					msg.label ?? "Edited region",
				);
			}
			return runWholePhotoEdit(env, msg.userId, image, msg.prompt, msg.origin, msg.referenceImageIds);
		}
		case "batch_edit": {
			if (!msg.instructions?.length) throw new ProviderError("batch edit has no instructions");
			const image = await loadImage(db, msg.imageId);
			return runBatchEditJob(env, msg.userId, image, msg.instructions, msg.label ?? "Edited photo");
		}
		case "outpaint": {
			if (!msg.pad) throw new ProviderError("outpaint job has no padding");
			const image = await loadImage(db, msg.imageId);
			return runOutpaintJob(env, msg.userId, image, msg.pad, msg.prompt ?? "");
		}
		default:
			throw new ProviderError(`unsupported job type ${msg.type}`);
	}
}

/** Atomically mark the job done and link any result onto chat & instruction rows. */
async function completeWithResult(db: Db, msg: AiJobMessage, result: JobResult | null): Promise<void> {
	const now = new Date();
	const jobStmt = db
		.update(jobs)
		.set({
			status: "done",
			error: null,
			progress: 100,
			finishedAt: now,
			...(result ? { resultImageId: result.imageId } : {}),
		})
		.where(eq(jobs.id, msg.jobId));

	if (!result) {
		await jobStmt;
		return;
	}

	const extra: Array<Parameters<Db["batch"]>[0][number]> = [];
	if (msg.chatMessageId) {
		extra.push(
			db
				.update(chatMessages)
				.set({ resultImageId: result.imageId, resultVersionId: result.versionId })
				.where(eq(chatMessages.id, msg.chatMessageId)),
		);
	}
	if (msg.type === "batch_edit" && msg.imageId && msg.instructionIds?.length) {
		extra.push(
			db
				.update(editInstructions)
				.set({ status: "applied", resultImageId: result.imageId })
				.where(
					and(
						eq(editInstructions.imageId, msg.imageId),
						inArray(editInstructions.id, msg.instructionIds),
						inArray(editInstructions.status, ["pending", "applying"]),
					),
				),
		);
	}
	await db.batch([jobStmt, ...extra]);
}

async function releaseApplyingInstructions(db: Db, msg: AiJobMessage): Promise<void> {
	if (msg.type !== "batch_edit" || !msg.imageId || !msg.instructionIds?.length) return;
	await db
		.update(editInstructions)
		.set({ status: "pending" })
		.where(
			and(
				eq(editInstructions.imageId, msg.imageId),
				inArray(editInstructions.id, msg.instructionIds),
				eq(editInstructions.status, "applying"),
			),
		);
}

async function failAndRefundJob(env: Env, db: Db, msg: AiJobMessage, rawError: string, attempt?: number): Promise<void> {
	await refundJob(db, msg.jobId);
	await finishJob(db, msg.jobId, "error", rawError);
	await releaseApplyingInstructions(db, msg);
	if (msg.type === "segment" && msg.imageId) await markSegmentStatus(env, msg.imageId, "failed");
	await notifyUserEvent(env, msg.userId, {
		jobId: msg.jobId,
		jobType: msg.type,
		status: "error",
		progress: 100,
		attempt,
		imageId: msg.imageId ?? null,
		error: friendlyError(rawError),
		...(msg.type === "segment" ? { segmentStatus: "failed" as const } : {}),
	});
}

function isRetryable(error: unknown): boolean {
	if (error instanceof ProviderError) return error.retryable;
	if (error instanceof NonRetryableError) return false;
	return true; // unknown errors (D1/R2 hiccups) get another attempt
}

/**
 * Queue consumer (handles both main AI queue and `-dlq`). Delivery is
 * at-least-once, so every message checks its job row first to prevent duplicate
 * branches or double refunds.
 */
export async function handleQueue(batch: MessageBatch<AiJobMessage>, env: Env): Promise<void> {
	const db = createDb(env.DB);
	const isDlq = batch.queue.endsWith("-dlq");

	for (const message of batch.messages) {
		const msg = message.body;
		const [job]: Job[] = msg?.jobId
			? await db.select().from(jobs).where(eq(jobs.id, msg.jobId)).limit(1)
			: [];
		if (!job || job.userId !== msg.userId) {
			logWarn("queue_message_without_job", "dropped", { jobId: msg?.jobId, queue: batch.queue });
			message.ack();
			continue;
		}
		if (job.status === "done" || job.status === "error") {
			message.ack();
			continue;
		}
		if (isDlq) {
			logWarn("ai_job_dlq", "exceeded queue retries", { jobId: job.id, type: msg.type });
			await failAndRefundJob(env, db, msg, "Exceeded maximum retry attempts", message.attempts);
			message.ack();
			continue;
		}
		if (job.resultImageId) {
			// Result was stored but the job was never closed (crash in between).
			await finishJob(db, job.id, "done");
			await notifyUserEvent(env, job.userId, {
				jobId: job.id,
				jobType: msg.type,
				status: "done",
				progress: 100,
				attempt: message.attempts,
				imageId: msg.imageId ?? null,
				resultImageId: job.resultImageId,
			});
			message.ack();
			continue;
		}
		try {
			await db.update(jobs).set({ status: "running", progress: 10 }).where(eq(jobs.id, job.id));
			await notifyUserEvent(env, job.userId, {
				jobId: job.id,
				jobType: msg.type,
				status: "running",
				progress: 10,
				attempt: message.attempts,
				imageId: msg.imageId ?? null,
			});
			const result = await dispatch(env, db, msg);
			await completeWithResult(db, msg, result);
			if (result) {
				console.log(
					JSON.stringify({ event: "ai_job_completed", type: msg.type, jobId: job.id, imageId: result.imageId }),
				);
			}
			await notifyUserEvent(env, job.userId, {
				jobId: job.id,
				jobType: msg.type,
				status: "done",
				progress: 100,
				attempt: message.attempts,
				imageId: msg.imageId ?? null,
				resultImageId: result?.imageId ?? null,
			});
			message.ack();
		} catch (error) {
			const willRetry = isRetryable(error) && message.attempts < MAX_ATTEMPTS;
			logWarn("ai_job_failed", error, { jobId: job.id, type: msg.type, attempt: message.attempts, willRetry });
			if (willRetry) {
				// Keep the row visible as queued while the retry backs off.
				await db.update(jobs).set({ status: "queued", progress: 0 }).where(eq(jobs.id, job.id));
				await notifyUserEvent(env, job.userId, {
					jobId: job.id,
					jobType: msg.type,
					status: "queued",
					progress: 0,
					attempt: message.attempts,
					imageId: msg.imageId ?? null,
				});
				message.retry({ delaySeconds: Math.min(60, 5 * 2 ** message.attempts) });
				continue;
			}
			const rawError = error instanceof Error ? error.message : "Unknown error";
			await failAndRefundJob(env, db, msg, rawError, message.attempts);
			message.ack();
		}
	}
}
