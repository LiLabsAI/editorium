/** R2 key layout + media helpers shared by API routes and job pipelines. */

export function albumPrefix(userId: string, albumId: string): string {
	return `u/${userId}/a/${albumId}/`;
}

export function mediaKeys(userId: string, albumId: string, imageId: string) {
	const base = `u/${userId}/a/${albumId}/i/${imageId}`;
	return {
		prefix: `${base}/`,
		original: (ext: string) => `${base}/original.${ext}`,
		web: `${base}/web.webp`,
		thumb: `${base}/thumb.webp`,
		version: (versionId: string, ext: string) => `${base}/v/${versionId}/full.${ext}`,
		versionWeb: (versionId: string) => `${base}/v/${versionId}/web.webp`,
		versionThumb: (versionId: string) => `${base}/v/${versionId}/thumb.webp`,
		segmentMask: (segmentId: string) => `${base}/seg/${segmentId}/mask.png`,
		segmentCrop: (segmentId: string) => `${base}/seg/${segmentId}/crop.png`,
	};
}

/** Before the fix, version-scoped variants were written without the `u/`
 * prefix; cleanup must sweep that legacy location too. */
export function legacyAlbumPrefix(userId: string, albumId: string): string {
	return `${userId}/a/${albumId}/`;
}

/** Intrinsic dimensions from PNG / JPEG / WebP / GIF headers (null if unknown).
 * Pixel-storage dimensions only — EXIF rotation is reconciled separately
 * against the Images-binding web variant (lib/operations.ts). */
export function imageDimensions(bytes: ArrayBuffer): { width: number; height: number } | null {
	const view = new DataView(bytes);
	const len = view.byteLength;
	const ascii = (start: number, text: string) =>
		start + text.length <= len &&
		Array.from(text).every((ch, i) => view.getUint8(start + i) === ch.charCodeAt(0));

	// PNG: signature + IHDR (width/height at 16/20)
	if (len >= 24 && view.getUint32(0) === 0x89504e47 && ascii(12, "IHDR")) {
		return positive(view.getUint32(16), view.getUint32(20));
	}
	// GIF: logical screen size, little-endian at 6/8
	if (len >= 10 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) {
		return positive(view.getUint16(6, true), view.getUint16(8, true));
	}
	// WebP: RIFF....WEBP + VP8 / VP8L / VP8X chunk
	if (len >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
		if (ascii(12, "VP8 ")) {
			return positive(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
		}
		if (ascii(12, "VP8L")) {
			const b = [21, 22, 23, 24].map((i) => view.getUint8(i)) as [number, number, number, number];
			return positive(1 + (((b[1] & 0x3f) << 8) | b[0]), 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)));
		}
		if (ascii(12, "VP8X")) {
			const w = 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16));
			const h = 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16));
			return positive(w, h);
		}
		return null;
	}
	// JPEG: walk segments to any SOFn (C0–CF except DHT C4, JPG C8, DAC CC)
	if (len >= 4 && view.getUint16(0) === 0xffd8) {
		let offset = 2;
		while (offset + 4 <= len) {
			if (view.getUint8(offset) !== 0xff) return null;
			const marker = view.getUint8(offset + 1);
			if (marker === 0xff) {
				offset += 1; // fill byte
				continue;
			}
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				offset += 2; // standalone markers carry no length
				continue;
			}
			if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan
			const segLen = view.getUint16(offset + 2);
			const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
			if (isSof && offset + 9 <= len) {
				return positive(view.getUint16(offset + 7), view.getUint16(offset + 5));
			}
			if (segLen < 2) return null;
			offset += 2 + segLen;
		}
	}
	return null;
}

function positive(width: number, height: number): { width: number; height: number } | null {
	return width > 0 && height > 0 ? { width, height } : null;
}

export function extForMime(mime: string): string {
	if (mime === "image/png") return "png";
	if (mime === "image/webp") return "webp";
	if (mime === "image/gif") return "gif";
	return "jpg";
}

/** Raster formats only. SVG is deliberately NOT accepted: it is a script-
 * capable document and would be served from the app's own origin. */
const RASTER = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function isRasterMime(mime: string | undefined): boolean {
	return !!mime && RASTER.has(mime);
}

/** Identify a raster image by magic bytes; the client-declared type is never
 * trusted. Returns null for anything else (including SVG and tiny files). */
export function sniffMime(bytes: ArrayBuffer): string | null {
	const view = new DataView(bytes);
	const len = view.byteLength;
	const ascii = (start: number, text: string) =>
		start + text.length <= len &&
		Array.from(text).every((ch, i) => view.getUint8(start + i) === ch.charCodeAt(0));
	if (len >= 8 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) return "image/png";
	if (len >= 3 && view.getUint16(0) === 0xffd8 && view.getUint8(2) === 0xff) return "image/jpeg";
	if (len >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
	if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
	return null;
}

/** User media is immutable per key. */
export const MEDIA_CACHE = "private, max-age=31536000, immutable";

export async function putObject(
	bucket: R2Bucket,
	key: string,
	body: ArrayBuffer | ReadableStream | string,
	contentType: string,
): Promise<void> {
	await bucket.put(key, body, {
		httpMetadata: { contentType, cacheControl: MEDIA_CACHE },
	});
}

/**
 * Serve an R2 object with hardening headers. Anything that is not a known
 * raster image (legacy SVG, octet-stream fallbacks) is forced to download
 * and sandboxed, so stored content can never execute in the app's origin.
 */
export async function getObject(
	bucket: R2Bucket,
	key: string,
	opts: { cacheControl?: string } = {},
): Promise<Response | null> {
	const obj = await bucket.get(key);
	if (!obj) return null;
	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	headers.set("ETag", obj.httpEtag);
	headers.set("Cache-Control", opts.cacheControl ?? obj.httpMetadata?.cacheControl ?? MEDIA_CACHE);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
	if (!isRasterMime(obj.httpMetadata?.contentType)) {
		headers.set("Content-Type", "application/octet-stream");
		headers.set("Content-Disposition", "attachment");
	}
	return new Response(obj.body, { headers });
}

/** Delete every object under a prefix (R2 list/delete are 1000 per call). */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
	let deleted = 0;
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		const keys = page.objects.map((o) => o.key);
		if (keys.length > 0) {
			await bucket.delete(keys);
			deleted += keys.length;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return deleted;
}
