import { eq } from "drizzle-orm";

import {
	imageVersions,
	images,
	type ImageRow,
} from "../../../database/schema";
import { createDb } from "./db";
import { extForMime, mediaKeys, putObject } from "./r2";
import type { GeneratedImage } from "./providers";

/** Load the bytes for an image's current version (or its original). */
export async function loadImageBytes(
	env: Env,
	image: ImageRow,
): Promise<{ bytes: ArrayBuffer; mime: string }> {
	const db = createDb(env.DB);
	let key = image.r2KeyOriginal;
	if (image.currentVersionId) {
		const [version] = await db
			.select()
			.from(imageVersions)
			.where(eq(imageVersions.id, image.currentVersionId))
			.limit(1);
		if (version) key = version.r2KeyFull;
	}
	const obj = await env.MEDIA.get(key);
	if (!obj) throw new Error(`Media object missing: ${key}`);
	return { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType ?? image.mime };
}

/**
 * Store the result of an AI operation: an edited image keeps its row and
 * gains a version; a generated image becomes a new image row linked to its
 * source. Returns ids the caller links into chat messages / jobs.
 */
export async function storeOperationResult(
	env: Env,
	opts: {
		userId: string;
		albumId: string;
		source: ImageRow;
		operation: string;
		label: string;
		prompt?: string;
		result: GeneratedImage;
	},
): Promise<{ imageId: string; versionId: string; branched: boolean }> {
	const db = createDb(env.DB);
	// BRANCH PHOTO (plan 24): every AI output becomes its own photo. The
	// source image and its version chain are never modified.
	const imageId = crypto.randomUUID();
	const versionId = crypto.randomUUID();
	const keys = mediaKeys(opts.userId, opts.albumId, imageId);
	const ext = extForMime(opts.result.mime);
	const r2Key = keys.original(ext);
	const kind = opts.operation === "generate" ? "generated" : "edited";

	await putObject(env.MEDIA, r2Key, opts.result.data, opts.result.mime);

	await db.insert(images).values({
		id: imageId,
		albumId: opts.albumId,
		kind,
		r2KeyOriginal: r2Key,
		mime: opts.result.mime,
		widthPx: opts.result.width,
		heightPx: opts.result.height,
		sizeBytes: opts.result.data.byteLength,
		sourceImageId: opts.source.id,
		filenameLabel: shortLabel(opts.label),
		segmentStatus: "none",
	});
	await db.insert(imageVersions).values({
		id: versionId,
		imageId,
		label: opts.label,
		r2KeyFull: r2Key,
		r2KeyWeb: keys.web,
		r2KeyThumb: keys.thumb,
		prompt: opts.prompt,
		operation: opts.operation,
	});
	await db
		.update(images)
		.set({ currentVersionId: versionId })
		.where(eq(images.id, imageId));

	// Derive variants scoped to THIS version so undo/redo always serves the
	// right pixels from an immutable key (plan 18).
	const scoped = await deriveVariants(env, {
		userId: opts.userId,
		albumId: opts.albumId,
		imageId,
		r2KeyOriginal: r2Key,
		mime: opts.result.mime,
		versionId,
	});
	if (scoped) {
		await db
			.update(imageVersions)
			.set({ r2KeyWeb: scoped.web, r2KeyThumb: scoped.thumb })
			.where(eq(imageVersions.id, versionId));
	}
	return { imageId, versionId, branched: true };
}

/** Web + thumbnail variants via the Images binding; graceful fallback stores
 * the original under the variant keys so the UI always has something to show.
 * When versionId is provided, version-scoped copies are also written and
 * returned so each version serves its own immutable pixels. */
export async function deriveVariants(
	env: Env,
	opts: {
		userId: string;
		albumId: string;
		imageId: string;
		r2KeyOriginal: string;
		mime: string;
		versionId?: string;
	},
): Promise<{ web: string; thumb: string } | null> {
	const keys = mediaKeys(opts.userId, opts.albumId, opts.imageId);
	const original = await env.MEDIA.get(opts.r2KeyOriginal);
	if (!original) return null;
	const bytes = await original.arrayBuffer();

	let webBuf: ArrayBuffer | null = null;
	let thumbBuf: ArrayBuffer | null = null;
	try {
		webBuf = await transformWithImagesBytes(env, bytes, 1600);
		thumbBuf = await transformWithImagesBytes(env, bytes, 512);
	} catch {
		webBuf = null;
		thumbBuf = null;
	}

	await putObject(
		env.MEDIA,
		keys.web,
		webBuf ?? bytes,
		webBuf ? "image/webp" : opts.mime,
	);
	await putObject(
		env.MEDIA,
		keys.thumb,
		thumbBuf ?? bytes,
		thumbBuf ? "image/webp" : opts.mime,
	);

	const db = createDb(env.DB);
	await db
		.update(images)
		.set({ r2KeyWeb: keys.web, r2KeyThumb: keys.thumb })
		.where(eq(images.id, opts.imageId));

	if (!opts.versionId) return null;
	const scoped = {
		web: `${opts.userId}/a/${opts.albumId}/i/${opts.imageId}/v/${opts.versionId}/web.webp`,
		thumb: `${opts.userId}/a/${opts.albumId}/i/${opts.imageId}/v/${opts.versionId}/thumb.webp`,
	};
	await putObject(env.MEDIA, scoped.web, webBuf ?? bytes, webBuf ? "image/webp" : opts.mime);
	await putObject(env.MEDIA, scoped.thumb, thumbBuf ?? bytes, thumbBuf ? "image/webp" : opts.mime);
	return scoped;
}

/** Resize bytes via the Images binding; null when unavailable/failed. */
export async function transformWithImagesBytes(
	env: Env,
	bytes: ArrayBuffer,
	width: number,
): Promise<ArrayBuffer | null> {
	const images = env.IMAGES;
	if (typeof images?.input !== "function") return null;
	const stream = new Response(bytes).body;
	if (!stream) return null;
	const out = await images
		.input(stream)
		.transform({ width, fit: "scale-down" })
		.output({ format: "image/webp" });
	const res = await out.response();
	return await res.arrayBuffer();
}

function shortLabel(label: string): string {
	return (
		label
			.replace(/[^a-zA-Z0-9 ]/g, "")
			.slice(0, 40)
			.trim() || "Generated image"
	);
}
