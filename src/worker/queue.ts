import { and, eq } from "drizzle-orm";

import { chatMessages, images, jobs } from "../../database/schema";
import { createDb } from "./lib/db";
import { finishJob, refundCredits } from "./lib/jobs";
import { loadImageBytes } from "./lib/operations";
import { ProviderError } from "./lib/providers";
import {
	markSegmentStatus,
	persistSegments,
	runCaptioning,
	runDetection,
	type SegmentationContext,
} from "./lib/segmentation";
import {
	runBatchEditJob,
	runEnhanceJob,
	runGenerateJob,
	runInpaintJob,
	runWholePhotoEdit,
} from "./workflows";

const MAX_ATTEMPTS = 3;
const COSTS: Record<string, number> = { generate: 1, inpaint: 2, enhance: 3 };

/** Inline segmentation executor. (The SegmentWorkflow binding stays available
 * for durable environments, but the queue path works everywhere incl. local
 * dev, so it is the default.) */
async function runSegmentJob(
	env: Env,
	jobId: string,
	userId: string,
	image: typeof images.$inferSelect,
): Promise<void> {
	const db = createDb(env.DB);
	const { bytes, mime } = await loadImageBytes(env, image);
	const ctx: SegmentationContext = {
		env,
		imageId: image.id,
		userId,
		albumId: image.albumId,
		imageBytes: bytes,
		mime,
		widthPx: image.widthPx,
		heightPx: image.heightPx,
	};
	await markSegmentStatus(env, image.id, "pending");
	const progress = async (p: number): Promise<void> => {
		await db.update(jobs).set({ progress: p, status: "running" }).where(eq(jobs.id, jobId));
	};
	const tree = await runDetection(ctx, progress);
	const captioned = await runCaptioning(ctx, tree, progress);
	const count = await persistSegments(ctx, captioned.nodes);
	await markSegmentStatus(env, image.id, captioned.partial ? "partial" : "ready");
	console.log(
		JSON.stringify({ event: "segmentation_completed", jobId, imageId: image.id, segments: count }),
	);
}

export interface AiJobMessage {
	jobId: string;
	type:
		| "segment"
		| "generate"
		| "enhance"
		| "inpaint"
		| "caption"
		| "thumb"
		| "batch_edit";
	userId: string;
	imageId?: string;
	segmentId?: string;
	prompt?: string;
	aspect?: string;
	strength?: number;
	mode?: "literal" | "balanced" | "creative";
	instructions?: Array<{
		text: string;
		bbox: { x: number; y: number; w: number; h: number };
	}>;
	label?: string;
}

/** Queue consumer: dispatches AI operations and settles their job rows. */
export async function handleQueue(
	batch: MessageBatch<AiJobMessage>,
	env: Env,
): Promise<void> {
	const db = createDb(env.DB);
	for (const message of batch.messages) {
		const msg = message.body;
		try {
			if (msg.type === "segment") {
				const [segmentImage] = msg.imageId
					? await db.select().from(images).where(eq(images.id, msg.imageId)).limit(1)
					: [];
				if (!segmentImage) throw new Error(`image ${msg.imageId} not found`);
				await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, msg.jobId));
				await runSegmentJob(env, msg.jobId, msg.userId, segmentImage);
				await finishJob(db, msg.jobId, "done");
				message.ack();
				continue;
			}
			const [image] = msg.imageId
				? await db.select().from(images).where(eq(images.id, msg.imageId)).limit(1)
				: [];
			if (!image) throw new Error(`image ${msg.imageId} not found`);

			let result: { imageId: string; versionId: string } | null = null;
			if (msg.type === "generate" && msg.prompt) {
				result = await runGenerateJob(env, msg.userId, image, msg.prompt, msg.aspect);
			} else if (msg.type === "enhance") {
				result = await runEnhanceJob(env, msg.userId, image, msg.strength ?? 0.8);
			} else if (msg.type === "inpaint" && msg.segmentId && msg.prompt) {
				result = await runInpaintJob(
					env,
					msg.userId,
					image,
					msg.segmentId,
					msg.prompt,
					msg.mode ?? "balanced",
				);
			} else if (msg.type === "inpaint" && msg.prompt) {
				// Whole-photo instruction edit (no region): FLUX edit, full frame.
				result = await runWholePhotoEdit(env, msg.userId, image, msg.prompt);
			} else if (msg.type === "batch_edit" && msg.instructions?.length) {
				result = await runBatchEditJob(
					env,
					msg.userId,
					image,
					msg.instructions,
					msg.label ?? "Edited photo",
				);
				// Mark the pinned chips applied + link the branch.
				const { editInstructions } = await import("../../database/schema");
				await db
					.update(editInstructions)
					.set({ status: "applied", resultImageId: result!.imageId })
					.where(
						and(eq(editInstructions.imageId, image.id), eq(editInstructions.status, "pending")),
					);
			} else if (msg.type === "thumb" && msg.imageId) {
				// thumbnails are derived inline at registration; nothing to do
			}

			// Link the branched photo onto the job (clients navigate via this)
			// and onto a chat message when the op came from the agent.
			if (result) {
				await db
					.update(jobs)
					.set({ resultImageId: result.imageId })
					.where(eq(jobs.id, msg.jobId));
				const chatMessageId = (msg as { chatMessageId?: string }).chatMessageId;
				if (chatMessageId) {
					await db
						.update(chatMessages)
						.set({
							resultImageId: result.imageId,
							resultVersionId: result.versionId,
						})
						.where(eq(chatMessages.id, chatMessageId));
				}
				// (auto-detection removed — regions are user-drawn now)
				console.log(
					JSON.stringify({
						event: "ai_job_completed",
						type: msg.type,
						jobId: msg.jobId,
						imageId: result.imageId,
					}),
				);
			}
			await finishJob(db, msg.jobId, "done");
			message.ack();
		} catch (error) {
			const retryable = !(error instanceof ProviderError) || error.retryable;
			const willRetry = retryable && message.attempts < MAX_ATTEMPTS;
			if (!willRetry) {
				await finishJob(
					db,
					msg.jobId,
					"error",
					error instanceof Error ? error.message : "Unknown error",
				);
				// Refund metered operations that failed permanently.
				const refund = COSTS[msg.type] ?? 0;
				if (refund > 0) {
					await refundCredits(db, msg.userId, refund, `refund:${msg.type}`, msg.jobId);
				}
				message.ack();
			} else {
				// Keep the row visible as queued while the retry backs off.
				await db.update(jobs).set({ status: "queued", progress: 0 }).where(eq(jobs.id, msg.jobId));
				message.retry({ delaySeconds: Math.min(60, 5 * 2 ** message.attempts) });
			}
		}
	}
}
