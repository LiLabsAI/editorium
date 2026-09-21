/** R2 key layout + media helpers shared by API routes and job pipelines. */

export function mediaKeys(userId: string, albumId: string, imageId: string) {
	const base = `u/${userId}/a/${albumId}/i/${imageId}`;
	return {
		original: (ext: string) => `${base}/original.${ext}`,
		web: `${base}/web.webp`,
		thumb: `${base}/thumb.webp`,
		version: (versionId: string, ext: string) =>
			`${base}/v/${versionId}/full.${ext}`,
		segmentMask: (segmentId: string) => `${base}/seg/${segmentId}/mask.png`,
		segmentCrop: (segmentId: string) => `${base}/seg/${segmentId}/crop.png`,
	};
}

/** Parse intrinsic dimensions from a PNG or JPEG header. Returns null if unknown. */
export function imageDimensions(
	bytes: ArrayBuffer,
): { width: number; height: number } | null {
	const view = new DataView(bytes);
	if (view.byteLength < 24) return null;
	// PNG: 8-byte signature, IHDR at offset 16
	if (view.getUint32(0) === 0x89504e47) {
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}
	// JPEG: scan segment markers for SOF0..SOF3
	if (view.getUint16(0) === 0xffd8) {
		let offset = 2;
		while (offset + 9 < view.byteLength) {
			if (view.getUint8(offset) !== 0xff) break;
			const marker = view.getUint8(offset + 1);
			const length = view.getUint16(offset + 2);
			if (marker >= 0xc0 && marker <= 0xc3) {
				return {
					height: view.getUint16(offset + 5),
					width: view.getUint16(offset + 7),
				};
			}
			offset += 2 + length;
		}
	}
	return null;
}

export function extForMime(mime: string): string {
	if (mime === "image/png") return "png";
	if (mime === "image/webp") return "webp";
	if (mime === "image/svg+xml") return "svg";
	if (mime === "image/gif") return "gif";
	return "jpg";
}

const ALLOWED = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/svg+xml",
]);

export function validateImageMime(mime: string, sizeBytes: number): string | null {
	if (!ALLOWED.has(mime)) return `Unsupported type ${mime}`;
	if (sizeBytes > 25 * 1024 * 1024) return "File exceeds 25MB limit";
	return null;
}

/** Sniff magic bytes so a mislabeled upload cannot masquerade as an image. */
export function sniffMime(bytes: ArrayBuffer, declared: string): string | null {
	const view = new DataView(bytes);
	if (view.getUint32(0) === 0x89504e47) return "image/png";
	if (view.getUint16(0) === 0xffd8) return "image/jpeg";
	const ascii = (start: number, text: string) =>
		Array.from(text).every((ch, i) => view.getUint8(start + i) === ch.charCodeAt(0));
	if (view.byteLength > 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
	if (view.byteLength > 6 && ascii(0, "GIF8")) return "image/gif";
	if (view.byteLength > 5 && ascii(0, "<svg?") && declared === "image/svg+xml")
		return "image/svg+xml";
	if (declared === "image/svg+xml" && view.byteLength > 5) {
		const head = new TextDecoder().decode(new Uint8Array(bytes, 0, 200));
		if (head.includes("<svg")) return "image/svg+xml";
	}
	return null;
}

/** Short cache lifetime for user media; content is immutable per key. */
export const MEDIA_CACHE = "public, max-age=31536000, immutable";

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

export async function getObject(
	bucket: R2Bucket,
	key: string,
): Promise<Response | null> {
	const obj = await bucket.get(key);
	if (!obj) return null;
	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	headers.set("ETag", obj.httpEtag);
	const cacheControl = obj.httpMetadata?.cacheControl;
	if (cacheControl) headers.set("Cache-Control", cacheControl);
	return new Response(obj.body, { headers });
}
