import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { NonRetryableError } from "cloudflare:workflows";
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";

import {
	albums,
	images,
	jobs,
	projects,
	references,
	segmentPrompts,
	segments,
	type ImageRow,
} from "../../database/schema";
import { notifyUserEvent } from "./events";
import { MAX_MASK_PX, WORKING_MAX_PX } from "./lib/config";
import { createDb } from "./lib/db";
import { assertFidelity, similarity, toPixelBox, type OperationClass } from "./lib/fidelity";
import { finishJob } from "./lib/jobs";
import { buildAlphaMask, buildOutpaintInnerMask, encodePng } from "./lib/mask";
import { loadModelInput, loadWorkingImage, logWarn, storeOperationResult } from "./lib/operations";
import { pixelOps, type PixelBox } from "./lib/pixels";
import { decodePng } from "./lib/png";
import type { PresetTargetScope } from "../shared/presets";
import {
	closestAspect,
	editDims,
	getProvider,
	isMock,
	ProviderError,
	referenceDims,
} from "./lib/providers";
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
 * SegmentWorkflow (plan 9): durable auto-recognition with retry.
 */
export class SegmentWorkflow extends WorkflowEntrypoint<Env, { jobId: string; userId: string }> {
	override async run(
		event: { payload: { jobId: string; userId: string } },
		step: WorkflowStep,
	): Promise<{ segments: number }> {
		const { jobId, userId } = event.payload;
		let targetImageId: string | null = null;

		try {
			const target = await step.do("load-image", async () => {
				const db = createDb(this.env.DB);
				const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
				if (!job?.imageId) throw new NonRetryableError("segment job missing imageId");
				const [image] = await db.select().from(images).where(eq(images.id, job.imageId)).limit(1);
				if (!image) throw new NonRetryableError("image not found");
				await db.update(jobs).set({ status: "running", progress: 5 }).where(eq(jobs.id, jobId));
				await markSegmentStatus(this.env, image.id, "pending");
				return { imageId: image.id, albumId: image.albumId };
			});
			targetImageId = target.imageId;

			const tree = await step.do(
				"detect",
				{ retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
				async () => {
					const db = createDb(this.env.DB);
					const [image] = await db.select().from(images).where(eq(images.id, target.imageId)).limit(1);
					if (!image) throw new NonRetryableError("image not found");
					const ctx = await buildSegmentationContext(this.env, userId, image);
					const progress = async (p: number) => {
						await db.update(jobs).set({ progress: p, status: "running" }).where(eq(jobs.id, jobId));
					};
					return runDetection(ctx, progress);
				},
			);

			const outcome = await step.do(
				"caption-and-persist",
				{ retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
				async () => {
					const db = createDb(this.env.DB);
					const [image] = await db.select().from(images).where(eq(images.id, target.imageId)).limit(1);
					if (!image) throw new NonRetryableError("image not found");
					const ctx = await buildSegmentationContext(this.env, userId, image);
					const progress = async (p: number) => {
						await db.update(jobs).set({ progress: p, status: "running" }).where(eq(jobs.id, jobId));
					};
					const captioned = await runCaptioning(ctx, tree, progress);
					const count = await persistSegments(ctx, captioned.nodes);
					const status: "partial" | "ready" | "failed" =
						captioned.nodes.length === 0 && captioned.partial
							? "failed"
							: captioned.partial
								? "partial"
								: "ready";
					await markSegmentStatus(this.env, image.id, status);
					return { segments: count, status };
				},
			);

			await step.do("finish", async () => {
				await finishJob(createDb(this.env.DB), jobId, "done");
				await notifyUserEvent(this.env, userId, {
					jobId,
					jobType: "segment",
					status: "done",
					progress: 100,
					imageId: target.imageId,
					segmentStatus: outcome.status,
				});
			});
			return { segments: outcome.segments };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const db = createDb(this.env.DB);
			await finishJob(db, jobId, "error", msg);
			if (targetImageId) {
				await markSegmentStatus(this.env, targetImageId, "failed");
			}
			await notifyUserEvent(this.env, userId, {
				jobId,
				jobType: "segment",
				status: "error",
				progress: 100,
				imageId: targetImageId,
				error: msg,
				segmentStatus: "failed",
			});
			throw error;
		}
	}
}

async function buildSegmentationContext(env: Env, userId: string, image: ImageRow): Promise<SegmentationContext> {
	const { bytes, mime } = await loadModelInput(env, image);
	const dims = imageDimensions(bytes) ?? { width: image.widthPx, height: image.heightPx };
	return {
		env,
		imageId: image.id,
		userId,
		albumId: image.albumId,
		imageBytes: bytes,
		mime,
		widthPx: dims.width,
		heightPx: dims.height,
	};
}

/** Shared recognition pipeline (queue consumer + tests). */
export async function runSegmentation(
	env: Env,
	jobId: string,
	userId: string,
	image: ImageRow,
): Promise<number> {
	const db = createDb(env.DB);
	const ctx = await buildSegmentationContext(env, userId, image);
	const progress = async (p: number): Promise<void> => {
		await db.update(jobs).set({ progress: p, status: "running" }).where(eq(jobs.id, jobId));
	};
	await markSegmentStatus(env, image.id, "pending");
	const tree = await runDetection(ctx, progress);
	const captioned = await runCaptioning(ctx, tree, progress);
	const count = await persistSegments(ctx, captioned.nodes);
	const segStatus =
		captioned.nodes.length === 0 && captioned.partial
			? "failed"
			: captioned.partial
				? "partial"
				: "ready";
	await markSegmentStatus(env, image.id, segStatus);
	await notifyUserEvent(env, userId, {
		jobId,
		jobType: "segment",
		status: "done",
		progress: 100,
		imageId: image.id,
		segmentStatus: segStatus,
	});
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
	meta: {
		operation: string;
		label: string;
		prompt?: string;
		adjustmentsJson?: string | null;
		presetId?: string | null;
		presetName?: string | null;
		opClass: OperationClass;
		model: string;
		fidelity: number | null;
	},
): Promise<JobResult> {
	return storeOperationResult(env, {
		userId,
		albumId,
		source,
		operation: meta.operation,
		label: meta.label,
		prompt: meta.prompt,
		adjustmentsJson: meta.adjustmentsJson ?? null,
		presetId: meta.presetId ?? null,
		presetName: meta.presetName ?? null,
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

function toDataUri(bytes: ArrayBuffer, mime: string): string {
	const u8 = new Uint8Array(bytes);
	let bin = "";
	for (let i = 0; i < u8.length; i += 0x8000) {
		bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
	}
	const cleanMime = mime || "image/png";
	return `data:${cleanMime};base64,${btoa(bin)}`;
}

async function cropStoredMask(
	env: Env,
	ops: ReturnType<typeof pixelOps>,
	maskR2Key: string,
	crop: PixelBox,
	width: number,
	height: number,
): Promise<ArrayBuffer | null> {
	const obj = await env.MEDIA.get(maskR2Key);
	if (!obj) return null;
	const maskBytes = await obj.arrayBuffer();
	const mDims = await ops.dims(maskBytes);
	const left = Math.max(0, Math.min(mDims.width - 1, Math.floor((crop.left / width) * mDims.width)));
	const top = Math.max(0, Math.min(mDims.height - 1, Math.floor((crop.top / height) * mDims.height)));
	const mw = Math.max(1, Math.min(mDims.width - left, Math.round((crop.width / width) * mDims.width)));
	const mh = Math.max(1, Math.min(mDims.height - top, Math.round((crop.height / height) * mDims.height)));
	return (await ops.crop(maskBytes, { left, top, width: mw, height: mh })).bytes;
}

async function loadExtraReferences(
	env: Env,
	ops: ReturnType<typeof pixelOps>,
	userId: string,
	refIds: string[] | undefined,
	origin?: string,
): Promise<{ buffers: Array<{ bytes: ArrayBuffer; mime: string }>; urls: string[] }> {
	const ids = [...new Set((refIds ?? []).filter(Boolean))].slice(0, 3);
	if (!ids.length) return { buffers: [], urls: [] };
	const db = createDb(env.DB);
	const [imgRows, refRows] = await Promise.all([
		db
			.select({ img: images })
			.from(images)
			.innerJoin(albums, eq(albums.id, images.albumId))
			.innerJoin(projects, eq(projects.id, albums.projectId))
			.where(and(eq(projects.ownerId, userId), inArray(images.id, ids))),
		db
			.select({ ref: references })
			.from(references)
			.innerJoin(projects, eq(projects.id, references.projectId))
			.where(and(eq(projects.ownerId, userId), inArray(references.id, ids))),
	]);
	const byId = new Map<string, { kind: "image" | "ref"; key: string; mime: string }>();
	for (const { img } of imgRows) {
		const key = img.r2KeyOriginal || img.r2KeyWeb || img.r2KeyThumb;
		if (key) byId.set(img.id, { kind: "image", key, mime: img.mime });
	}
	for (const { ref } of refRows) {
		const key = ref.r2KeyFull ?? ref.r2KeyThumb;
		if (key) byId.set(ref.id, { kind: "ref", key, mime: ref.mime });
	}

	const buffers: Array<{ bytes: ArrayBuffer; mime: string }> = [];
	const urls: string[] = [];
	for (const id of ids) {
		const entry = byId.get(id);
		if (!entry) continue;
		const obj = await env.MEDIA.get(entry.key);
		if (!obj) continue;
		const raw = await obj.arrayBuffer();
		const d = await ops.dims(raw);
		const rDims = referenceDims(d.width, d.height);
		buffers.push(await ops.resize(raw, rDims.width, rDims.height));
		if (entry.kind === "image" && origin?.startsWith("https://")) {
			urls.push(`${origin}${await signPublicImageUrl(env, id)}?norm=1`);
		} else {
			urls.push(toDataUri(raw, entry.mime));
		}
	}
	return { buffers, urls };
}

export type LocalRegionSpec = {
	text: string;
	box: Box;
	maskR2Key?: string;
	referenceImageIds?: string[];
};

/**
 * Local edit: for each region, crop it (with context), edit the crop with the
 * reference-edit model, and composite the result back through a feathered
 * or stored RGBA mask. Pixels outside every region are the original's —
 * guaranteed by compositing, and verified by the fidelity guard.
 */
export async function runLocalEdit(
	env: Env,
	userId: string,
	source: ImageRow,
	regions: LocalRegionSpec[],
	label: string,
	meta?: {
		presetId?: string | null;
		presetName?: string | null;
		adjustmentsJson?: string | null;
	},
): Promise<JobResult> {
	const ops = pixelOps(env);
	const provider = getProvider(env);
	const working = await loadWorkingImage(env, source);
	const { width, height } = await ops.dims(working.bytes);
	let current = working.bytes;
	let currentMime = working.mime;
	let model = "";
	const changed: Box[] = [];
	const allRefIds = regions.flatMap((r) => r.referenceImageIds ?? []);
	const extra = await loadExtraReferences(env, ops, userId, allRefIds);

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
			extra.buffers,
		);
		model = edited.model;
		const feather = Math.max(4, Math.round(Math.min(inner.width, inner.height) * 0.06));
		const customMask = region.maskR2Key
			? await cropStoredMask(env, ops, region.maskR2Key, crop, width, height)
			: null;
		const mask =
			customMask ??
			(await buildAlphaMask(
				crop.width,
				crop.height,
				{ left: inner.left - crop.left, top: inner.top - crop.top, width: inner.width, height: inner.height },
				feather,
			));
		const composited = await ops.composite(current, edited.data, mask, crop);
		current = composited.bytes;
		currentMime = composited.mime;
		changed.push({
			x: Math.max(0, (inner.left - feather) / width),
			y: Math.max(0, (inner.top - feather) / height),
			w: Math.min(1, (inner.width + 2 * feather) / width),
			h: Math.min(1, (inner.height + 2 * feather) / height),
		});
	}
	const score = await assertFidelity(ops, "local", working.bytes, current, { regions: changed });
	return store(env, userId, source.albumId, source, { data: current, mime: currentMime }, {
		operation: meta?.presetId ? "preset" : "edit",
		label,
		prompt: regions.map((r) => r.text).join("; "),
		adjustmentsJson: meta?.adjustmentsJson ?? null,
		presetId: meta?.presetId ?? null,
		presetName: meta?.presetName ?? null,
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

	let effectivePrompt = prompt.trim();
	if (!effectivePrompt) {
		const [saved] = await db
			.select({ text: segmentPrompts.text })
			.from(segmentPrompts)
			.where(and(eq(segmentPrompts.segmentId, segmentId), eq(segmentPrompts.isActive, true)))
			.orderBy(desc(segmentPrompts.createdAt))
			.limit(1);
		effectivePrompt = saved?.text.trim() ?? "";
	}
	if (!effectivePrompt) throw new ProviderError("prompt is required");

	return runLocalEdit(
		env,
		userId,
		source,
		[
			{
				text: effectivePrompt,
				box: { x: segment.bboxX, y: segment.bboxY, w: segment.bboxW, h: segment.bboxH },
				maskR2Key: segment.maskR2Key ?? undefined,
			},
		],
		`Edited ${segment.label}`,
	);
}

/** Annotate-then-apply chips: each chip is a local edit of its own region. */
export async function runBatchEditJob(
	env: Env,
	userId: string,
	source: ImageRow,
	instructions: Array<{ text: string; bbox: Box; maskR2Key?: string }>,
	label: string,
): Promise<JobResult> {
	return runLocalEdit(
		env,
		userId,
		source,
		instructions.map((i) => ({ text: i.text, box: i.bbox, maskR2Key: i.maskR2Key })),
		label,
	);
}

/**
 * Reimagine / Style transfer (whole-photo edit). Primary: Pruna via signed
 * normalized URL (HTTPS) or data URI. Fallback: FLUX.2 with the photo (and up
 * to 3 attached references) as reference.
 */
export async function runWholePhotoEdit(
	env: Env,
	userId: string,
	source: ImageRow,
	prompt: string,
	origin?: string,
	referenceImageIds?: string[],
	opts?: {
		label?: string;
		opClassOverride?: "reimagine" | "style_transfer";
		preferredModel?: "primary" | "flux";
		presetId?: string | null;
		presetName?: string | null;
		adjustmentsJson?: string | null;
		skipPreservationAppend?: boolean;
	},
): Promise<JobResult> {
	const ops = pixelOps(env);
	const provider = getProvider(env);
	const working = await loadWorkingImage(env, source);
	const { width, height } = await ops.dims(working.bytes);
	const dims = editDims(width, height);
	const extra = await loadExtraReferences(env, ops, userId, referenceImageIds, origin);
	const hasRefs = extra.buffers.length > 0;
	const opClass: OperationClass = opts?.opClassOverride ?? (hasRefs ? "style_transfer" : "reimagine");
	const label = opts?.label?.trim() || prompt.slice(0, 40) || "Reimagined";
	const operation = opts?.presetId ? "preset" : "edit";

	if (provider.editWithPrimary && !isMock(env) && opts?.preferredModel !== "flux") {
		const primaryUrl = origin?.startsWith("https://")
			? `${origin}${await signPublicImageUrl(env, source.id)}?norm=1`
			: toDataUri(working.bytes, working.mime);
		const sources = [primaryUrl, ...extra.urls];
		const primaryPrompt = opts?.skipPreservationAppend
			? prompt
			: `${prompt}. Keep the rest of the photograph exactly unchanged.`;
		try {
			const editedPrimary = await provider.editWithPrimary(sources, primaryPrompt, closestAspect(width, height));
			if (editedPrimary) {
				const score = await assertFidelity(ops, opClass, working.bytes, editedPrimary.data);
				return store(env, userId, source.albumId, source, editedPrimary, {
					operation,
					label,
					prompt,
					adjustmentsJson: opts?.adjustmentsJson ?? null,
					presetId: opts?.presetId ?? null,
					presetName: opts?.presetName ?? null,
					opClass,
					model: editedPrimary.model,
					fidelity: score?.fidelity ?? null,
				});
			}
		} catch (error) {
			logWarn("pruna_edit_failed", error, { imageId: source.id });
		}
	}

	const ref = referenceDims(width, height);
	const reference = await ops.resize(working.bytes, ref.width, ref.height);
	const fluxPrompt = opts?.skipPreservationAppend
		? prompt
		: hasRefs
			? `${prompt}. Transfer style/details from the attached reference images while preserving composition.`
			: `${prompt}. Keep the people, composition, framing and lighting the same.`;
	const edited = await provider.editWithReference(reference, fluxPrompt, dims, extra.buffers);
	const score = await assertFidelity(ops, opClass, working.bytes, edited.data);
	return store(env, userId, source.albumId, source, edited, {
		operation,
		label,
		prompt,
		adjustmentsJson: opts?.adjustmentsJson ?? null,
		presetId: opts?.presetId ?? null,
		presetName: opts?.presetName ?? null,
		opClass,
		model: edited.model,
		fidelity: score?.fidelity ?? null,
	});
}

export interface RunPresetJobOpts {
	presetId: string;
	presetName: string;
	prompt: string;
	targetScope: PresetTargetScope;
	opClass: "reimagine" | "style_transfer";
	preferredModel?: "primary" | "flux";
	finishingAdjustmentsJson?: string | null;
	regionBox?: Box;
	maskR2Key?: string;
	segmentId?: string;
	referenceImageIds?: string[];
	origin?: string;
}

/**
 * Execute an AI Effect or Hybrid preset.
 * - Active selection (box / mask / segment) -> local masked composite.
 * - Background or Subject preset scope -> automatic BiRefNet subject mask so
 *   foreground subject pixels (or background pixels) stay mathematically intact.
 * - Whole photo -> fidelity-guarded Pruna/FLUX pass + optional live hybrid GPU grade.
 */
export async function runPresetJob(
	env: Env,
	userId: string,
	source: ImageRow,
	opts: RunPresetJobOpts,
): Promise<JobResult> {
	// 1. Explicit user selection (segment, mask, or box) overrides preset scope.
	if (opts.segmentId) {
		const db = createDb(env.DB);
		const [segment] = await db
			.select()
			.from(segments)
			.where(and(eq(segments.id, opts.segmentId), eq(segments.imageId, source.id), isNull(segments.deletedAt)))
			.limit(1);
		if (!segment) throw new ProviderError("segment not found");
		if (segment.lockedAt) throw new ProviderError("segment is locked");
		return runLocalEdit(
			env,
			userId,
			source,
			[
				{
					text: opts.prompt,
					box: { x: segment.bboxX, y: segment.bboxY, w: segment.bboxW, h: segment.bboxH },
					maskR2Key: segment.maskR2Key ?? undefined,
					referenceImageIds: opts.referenceImageIds,
				},
			],
			`${opts.presetName} (${segment.label})`,
			{
				presetId: opts.presetId,
				presetName: opts.presetName,
				adjustmentsJson: opts.finishingAdjustmentsJson ?? null,
			},
		);
	}

	if (opts.regionBox || opts.maskR2Key) {
		return runLocalEdit(
			env,
			userId,
			source,
			[
				{
					text: opts.prompt,
					box: opts.regionBox ?? { x: 0, y: 0, w: 1, h: 1 },
					maskR2Key: opts.maskR2Key,
					referenceImageIds: opts.referenceImageIds,
				},
			],
			opts.presetName,
			{
				presetId: opts.presetId,
				presetName: opts.presetName,
				adjustmentsJson: opts.finishingAdjustmentsJson ?? null,
			},
		);
	}

	// 2. Auto BiRefNet subject-protected scope ("background" or "subject").
	if (opts.targetScope === "background" || opts.targetScope === "subject") {
		const ops = pixelOps(env);
		const provider = getProvider(env);
		const working = await loadWorkingImage(env, source);
		const { width, height } = await ops.dims(working.bytes);

		let subjectMaskPng: ArrayBuffer | null = null;
		try {
			const cutout = await ops.removeBackground(working.bytes);
			const maskScale = Math.min(1, MAX_MASK_PX / Math.max(width, height));
			const mw = Math.max(1, Math.round(width * maskScale));
			const mh = Math.max(1, Math.round(height * maskScale));
			const smallCutout =
				mw === width && mh === height ? cutout : await ops.resize(cutout.bytes, mw, mh);
			const rgba = await decodePng(smallCutout.bytes);
			const total = rgba.width * rgba.height;
			let fgCount = 0;
			const maskData = new Uint8Array(total * 4);
			for (let i = 0; i < total; i++) {
				const a = rgba.data[i * 4 + 3] ?? 0;
				if (a > 128) fgCount++;
				maskData[i * 4] = 255;
				maskData[i * 4 + 1] = 255;
				maskData[i * 4 + 2] = 255;
				maskData[i * 4 + 3] = a;
			}
			const fgRatio = total > 0 ? fgCount / total : 0;
			if (fgRatio >= 0.02 && fgRatio <= 0.95) {
				subjectMaskPng = await encodePng(rgba.width, rgba.height, 4, maskData);
			}
		} catch (error) {
			logWarn("preset_subject_mask_failed", error, { imageId: source.id, presetId: opts.presetId });
		}

		if (subjectMaskPng) {
			const dims = editDims(width, height);
			const extra = await loadExtraReferences(env, ops, userId, opts.referenceImageIds, opts.origin);
			let editedBytes: ArrayBuffer | null = null;
			let model = "";

			if (provider.editWithPrimary && !isMock(env) && opts.preferredModel !== "flux") {
				const primaryUrl = opts.origin?.startsWith("https://")
					? `${opts.origin}${await signPublicImageUrl(env, source.id)}?norm=1`
					: toDataUri(working.bytes, working.mime);
				try {
					const primaryRes = await provider.editWithPrimary(
						[primaryUrl, ...extra.urls],
						opts.prompt,
						closestAspect(width, height),
					);
					if (primaryRes) {
						editedBytes = primaryRes.data;
						model = primaryRes.model;
					}
				} catch (error) {
					logWarn("pruna_preset_bg_failed", error, { imageId: source.id, presetId: opts.presetId });
				}
			}

			if (!editedBytes) {
				const ref = referenceDims(width, height);
				const reference = await ops.resize(working.bytes, ref.width, ref.height);
				const res = await provider.editWithReference(reference, opts.prompt, dims, extra.buffers);
				editedBytes = res.data;
				model = res.model;
			}

			// Verify model output itself is grounded in the source photo before compositing.
			await assertFidelity(ops, opts.opClass, working.bytes, editedBytes);

			const editedFull = await ops.resize(editedBytes, width, height);
			const fullBox: PixelBox = { left: 0, top: 0, width, height };
			// "background" keeps original subject pixels untouched over AI background;
			// "subject" pastes AI subject over untouched original background.
			const composed =
				opts.targetScope === "background"
					? await ops.composite(editedFull.bytes, working.bytes, subjectMaskPng, fullBox)
					: await ops.composite(working.bytes, editedFull.bytes, subjectMaskPng, fullBox);

			const [srcThumb, cmpThumb, maskThumb] = await Promise.all([
				ops.thumbnail(working.bytes, 32),
				ops.thumbnail(composed.bytes, 32),
				ops.thumbnail(subjectMaskPng, 32),
			]);
			const keepSubject = opts.targetScope === "background";
			const preserved = similarity(srcThumb, cmpThumb, (i) =>
				keepSubject ? (maskThumb.data[i * 4 + 3] ?? 0) > 128 : (maskThumb.data[i * 4 + 3] ?? 0) <= 128,
			);
			if (preserved.n > 0 && (preserved.r < 0.85 || preserved.mad > 30)) {
				throw new ProviderError(
					`fidelity_check_failed: preserved region altered during preset (${opts.targetScope}: r=${preserved.r}, mad=${preserved.mad})`,
				);
			}

			return store(env, userId, source.albumId, source, { data: composed.bytes, mime: composed.mime, width, height }, {
				operation: "preset",
				label: opts.presetName,
				prompt: opts.prompt,
				adjustmentsJson: opts.finishingAdjustmentsJson ?? null,
				presetId: opts.presetId,
				presetName: opts.presetName,
				opClass: opts.opClass,
				model: `${model}+birefnet`,
				fidelity: preserved.fidelity,
			});
		}
	}

	// 3. Whole-photo preset (or fallback when no foreground/background separation exists).
	return runWholePhotoEdit(env, userId, source, opts.prompt, opts.origin, opts.referenceImageIds, {
		label: opts.presetName,
		opClassOverride: opts.opClass,
		preferredModel: opts.preferredModel,
		presetId: opts.presetId,
		presetName: opts.presetName,
		adjustmentsJson: opts.finishingAdjustmentsJson ?? null,
		skipPreservationAppend: true,
	});
}

export type OutpaintPad = { top: number; bottom: number; left: number; right: number };

/** Generative Outpainting: expands canvas borders and keeps original inner pixels untouched. */
export async function runOutpaintJob(
	env: Env,
	userId: string,
	source: ImageRow,
	padInput: OutpaintPad,
	prompt: string,
): Promise<JobResult> {
	const top = Math.max(0, Math.round(padInput.top));
	const bottom = Math.max(0, Math.round(padInput.bottom));
	const left = Math.max(0, Math.round(padInput.left));
	const right = Math.max(0, Math.round(padInput.right));
	if (top + bottom + left + right <= 0) {
		throw new ProviderError("Outpaint padding must extend at least one edge.");
	}

	const ops = pixelOps(env);
	const working = await loadWorkingImage(env, source);
	const { width, height } = await ops.dims(working.bytes);
	const newW = width + left + right;
	const newH = height + top + bottom;
	if (newW > WORKING_MAX_PX || newH > WORKING_MAX_PX) {
		throw new ProviderError(`Outpainted dimensions (${newW}×${newH}) exceed the ${WORKING_MAX_PX}px maximum.`);
	}

	const padded = await ops.pad(working.bytes, { top, bottom, left, right, color: "#18181b" });
	const ref = referenceDims(newW, newH);
	const reference = await ops.resize(padded.bytes, ref.width, ref.height);
	const effectivePrompt = prompt.trim()
		? `${prompt.trim()}. Seamlessly extend the borders around the center photograph matching lighting, textures, and perspective.`
		: "Seamlessly extend the photograph outward into the border area, matching the existing lighting, textures, depth, and perspective.";
	const edited = await getProvider(env).editWithReference(reference, effectivePrompt, editDims(newW, newH));

	const baseExpanded = await ops.resize(edited.data, newW, newH);
	const innerBox: PixelBox = { left, top, width, height };
	const feather = Math.max(4, Math.round(Math.min(width, height) * 0.025));
	const innerMask = await buildOutpaintInnerMask(newW, newH, innerBox, feather);
	const composed = await ops.composite(baseExpanded.bytes, padded.bytes, innerMask, {
		left: 0,
		top: 0,
		width: newW,
		height: newH,
	});
	const score = await assertFidelity(ops, "outpaint", working.bytes, composed.bytes, { outpaintBox: innerBox });
	return store(env, userId, source.albumId, source, { data: composed.bytes, mime: composed.mime, width: newW, height: newH }, {
		operation: "outpaint",
		label: "Extended canvas",
		prompt: prompt.trim() || "Extend borders",
		opClass: "outpaint",
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
