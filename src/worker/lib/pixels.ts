/**
 * Deterministic pixel operations behind one interface (phase 4).
 *
 * - `ImagesOps` — production: the Cloudflare Images binding. Resize, crop
 *   (`trim`), ESRGAN upscale (`upscale: "generate"`), BiRefNet background
 *   removal (`segment: "foreground"`) and masked compositing (`draw` with
 *   `composite: "in"`). Verified live against the binding (plans/phase4).
 * - `PngOps` — offline tests (AI_MOCK): the same operations in pure TS on
 *   PNGs, because the local Images emulator only supports resize/rotate.
 *
 * Every op returns encoded bytes + mime so results flow straight into
 * storage and the fidelity guard.
 */

import { isMock } from "./providers";
import { decodePng, encodeRgba, type Rgba } from "./png";
import { imageDimensions } from "./r2";

export interface Encoded {
	bytes: ArrayBuffer;
	mime: string;
}

export interface PixelBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface PixelOps {
	/** Re-encode with EXIF rotation applied (all later coordinates are in
	 * displayed space) and cap the longest side. */
	normalize(bytes: ArrayBuffer, maxSide: number): Promise<Encoded>;
	dims(bytes: ArrayBuffer): Promise<{ width: number; height: number }>;
	resize(bytes: ArrayBuffer, width: number, height: number): Promise<Encoded>;
	crop(bytes: ArrayBuffer, box: PixelBox): Promise<Encoded>;
	/** Detail enhance: AI upscale (ESRGAN) when small, plus mild sharpening. */
	enhance(bytes: ArrayBuffer): Promise<Encoded & { model: string }>;
	/** Subject on transparency (PNG with alpha). */
	removeBackground(bytes: ArrayBuffer): Promise<Encoded>;
	/** Paste `patch` (resized to box) onto `base` at box, weighted by the
	 * alpha of `maskPng` (same size as box). Outside the box: untouched. */
	composite(base: ArrayBuffer, patch: ArrayBuffer, maskPng: ArrayBuffer, box: PixelBox): Promise<Encoded>;
	/** Tiny RGBA thumbnail for the fidelity guard (aspect squeezed). */
	thumbnail(bytes: ArrayBuffer, size: number): Promise<Rgba>;
}

export function pixelOps(env: Env): PixelOps {
	return isMock(env) ? new PngOps() : new ImagesOps(env.IMAGES);
}

/** Largest AI-upscaled output (long side) and the size below which we upscale. */
const UPSCALE_MAX_SIDE = 4096;
const UPSCALE_BELOW_SIDE = 2048;

/** The installed binding types predate AI upscaling (`upscale`, `fit:
 * "scale-up"`); both are live on the binding (probed 2026-09-25). */
type Transform = Omit<ImageTransform, "fit"> & {
	fit?: ImageTransform["fit"] | "scale-up";
	upscale?: "interpolate" | "generate";
};

async function bytesOf(result: ImageTransformationResult): Promise<ArrayBuffer> {
	return result.response().arrayBuffer();
}

export class ImagesOps implements PixelOps {
	constructor(private readonly images: ImagesBinding) {}

	private input(bytes: ArrayBuffer) {
		return this.images.input(new Response(bytes).body!);
	}

	async dims(bytes: ArrayBuffer) {
		const parsed = imageDimensions(bytes);
		if (parsed) return parsed;
		const info = await this.images.info(new Response(bytes).body!);
		if (!("width" in info)) throw new Error("unsupported image");
		return { width: info.width, height: info.height };
	}

	async normalize(bytes: ArrayBuffer, maxSide: number): Promise<Encoded> {
		const { width, height } = await this.dims(bytes);
		const scale = Math.min(1, maxSide / Math.max(width, height));
		let handle = this.input(bytes);
		if (scale < 1) {
			handle = handle.transform({
				width: Math.round(width * scale),
				height: Math.round(height * scale),
				fit: "scale-down",
			});
		}
		const out = await handle.output({ format: "image/jpeg", quality: 92 });
		return { bytes: await bytesOf(out), mime: "image/jpeg" };
	}

	async resize(bytes: ArrayBuffer, width: number, height: number): Promise<Encoded> {
		const out = await this.input(bytes)
			.transform({ width, height, fit: "squeeze" })
			.output({ format: "image/jpeg", quality: 92 });
		return { bytes: await bytesOf(out), mime: "image/jpeg" };
	}

	async crop(bytes: ArrayBuffer, box: PixelBox): Promise<Encoded> {
		const out = await this.input(bytes)
			.transform({ trim: { left: box.left, top: box.top, width: box.width, height: box.height } })
			.output({ format: "image/jpeg", quality: 95 });
		return { bytes: await bytesOf(out), mime: "image/jpeg" };
	}

	async enhance(bytes: ArrayBuffer): Promise<Encoded & { model: string }> {
		const { width, height } = await this.dims(bytes);
		const longest = Math.max(width, height);
		let handle = this.input(bytes);
		let model = "images:sharpen";
		if (longest < UPSCALE_BELOW_SIDE) {
			const factor = Math.min(2, UPSCALE_MAX_SIDE / longest);
			const upscale: Transform = {
				width: Math.round(width * factor),
				height: Math.round(height * factor),
				fit: "scale-up",
				upscale: "generate",
			};
			handle = handle.transform(upscale as ImageTransform);
			model = "images:esrgan+sharpen";
		}
		const out = await handle.transform({ sharpen: 1 }).output({ format: "image/jpeg", quality: 92 });
		return { bytes: await bytesOf(out), mime: "image/jpeg", model };
	}

	async removeBackground(bytes: ArrayBuffer): Promise<Encoded> {
		const out = await this.input(bytes).transform({ segment: "foreground" }).output({ format: "image/png" });
		return { bytes: await bytesOf(out), mime: "image/png" };
	}

	async composite(base: ArrayBuffer, patch: ArrayBuffer, maskPng: ArrayBuffer, box: PixelBox): Promise<Encoded> {
		const fitted = await bytesOf(
			await this.input(patch)
				.transform({ width: box.width, height: box.height, fit: "squeeze" })
				.output({ format: "image/png" }),
		);
		// "in": the patch shows only where the mask is opaque (feathered alpha).
		const masked = await bytesOf(
			await this.input(maskPng).draw(new Response(fitted).body!, { composite: "in" }).output({ format: "image/png" }),
		);
		const out = await this.input(base)
			.draw(new Response(masked).body!, { left: box.left, top: box.top })
			.output({ format: "image/jpeg", quality: 92 });
		return { bytes: await bytesOf(out), mime: "image/jpeg" };
	}

	async thumbnail(bytes: ArrayBuffer, size: number): Promise<Rgba> {
		const out = await this.input(bytes)
			.transform({ width: size, height: size, fit: "squeeze" })
			.output({ format: "image/png" });
		return decodePng(await bytesOf(out));
	}
}

// ---------------------------------------------------------------------------
// Offline implementation (tests): PNG in, PNG out, pure TS.
// ---------------------------------------------------------------------------

function sample(src: Rgba, width: number, height: number): Rgba {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const sy = Math.min(src.height - 1, Math.floor(((y + 0.5) * src.height) / height));
		for (let x = 0; x < width; x++) {
			const sx = Math.min(src.width - 1, Math.floor(((x + 0.5) * src.width) / width));
			data.set(src.data.subarray((sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4), (y * width + x) * 4);
		}
	}
	return { width, height, data };
}

async function png(image: Rgba): Promise<Encoded> {
	return { bytes: await encodeRgba(image), mime: "image/png" };
}

export class PngOps implements PixelOps {
	async dims(bytes: ArrayBuffer) {
		const d = imageDimensions(bytes);
		if (!d) throw new Error("unsupported image");
		return d;
	}

	async normalize(bytes: ArrayBuffer, maxSide: number): Promise<Encoded> {
		const src = await decodePng(bytes);
		const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
		return png(sample(src, Math.max(1, Math.round(src.width * scale)), Math.max(1, Math.round(src.height * scale))));
	}

	async resize(bytes: ArrayBuffer, width: number, height: number): Promise<Encoded> {
		return png(sample(await decodePng(bytes), width, height));
	}

	async crop(bytes: ArrayBuffer, box: PixelBox): Promise<Encoded> {
		const src = await decodePng(bytes);
		const data = new Uint8Array(box.width * box.height * 4);
		for (let y = 0; y < box.height; y++) {
			const from = ((box.top + y) * src.width + box.left) * 4;
			data.set(src.data.subarray(from, from + box.width * 4), y * box.width * 4);
		}
		return png({ width: box.width, height: box.height, data });
	}

	async enhance(bytes: ArrayBuffer): Promise<Encoded & { model: string }> {
		const src = await decodePng(bytes);
		const factor = Math.max(src.width, src.height) < UPSCALE_BELOW_SIDE ? 2 : 1;
		return { ...(await png(sample(src, src.width * factor, src.height * factor))), model: "mock:upscale" };
	}

	async removeBackground(bytes: ArrayBuffer): Promise<Encoded> {
		// Mock segmentation: pixels close to the top-left colour are background.
		const src = await decodePng(bytes);
		const out = new Uint8Array(src.data);
		const [r0, g0, b0] = [src.data[0]!, src.data[1]!, src.data[2]!];
		for (let i = 0; i < out.length; i += 4) {
			const d = Math.abs(out[i]! - r0) + Math.abs(out[i + 1]! - g0) + Math.abs(out[i + 2]! - b0);
			if (d < 24) out[i + 3] = 0;
		}
		return png({ width: src.width, height: src.height, data: out });
	}

	async composite(base: ArrayBuffer, patch: ArrayBuffer, maskPng: ArrayBuffer, box: PixelBox): Promise<Encoded> {
		const dst = await decodePng(base);
		const src = sample(await decodePng(patch), box.width, box.height);
		const mask = await decodePng(maskPng);
		const out = new Uint8Array(dst.data);
		for (let y = 0; y < box.height; y++) {
			for (let x = 0; x < box.width; x++) {
				const a = mask.data[(y * mask.width + x) * 4 + 3]! / 255;
				if (a === 0) continue;
				const d = ((box.top + y) * dst.width + box.left + x) * 4;
				const s = (y * box.width + x) * 4;
				for (let c = 0; c < 3; c++) out[d + c] = Math.round(out[d + c]! * (1 - a) + src.data[s + c]! * a);
			}
		}
		return png({ width: dst.width, height: dst.height, data: out });
	}

	async thumbnail(bytes: ArrayBuffer, size: number): Promise<Rgba> {
		return sample(await decodePng(bytes), size, size);
	}
}
