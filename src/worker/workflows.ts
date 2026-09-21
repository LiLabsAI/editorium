import { eq } from "drizzle-orm";
import { NonRetryableError } from "cloudflare:workflows";
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";

import { images, jobs } from "../../database/schema";
import { createDb } from "./lib/db";
import { finishJob } from "./lib/jobs";
import { loadImageBytes, storeOperationResult } from "./lib/operations";
import { getProvider, MODE_STRENGTH, type ReferenceMode } from "./lib/providers";
import {
	markSegmentStatus,
	persistSegments,
	runCaptioning,
	runDetection,
	type SegmentationContext,
} from "./lib/segmentation";

/**
 * SegmentWorkflow (plan 9): durable auto-recognition with retry + status
 * queries via the binding. The heavy pipeline runs in one retried step and
 * reports granular progress into the jobs table as it goes.
 */
export class SegmentWorkflow extends WorkflowEntrypoint<
	Env,
	{ jobId: string; userId: string }
> {
	override async run(
		event: { payload: { jobId: string; userId: string } },
		step: WorkflowStep,
	): Promise<{ segments: number }> {
		const { jobId, userId } = event.payload;

		const target = await step.do("load-image", async () => {
			const db = createDb(this.env.DB);
			const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
			if (!job?.imageId) throw new NonRetryableError("segment job missing imageId");
			const [image] = await db.select().from(images).where(eq(images.id, job.imageId)).limit(1);
			if (!image) throw new NonRetryableError("image not found");
			await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));
			return { imageId: image.id, albumId: image.albumId };
		});

		const stored = await step.do(
			"recognize-and-persist",
			{ retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
			async () => {
				const db = createDb(this.env.DB);
				const [image] = await db
					.select()
					.from(images)
					.where(eq(images.id, target.imageId))
					.limit(1);
				if (!image) throw new NonRetryableError("image not found");
				const { bytes, mime } = await loadImageBytes(this.env, image);
				const ctx: SegmentationContext = {
					env: this.env,
					imageId: image.id,
					userId,
					albumId: target.albumId,
					imageBytes: bytes,
					mime,
					widthPx: image.widthPx,
					heightPx: image.heightPx,
				};
				await markSegmentStatus(this.env, image.id, "pending");
				const tree = await runDetection(ctx, (p) => reportProgress(this.env, jobId, p));
				const captioned = await runCaptioning(ctx, tree, (p) =>
					reportProgress(this.env, jobId, p),
				);
				const count = await persistSegments(ctx, captioned.nodes);
				await markSegmentStatus(this.env, image.id, captioned.partial ? "partial" : "ready");
				return { segments: count };
			},
		);

		await step.do("finish", async () => {
			const db = createDb(this.env.DB);
			await finishJob(db, jobId, "done");
			console.log(
				JSON.stringify({
					event: "segmentation_completed",
					jobId,
					imageId: target.imageId,
					segments: stored.segments,
				}),
			);
		});

		return stored;
	}
}

async function reportProgress(env: Env, jobId: string, progress: number): Promise<void> {
	const db = createDb(env.DB);
	await db.update(jobs).set({ progress, status: "running" }).where(eq(jobs.id, jobId));
}

/** Whole-photo instruction edit: no region, no mask — the FLUX edit model
 * applies the instruction across the frame. */
export async function runWholePhotoEdit(
	env: Env,
	userId: string,
	source: typeof images.$inferSelect,
	prompt: string,
	origin?: string,
): Promise<{ imageId: string; versionId: string }> {
	const provider = getProvider(env);
	const { bytes, mime } = await loadImageBytes(env, source);

	// Primary: Pruna P-Image-Edit (instruction-based editing that preserves
	// the input composition). Needs a publicly fetchable signed URL.
	if (origin) {
		try {
			const { signPublicImageUrl } = await import("./lib/sign");
			const imageUrl = `${origin}${await signPublicImageUrl(env, source.id, 600)}`;
			const gen = await (env.AI as { run: (m: string, input: unknown) => Promise<unknown> }).run(
				"pruna/p-image-edit",
				{
					prompt: `${prompt}. Keep the rest of the photograph exactly unchanged.`,
					images: [imageUrl],
					aspect_ratio: source.widthPx && source.heightPx
						? `${source.widthPx}:${source.heightPx}`
						: "1:1",
				},
			);
			if (gen && typeof gen === "object" && "image" in (gen as object)) {
				const b64img = (gen as { image: string }).image;
				if (b64img) {
					const bin = atob(b64img);
					const buf = new Uint8Array(bin.length);
					for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
					return storeOperationResult(env, {
						userId,
						albumId: source.albumId,
						source,
						operation: "edit",
						label: `AI edit: ${prompt.slice(0, 40)}`,
						prompt,
						result: { data: buf.buffer as ArrayBuffer, mime: "image/png", width: source.widthPx || 1024, height: source.heightPx || 1024 },
					});
				}
			}
		} catch {
			// Pruna unavailable — fall through to SDXL multipart
		}
	}

	const gen = await provider.inpaint(
		bytes,
		mime,
		null,
		{ x: 0, y: 0, w: 1, h: 1 },
		prompt,
		{ width: source.widthPx || 1024, height: source.heightPx || 1024 },
	);
	return storeOperationResult(env, {
		userId,
		albumId: source.albumId,
		source,
		operation: "edit",
		label: prompt.slice(0, 40) || "Edited photo",
		prompt,
		result: gen,
	});
}


/** Batch edit (Reve-style annotate-then-apply): every pinned instruction is
 * folded into ONE coherent FLUX edit instruction so a single generation
 * applies all changes. */
export async function runBatchEditJob(
	env: Env,
	userId: string,
	source: typeof images.$inferSelect,
	instructions: Array<{
		text: string;
		bbox: { x: number; y: number; w: number; h: number };
	}>,
	label: string,
): Promise<{ imageId: string; versionId: string }> {
	const provider = getProvider(env);
	const { bytes, mime } = await loadImageBytes(env, source);
	const combined = instructions.map((i, idx) => `${idx + 1}. ${i.text}`).join("; ");
	const gen = await provider.inpaint(
		bytes,
		mime,
		null,
		{ x: 0, y: 0, w: 1, h: 1 },
		`Apply all of these edits, in order: ${combined}. Apply each change to the ` +
			`region it refers to; keep the person, animals, background, lighting, and ` +
			`composition otherwise exactly unchanged.`,
		{ width: source.widthPx || 1024, height: source.heightPx || 1024 },
	);
	return storeOperationResult(env, {
		userId,
		albumId: source.albumId,
		source,
		operation: "edit",
		label,
		prompt: combined,
		result: gen,
	});
}

/** Queue-consumer operation runners (generate / enhance / inpaint). */
export async function runGenerateJob(
	env: Env,
	userId: string,
	source: typeof images.$inferSelect,
	prompt: string,
	aspect?: string,
): Promise<{ imageId: string; versionId: string }> {
	const provider = getProvider(env);
	const gen = await provider.textToImage(prompt, { aspect });
	return storeOperationResult(env, {
		userId,
		albumId: source.albumId,
		source,
		operation: "generate",
		label: prompt.slice(0, 48) || "Generated image",
		prompt,
		result: gen,
	});
}

export async function runEnhanceJob(
	env: Env,
	userId: string,
	source: typeof images.$inferSelect,
	strength: number,
): Promise<{ imageId: string; versionId: string }> {
	const provider = getProvider(env);
	const { bytes, mime } = await loadImageBytes(env, source);
	const factor = strength >= 0.8 ? 4 : 2;
	const gen = await provider.upscale(bytes, mime, factor);
	return storeOperationResult(env, {
		userId,
		albumId: source.albumId,
		source,
		operation: "enhance",
		label: `High-quality ${factor}K enhance`,
		result: gen,
	});
}

export async function runInpaintJob(
	env: Env,
	userId: string,
	source: typeof images.$inferSelect,
	segmentId: string,
	prompt: string,
	mode: ReferenceMode,
): Promise<{ imageId: string; versionId: string }> {
	const db = createDb(env.DB);
	const { segments } = await import("../../database/schema");
	const [segment] = await db.select().from(segments).where(eq(segments.id, segmentId)).limit(1);
	if (!segment) throw new NonRetryableError("segment not found");
	const provider = getProvider(env);
	const { bytes, mime } = await loadImageBytes(env, source);
	const dims = { width: source.widthPx || 1024, height: source.heightPx || 1024 };

	// Creative mode: FLUX.2 instruction edit — best-in-class prompt following,
	// whole-image coherence. Literal/Balanced: mask-constrained SD inpainting.
	if (mode === "creative") {
		const edited = await provider.inpaint(
			bytes,
			mime,
			null,
			{ x: segment.bboxX, y: segment.bboxY, w: segment.bboxW, h: segment.bboxH },
			`${prompt}. Keep everything else in the photograph unchanged.`,
			dims,
		);
		void MODE_STRENGTH;
		return storeOperationResult(env, {
			userId,
			albumId: source.albumId,
			source,
			operation: "edit",
			label: `AI edit ${segment.label}`,
			prompt,
			result: edited,
		});
	}

	let mask: ArrayBuffer | null = null;
	if (segment.maskR2Key) {
		const obj = await env.MEDIA.get(segment.maskR2Key);
		if (obj) mask = await obj.arrayBuffer();
	}
	if (!mask) {
		// Synthesize a feathered box mask once and persist it for reuse.
		const { buildBoxMask } = await import("./lib/mask");
		mask = await buildBoxMask(
			{ x: segment.bboxX, y: segment.bboxY, w: segment.bboxW, h: segment.bboxH },
			dims.width,
			dims.height,
		);
		const { mediaKeys, putObject } = await import("./lib/r2");
		const keys = mediaKeys(userId, source.albumId, source.id);
		await putObject(env.MEDIA, keys.segmentMask(segment.id), mask, "image/png");
		await db
			.update(segments)
			.set({ maskR2Key: keys.segmentMask(segment.id) })
			.where(eq(segments.id, segment.id));
	}
	const gen = await provider.inpaint(
		bytes,
		mime,
		mask,
		{ x: segment.bboxX, y: segment.bboxY, w: segment.bboxW, h: segment.bboxH },
		prompt,
		dims,
	);
	return storeOperationResult(env, {
		userId,
		albumId: source.albumId,
		source,
		operation: "edit",
		label: `Edited ${segment.label}`,
		prompt,
		result: gen,
	});
}
