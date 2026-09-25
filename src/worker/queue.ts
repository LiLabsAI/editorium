import { and, eq, inArray } from "drizzle-orm";
import { NonRetryableError } from "cloudflare:workflows";

import { albums, chatMessages, editInstructions, images, jobs, type ImageRow, type Job } from "../../database/schema";
import { createDb } from "./lib/db";
import { finishJob, refundJob, type JobType } from "./lib/jobs";
import { logWarn } from "./lib/operations";
import { ProviderError } from "./lib/providers";
import { markSegmentStatus } from "./lib/segmentation";
import {
	runBatchEditJob,
	runEnhanceJob,
	runGenerateJob,
	runInpaintJob,
	runRemoveBackgroundJob,
	runSegmentation,
	runWholePhotoEdit,
	type JobResult,
} from "./workflows";

const MAX_ATTEMPTS = 3;

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
	instructions?: Array<{ text: string; bbox: { x: number; y: number; w: number; h: number } }>;
	/** Pinned instructions this batch applies (only these get marked applied). */
	instructionIds?: string[];
	label?: string;
	/** Worker origin, for building signed URLs external models can fetch. */
	origin?: string;
	/** Chat message to link the result onto (agent-initiated jobs). */
	chatMessageId?: string;
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
			if (!msg.prompt) throw new ProviderError("edit job has no prompt");
			const image = await loadImage(db, msg.imageId);
			return msg.segmentId
				? runInpaintJob(env, msg.userId, image, msg.segmentId, msg.prompt)
				: runWholePhotoEdit(env, msg.userId, image, msg.prompt, msg.origin);
		}
		case "batch_edit": {
			if (!msg.instructions?.length) throw new ProviderError("batch edit has no instructions");
			const image = await loadImage(db, msg.imageId);
			return runBatchEditJob(env, msg.userId, image, msg.instructions, msg.label ?? "Edited photo");
		}
		default:
			throw new ProviderError(`unsupported job type ${msg.type}`);
	}
}

/** Link a finished result onto the job, the originating chat message and the
 * applied instruction chips. */
async function linkResult(db: Db, msg: AiJobMessage, result: JobResult): Promise<void> {
	await db.update(jobs).set({ resultImageId: result.imageId }).where(eq(jobs.id, msg.jobId));
	if (msg.chatMessageId) {
		await db
			.update(chatMessages)
			.set({ resultImageId: result.imageId, resultVersionId: result.versionId })
			.where(eq(chatMessages.id, msg.chatMessageId));
	}
	if (msg.type === "batch_edit" && msg.imageId && msg.instructionIds?.length) {
		await db
			.update(editInstructions)
			.set({ status: "applied", resultImageId: result.imageId })
			.where(
				and(
					eq(editInstructions.imageId, msg.imageId),
					inArray(editInstructions.id, msg.instructionIds),
					eq(editInstructions.status, "pending"),
				),
			);
	}
}

function isRetryable(error: unknown): boolean {
	if (error instanceof ProviderError) return error.retryable;
	if (error instanceof NonRetryableError) return false;
	return true; // unknown errors (D1/R2 hiccups) get another attempt
}

/**
 * Queue consumer. Delivery is at-least-once, so every message is checked
 * against its job row first: finished jobs are acked without re-running
 * (no duplicate photos, no double refunds).
 */
export async function handleQueue(batch: MessageBatch<AiJobMessage>, env: Env): Promise<void> {
	const db = createDb(env.DB);
	for (const message of batch.messages) {
		const msg = message.body;
		const [job]: Job[] = msg?.jobId
			? await db.select().from(jobs).where(eq(jobs.id, msg.jobId)).limit(1)
			: [];
		if (!job || job.userId !== msg.userId) {
			logWarn("queue_message_without_job", "dropped", { jobId: msg?.jobId });
			message.ack();
			continue;
		}
		if (job.status === "done" || job.status === "error") {
			message.ack();
			continue;
		}
		if (job.resultImageId) {
			// Result was stored but the job was never closed (crash in between).
			await finishJob(db, job.id, "done");
			message.ack();
			continue;
		}
		try {
			await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id));
			const result = await dispatch(env, db, msg);
			if (result) {
				await linkResult(db, msg, result);
				console.log(
					JSON.stringify({ event: "ai_job_completed", type: msg.type, jobId: job.id, imageId: result.imageId }),
				);
			}
			await finishJob(db, job.id, "done");
			message.ack();
		} catch (error) {
			const willRetry = isRetryable(error) && message.attempts < MAX_ATTEMPTS;
			logWarn("ai_job_failed", error, { jobId: job.id, type: msg.type, attempt: message.attempts, willRetry });
			if (willRetry) {
				// Keep the row visible as queued while the retry backs off.
				await db.update(jobs).set({ status: "queued", progress: 0 }).where(eq(jobs.id, job.id));
				message.retry({ delaySeconds: Math.min(60, 5 * 2 ** message.attempts) });
				continue;
			}
			await finishJob(db, job.id, "error", error instanceof Error ? error.message : "Unknown error");
			await refundJob(db, job.id);
			if (msg.type === "segment" && msg.imageId) await markSegmentStatus(env, msg.imageId, "failed");
			message.ack();
		}
	}
}
