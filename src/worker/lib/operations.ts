import { eq } from "drizzle-orm";

import { imageVersions, images, type ImageRow } from "../../../database/schema";
import {
	MODEL_EDIT_MAX_PX,
	THUMB_VARIANT_PX,
	WEB_VARIANT_PX,
} from "./config";
import { createDb } from "./db";
import {
	deletePrefix,
	extForMime,
	imageDimensions,
	legacyAlbumPrefix,
	mediaKeys,
	putObject,
	sniffMime,
} from "./r2";
import { pixelOps, type Encoded } from "./pixels";
import { ProviderError, type GeneratedImage } from "./providers/types";

type Dims = { width: number; height: number };

/** R2 key of the image's current version (or its original). */
export async function currentKey(env: Env, image: ImageRow): Promise<string> {
	if (!image.currentVersionId) return image.r2KeyOriginal;
	const db = createDb(env.DB);
	const [version] = await db
		.select({ key: imageVersions.r2KeyFull })
		.from(imageVersions)
		.where(eq(imageVersions.id, image.currentVersionId))
		.limit(1);
	return version?.key ?? image.r2KeyOriginal;
}

/** Load the bytes for an image's current version (or its original). */
export async function loadImageBytes(
	env: Env,
	image: ImageRow,
): Promise<{ bytes: ArrayBuffer; mime: string }> {
	const key = await currentKey(env, image);
	const obj = await env.MEDIA.get(key);
	if (!obj) throw new ProviderError(`Media object missing: ${key}`);
	return { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType ?? image.mime };
}

/** The Images binding accepts inputs up to 20 MB. */
const IMAGES_INPUT_MAX_BYTES = 20 * 1024 * 1024;
/** Longest side of the working copy that pixel operations run on. */
export const WORKING_MAX_PX = 4096;

/** Current-version bytes the pixel pipeline can accept: the full original,
 * or the (≤1600px) web variant when the original exceeds the Images limit. */
async function loadPixelSource(env: Env, image: ImageRow): Promise<ArrayBuffer> {
	const full = await loadImageBytes(env, image);
	if (full.bytes.byteLength <= IMAGES_INPUT_MAX_BYTES) return full.bytes;
	const db = createDb(env.DB);
	const [version] = image.currentVersionId
		? await db.select().from(imageVersions).where(eq(imageVersions.id, image.currentVersionId)).limit(1)
		: [];
	const webKey = version?.r2KeyWeb ?? image.r2KeyWeb;
	const web = webKey ? await env.MEDIA.get(webKey) : null;
	if (!web) throw new ProviderError("Image too large to process");
	return web.arrayBuffer();
}

/**
 * The working copy for pixel operations: EXIF rotation applied (so region
 * coordinates match what the user saw), longest side ≤ `maxSide`.
 */
export async function loadWorkingImage(
	env: Env,
	image: ImageRow,
	maxSide = WORKING_MAX_PX,
): Promise<Encoded> {
	return pixelOps(env).normalize(await loadPixelSource(env, image), maxSide);
}

/** Bytes to send to an AI vision model: the working copy at model size. */
export async function loadModelInput(env: Env, image: ImageRow): Promise<{ bytes: ArrayBuffer; mime: string }> {
	return loadWorkingImage(env, image, MODEL_EDIT_MAX_PX);
}

/** Resize via the Images binding (EXIF rotation is applied); null if unavailable. */
export async function transformBytes(
	env: Env,
	bytes: ArrayBuffer,
	maxSide: number,
	format: "image/webp" | "image/jpeg" = "image/webp",
): Promise<ArrayBuffer | null> {
	if (typeof env.IMAGES?.input !== "function") return null;
	const stream = new Response(bytes).body;
	if (!stream) return null;
	// Explicit, aspect-preserving target size: never upscale, and don't rely
	// on `fit` alone (the local low-fidelity Images emulator ignores it and
	// would squash to maxSide x maxSide).
	const dims = imageDimensions(bytes);
	let handle = env.IMAGES.input(stream);
	if (dims) {
		const scale = Math.min(1, maxSide / Math.max(dims.width, dims.height));
		if (scale < 1) {
			handle = handle.transform({
				width: Math.max(1, Math.round(dims.width * scale)),
				height: Math.max(1, Math.round(dims.height * scale)),
				fit: "scale-down",
			});
		}
	} else {
		handle = handle.transform({ width: maxSide, height: maxSide, fit: "scale-down" });
	}
	const out = await handle.output({ format });
	return await out.response().arrayBuffer();
}

/** Header parse first, Images-binding `info()` (free) as the fallback. */
export async function probeDimensions(env: Env, bytes: ArrayBuffer): Promise<Dims | null> {
	const parsed = imageDimensions(bytes);
	if (parsed) return parsed;
	try {
		const stream = new Response(bytes).body;
		if (!stream || typeof env.IMAGES?.info !== "function") return null;
		const info = await env.IMAGES.info(stream);
		if ("width" in info && info.width > 0 && info.height > 0) {
			return { width: info.width, height: info.height };
		}
	} catch (error) {
		logWarn("image_info_failed", error);
	}
	return null;
}

/**
 * Stored dimensions must match what browsers display. The Images binding
 * applies EXIF rotation, so if the web variant's orientation disagrees with
 * the raw header (a rotated phone JPEG) the header dims are swapped.
 */
function orient(raw: Dims | null, web: Dims | null): Dims | null {
	if (!raw) return web;
	if (!web) return raw;
	const rawLandscape = raw.width >= raw.height;
	const webLandscape = web.width >= web.height;
	return rawLandscape === webLandscape ? raw : { width: raw.height, height: raw.width };
}

/**
 * Write web + thumb derivatives for a version (image-level keys for the
 * album grid, version-scoped keys for immutable per-version serving). On
 * transform failure the source bytes are stored instead so the UI still
 * has something to show.
 */
export async function deriveVariants(
	env: Env,
	opts: { userId: string; albumId: string; imageId: string; versionId: string; bytes: ArrayBuffer; mime: string },
): Promise<{ web: string; thumb: string; webDims: Dims | null }> {
	const keys = mediaKeys(opts.userId, opts.albumId, opts.imageId);
	let webBuf: ArrayBuffer | null = null;
	let thumbBuf: ArrayBuffer | null = null;
	try {
		webBuf = await transformBytes(env, opts.bytes, WEB_VARIANT_PX);
		thumbBuf = await transformBytes(env, opts.bytes, THUMB_VARIANT_PX);
	} catch (error) {
		logWarn("variant_transform_failed", error, { imageId: opts.imageId });
		webBuf = null;
		thumbBuf = null;
	}
	const webType = webBuf ? "image/webp" : opts.mime;
	const thumbType = thumbBuf ? "image/webp" : opts.mime;
	const scoped = { web: keys.versionWeb(opts.versionId), thumb: keys.versionThumb(opts.versionId) };
	await Promise.all([
		putObject(env.MEDIA, keys.web, webBuf ?? opts.bytes, webType),
		putObject(env.MEDIA, keys.thumb, thumbBuf ?? opts.bytes, thumbType),
		putObject(env.MEDIA, scoped.web, webBuf ?? opts.bytes, webType),
		putObject(env.MEDIA, scoped.thumb, thumbBuf ?? opts.bytes, thumbType),
	]);
	return { ...scoped, webDims: webBuf ? imageDimensions(webBuf) : null };
}

export interface NewImage {
	userId: string;
	albumId: string;
	bytes: ArrayBuffer;
	kind: "upload" | "generated" | "edited";
	label: string;
	filenameLabel?: string;
	sourceImageId?: string | null;
	/** Photo family (phase 5); defaults to the new image itself (a root). */
	rootImageId?: string | null;
	operation: string;
	prompt?: string;
	/** Dimensions reported by a model; only used if the bytes can't be probed. */
	fallbackDims?: Dims;
	audit?: VersionAudit;
}

/** Phase 4: how a version was produced and how faithful it is to its source. */
export interface VersionAudit {
	opClass: string;
	model?: string;
	/** Fidelity guard correlation (null when the class is not guarded). */
	fidelity?: number | null;
}

/**
 * The single path that turns bytes into an image: sniff the real format,
 * store the original, derive variants, measure true dimensions, then write
 * the image + version rows atomically. Used by upload, filter presets and
 * every AI result.
 */
export async function createImageFromBytes(
	env: Env,
	opts: NewImage,
): Promise<{ image: ImageRow; imageId: string; versionId: string }> {
	const mime = sniffMime(opts.bytes);
	if (!mime) throw new ProviderError("Result is not a supported raster image");
	const imageId = crypto.randomUUID();
	const versionId = crypto.randomUUID();
	const keys = mediaKeys(opts.userId, opts.albumId, imageId);
	const r2Key = keys.original(extForMime(mime));
	await putObject(env.MEDIA, r2Key, opts.bytes, mime);
	const variants = await deriveVariants(env, {
		userId: opts.userId,
		albumId: opts.albumId,
		imageId,
		versionId,
		bytes: opts.bytes,
		mime,
	});
	const dims =
		orient(await probeDimensions(env, opts.bytes), variants.webDims) ??
		opts.fallbackDims ?? { width: 0, height: 0 };

	const db = createDb(env.DB);
	const [inserted] = await db.batch([
		db
			.insert(images)
			.values({
				id: imageId,
				albumId: opts.albumId,
				kind: opts.kind,
				r2KeyOriginal: r2Key,
				r2KeyWeb: keys.web,
				r2KeyThumb: keys.thumb,
				mime,
				widthPx: dims.width,
				heightPx: dims.height,
				sizeBytes: opts.bytes.byteLength,
				sourceImageId: opts.sourceImageId ?? null,
				rootImageId: opts.rootImageId ?? imageId,
				currentVersionId: versionId,
				filenameLabel: (opts.filenameLabel ?? shortLabel(opts.label)).slice(0, 80),
				segmentStatus: "none",
			})
			.returning(),
		db.insert(imageVersions).values({
			id: versionId,
			imageId,
			label: opts.label.slice(0, 120),
			r2KeyFull: r2Key,
			r2KeyWeb: variants.web,
			r2KeyThumb: variants.thumb,
			prompt: opts.prompt,
			operation: opts.operation,
			opClass: opts.audit?.opClass,
			model: opts.audit?.model,
			fidelity: opts.audit?.fidelity ?? null,
		}),
	]);
	return { image: inserted[0]!, imageId, versionId };
}

/**
 * Store an AI operation result as a NEW photo (branch model, plan 24): the
 * source image and its version chain are never modified.
 */
export async function storeOperationResult(
	env: Env,
	opts: {
		userId: string;
		albumId: string;
		source: ImageRow | null;
		operation: string;
		label: string;
		prompt?: string;
		result: GeneratedImage;
		audit: VersionAudit;
	},
): Promise<{ imageId: string; versionId: string }> {
	const { imageId, versionId } = await createImageFromBytes(env, {
		userId: opts.userId,
		albumId: opts.albumId,
		bytes: opts.result.data,
		kind: opts.operation === "generate" ? "generated" : "edited",
		label: opts.label,
		sourceImageId: opts.source?.id ?? null,
		rootImageId: opts.source ? (opts.source.rootImageId ?? opts.source.id) : null,
		operation: opts.operation,
		prompt: opts.prompt,
		fallbackDims: { width: opts.result.width, height: opts.result.height },
		audit: opts.audit,
	});
	return { imageId, versionId };
}

/** Remove every R2 object for one image (current + legacy key layouts). */
export async function deleteImageMedia(
	env: Env,
	userId: string,
	albumId: string,
	imageId: string,
): Promise<void> {
	await deletePrefix(env.MEDIA, mediaKeys(userId, albumId, imageId).prefix);
	await deletePrefix(env.MEDIA, `${legacyAlbumPrefix(userId, albumId)}i/${imageId}/`);
}

function shortLabel(label: string): string {
	return (
		label
			.replace(/[^a-zA-Z0-9 ]/g, "")
			.slice(0, 40)
			.trim() || "Generated image"
	);
}

export function logWarn(message: string, error: unknown, extra: Record<string, unknown> = {}): void {
	console.warn(
		JSON.stringify({
			message,
			error: error instanceof Error ? error.message : String(error),
			...extra,
		}),
	);
}
