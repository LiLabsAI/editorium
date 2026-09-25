import { and, eq, isNull } from "drizzle-orm";
import { NonRetryableError } from "cloudflare:workflows";
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";

import { images, jobs, segments, type ImageRow } from "../../database/schema";
import { createDb } from "./lib/db";
import { assertFidelity, toPixelBox, type OperationClass } from "./lib/fidelity";
import { finishJob } from "./lib/jobs";
import { buildAlphaMask } from "./lib/mask";
import { loadModelInput, loadWorkingImage, logWarn, storeOperationResult } from "./lib/operations";
import { pixelOps, type PixelBox } from "./lib/pixels";
import {
	closestAspect,
	editDims,
	getProvider,
	isMock,
	ProviderError,
	referenceDims,
} from "./lib/providers";
import { decodeImageOutput } from "./lib/providers/workersai";
import { imageDimensions } from "./lib/r2";
import {
	markSegmentStatus,
	persistSegments,
	runCaptioning,
	runDetection,
	type SegmentationContext,
} from "./lib/segmentation";
import { signPublicImageUrl } from "./lib/sign";

/**
 * SegmentWorkflow (plan 9): durable auto-recognition with retry. The queue
 * consumer is the executor in use today (queue.ts); this class stays exported
 * because the `editorium-segment` Workflow binding is deployed.
 */
export class SegmentWorkflow extends WorkflowEntrypoint<Env, { jobId: string; userId: string }> {
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
				const [image] = await db.select().from(images).where(eq(images.id, target.imageId)).limit(1);
				if (!image) throw new NonRetryableError("image not found");
				return { segments: await runSegmentation(this.env, jobId, userId, image) };
			},
		);

		await step.do("finish", async () => {
			await finishJob(createDb(this.env.DB), jobId, "done");
		});
		return stored;
	}
}

/** Shared recognition pipeline (queue consumer + workflow). */
export async function runSegmentation(
	env: Env,
	jobId: string,
	userId: string,
	image: ImageRow,
): Promise<number> {
	const db = createDb(env.DB);
	const { bytes, mime } = await loadModelInput(env, image);
	// Crops are computed on the model-input pixels, not the stored original.
	const dims = imageDimensions(bytes) ?? { width: image.widthPx, height: image.heightPx };
	const ctx: SegmentationContext = {
		env,
		imageId: image.id,
		userId,
		albumId: image.albumId,
		imageBytes: bytes,
		mime,
		widthPx: dims.width,
		heightPx: dims.height,
	};
	const progress = async (p: number): Promise<void> => {
		await db.update(jobs).set({ progress: p, status: "running" }).where(eq(jobs.id, jobId));
	};
	await markSegmentStatus(env, image.id, "pending");
	const tree = await runDetection(ctx, progress);
	const captioned = await runCaptioning(ctx, tree, progress);
	const count = await persistSegments(ctx, captioned.nodes);
	await markSegmentStatus(env, image.id, captioned.partial ? "partial" : "ready");
	console.log(JSON.stringify({ event: "segmentation_completed", jobId, imageId: image.id, segments: count }));
	return count;
}

export type JobResult = { imageId: string; versionId: string };

type Box = { x: number; y: number; w: number; h: number };

/*
 * Phase 4 runners. Each operation class uses a tool that cannot break its
 * contract, and every result passes the fidelity guard before it is stored
 * (plans/phase4/index.md):
 *   enhance   → Images ESRGAN + sharpen            (same content)
 *   segment   → Images BiRefNet background removal  (subject pixels kept)
 *   local     → FLUX.2 on a padded crop + composite (outside region untouched)
 *   reimagine → Pruna / FLUX.2 with the photo       (guarded against ignoring it)
 *   generate  → text-to-image                       (new photo)
 */

async function store(
	env: Env,
	userId: string,
	albumId: string,
	source: ImageRow | null,
	result: { data: ArrayBuffer; mime: string; width?: number; height?: number },
	meta: { operation: string; label: string; prompt?: string; opClass: OperationClass; model: string; fidelity: number | null },
): Promise<JobResult> {
	return storeOperationResult(env, {
		userId,
		albumId,
		source,
		operation: meta.operation,
		label: meta.label,
		prompt: meta.prompt,
		result: { data: result.data, mime: result.mime, width: result.width ?? 0, height: result.height ?? 0 },
		audit: { opClass: meta.opClass, model: meta.model, fidelity: meta.fidelity },
	});
}

/** "Enhance (AI)": ESRGAN upscale + sharpen via the Images binding. A
 * restoration model adds detail; it cannot invent a different subject. */
export async function runEnhanceJob(env: Env, userId: string, source: ImageRow): Promise<JobResult> {
	const ops = pixelOps(env);
	const working = await loadWorkingImage(env, source);
	const out = await ops.enhance(working.bytes);
	const score = await assertFidelity(ops, "enhance", working.bytes, out.bytes);
	return store(env, userId, source.albumId, source, { data: out.bytes, mime: out.mime }, {
		operation: "enhance",
		label: "Enhanced",
		opClass: "enhance",
		model: out.model,
		fidelity: score?.fidelity ?? null,
	});
}

/** "Remove background": BiRefNet segmentation — subject pixels are kept
 * exactly, the background becomes transparent. Nothing is repainted. */
export async function runRemoveBackgroundJob(env: Env, userId: string, source: ImageRow): Promise<JobResult> {
	const ops = pixelOps(env);
	const working = await loadWorkingImage(env, source);
	const out = await ops.removeBackground(working.bytes);
	const score = await assertFidelity(ops, "segment", working.bytes, out.bytes);
	return store(env, userId, source.albumId, source, { data: out.bytes, mime: out.mime }, {
		operation: "remove_bg",
		label: "Background removed",
		opClass: "segment",
		model: isMock(env) ? "mock:segment" : "images:segment-foreground",
		fidelity: score?.fidelity ?? null,
	});
}

/** Crop around a region with context so the edit model sees surroundings. */
function paddedCrop(inner: PixelBox, width: number, height: number): PixelBox {
	const pad = Math.round(Math.max(inner.width, inner.height) * 0.35);
	const minSide = Math.min(256, width, height);
	let left = Math.max(0, inner.left - pad);
	let top = Math.max(0, inner.top - pad);
	let right = Math.min(width, inner.left + inner.width + pad);
	let bottom = Math.min(height, inner.top + inner.height + pad);
	if (right - left < minSide) {
		left = Math.max(0, Math.min(left, width - minSide));
		right = Math.min(width, left + minSide);
	}
	if (bottom - top < minSide) {
		top = Math.max(0, Math.min(top, height - minSide));
		bottom = Math.min(height, top + minSide);
	}
	return { left, top, width: right - left, height: bottom - top };
}

/**
 * Local edit: for each region, crop it (with context), edit the crop with the
 * reference-edit model, and composite the result back through a feathered
 * mask. Pixels outside every region are the original's — guaranteed by the
 * compositing, and verified by the fidelity guard.
 */
export async function runLocalEdit(
	env: Env,
	userId: string,
	source: ImageRow,
	regions: Array<{ text: string; box: Box }>,
	label: string,
): Promise<JobResult> {
	const ops = pixelOps(env);
	const provider = getProvider(env);
	const working = await loadWorkingImage(env, source);
	const { width, height } = await ops.dims(working.bytes);
	let current = working.bytes;
	let model = "";
	const changed: Box[] = [];
	for (const region of regions) {
		const inner = toPixelBox(region.box, width, height);
		const crop = paddedCrop(inner, width, height);
		const cropped = await ops.crop(current, crop);
		const ref = referenceDims(crop.width, crop.height);
		const reference = await ops.resize(cropped.bytes, ref.width, ref.height);
		const edited = await provider.editWithReference(
			reference,
			`${region.text}. Keep the composition, framing, lighting and every other detail of this image exactly the same.`,
			editDims(crop.width, crop.height),
		);
		model = edited.model;
		const feather = Math.max(4, Math.round(Math.min(inner.width, inner.height) * 0.06));
		const mask = await buildAlphaMask(
			crop.width,
			crop.height,
			{ left: inner.left - crop.left, top: inner.top - crop.top, width: inner.width, height: inner.height },
			feather,
		);
		current = (await ops.composite(current, edited.data, mask, crop)).bytes;
		changed.push({
			x: Math.max(0, (inner.left - feather) / width),
			y: Math.max(0, (inner.top - feather) / height),
			w: Math.min(1, (inner.width + 2 * feather) / width),
			h: Math.min(1, (inner.height + 2 * feather) / height),
		});
	}
	const score = await assertFidelity(ops, "local", working.bytes, current, { regions: changed });
	return store(env, userId, source.albumId, source, { data: current, mime: isMock(env) ? "image/png" : "image/jpeg" }, {
		operation: "edit",
		label,
		prompt: regions.map((r) => r.text).join("; "),
		opClass: "local",
		model,
		fidelity: score?.fidelity ?? null,
	});
}

/** Region edit on a stored segment (selected layer). */
export async function runInpaintJob(
	env: Env,
	userId: string,
	source: ImageRow,
	segmentId: string,
	prompt: string,
): Promise<JobResult> {
	const db = createDb(env.DB);
	const [segment] = await db
		.select()
		.from(segments)
		.where(and(eq(segments.id, segmentId), eq(segments.imageId, source.id), isNull(segments.deletedAt)))
		.limit(1);
	if (!segment) throw new ProviderError("segment not found");
	if (segment.lockedAt) throw new ProviderError("segment is locked");
	return runLocalEdit(
		env,
		userId,
		source,
		[{ text: prompt, box: { x: segment.bboxX, y: segment.bboxY, w: segment.bboxW, h: segment.bboxH } }],
		`Edited ${segment.label}`,
	);
}

/** Annotate-then-apply chips: each chip is a local edit of its own region. */
export async function runBatchEditJob(
	env: Env,
	userId: string,
	source: ImageRow,
	instructions: Array<{ text: string; bbox: Box }>,
	label: string,
): Promise<JobResult> {
	return runLocalEdit(
		env,
		userId,
		source,
		instructions.map((i) => ({ text: i.text, box: i.bbox })),
		label,
	);
}

/**
 * Reimagine (free-text whole-photo edit). Primary: Pruna P-Image-Edit via a
 * signed URL. Fallback: FLUX.2 with the photo as its reference. Either way
 * the guard rejects a result unrelated to the photo.
 */
export async function runWholePhotoEdit(
	env: Env,
	userId: string,
	source: ImageRow,
	prompt: string,
	origin?: string,
): Promise<JobResult> {
	const ops = pixelOps(env);
	const working = await loadWorkingImage(env, source);
	const { width, height } = await ops.dims(working.bytes);
	const dims = editDims(width, height);

	if (origin && env.MODEL_EDIT_PRIMARY && !isMock(env)) {
		// Only the model call is guarded: storage failures must surface.
		let decoded: { data: ArrayBuffer; mime: string } | null = null;
		try {
			const imageUrl = `${origin}${await signPublicImageUrl(env, source.id)}`;
			const out = await (env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> }).run(
				env.MODEL_EDIT_PRIMARY,
				{
					prompt: `${prompt}. Keep the rest of the photograph exactly unchanged.`,
					images: [imageUrl],
					aspect_ratio: closestAspect(width, height),
				},
			);
			decoded = await decodeImageOutput(out);
			if (!decoded) logWarn("pruna_edit_empty_output", "no image in response", { imageId: source.id });
		} catch (error) {
			logWarn("pruna_edit_failed", error, { imageId: source.id });
		}
		if (decoded) {
			const score = await assertFidelity(ops, "reimagine", working.bytes, decoded.data);
			return store(env, userId, source.albumId, source, decoded, {
				operation: "edit",
				label: prompt.slice(0, 40) || "Reimagined",
				prompt,
				opClass: "reimagine",
				model: env.MODEL_EDIT_PRIMARY,
				fidelity: score?.fidelity ?? null,
			});
		}
	}

	const ref = referenceDims(width, height);
	const reference = await ops.resize(working.bytes, ref.width, ref.height);
	const edited = await getProvider(env).editWithReference(
		reference,
		`${prompt}. Keep the people, composition, framing and lighting the same.`,
		dims,
	);
	const score = await assertFidelity(ops, "reimagine", working.bytes, edited.data);
	return store(env, userId, source.albumId, source, edited, {
		operation: "edit",
		label: prompt.slice(0, 40) || "Reimagined",
		prompt,
		opClass: "reimagine",
		model: edited.model,
		fidelity: score?.fidelity ?? null,
	});
}

/** Text-to-image into an album; `source` is optional. */
export async function runGenerateJob(
	env: Env,
	userId: string,
	albumId: string,
	prompt: string,
	aspect: string | undefined,
	source: ImageRow | null,
): Promise<JobResult> {
	const gen = await getProvider(env).textToImage(prompt, { aspect });
	return store(env, userId, albumId, source, gen, {
		operation: "generate",
		label: prompt.slice(0, 48) || "Generated image",
		prompt,
		opClass: "generate",
		model: isMock(env) ? "mock:t2i" : env.MODEL_T2I,
		fidelity: null,
	});
}
