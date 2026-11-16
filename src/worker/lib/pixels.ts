/**
 * Deterministic pixel operations behind one interface (phase 4).
 *
 * - `ImagesOps` — production: the Cloudflare Images binding. Resize, crop
 *   (`trim`), pad (`border`), ESRGAN upscale (`upscale: "generate"`), BiRefNet
 *   background removal (`segment: "foreground"`), and masked compositing
 *   (`draw` with `composite: "in"`).
 * - `PngOps` — offline tests (AI_MOCK): the same operations in pure TS on PNGs.
 *
 * Every op preserves PNG alpha when the source uses PNG/WebP transparency so
 * transparent cutouts never lose their alpha channel on later edits.
 */

import { isMock } from "./providers";
import { decodePng, encodeRgba, type Rgba } from "./png";
import { imageDimensions, sniffMime } from "./r2";

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

export interface PadSpec {
	top: number;
	bottom: number;
	left: number;
	right: number;
	color?: string;
}

export interface PixelOps {
	/** Re-encode with EXIF rotation applied (all later coordinates are in
	 * displayed space) and cap the longest side. */
	normalize(bytes: ArrayBuffer, maxSide: number): Promise<Encoded>;
	dims(bytes: ArrayBuffer): Promise<{ width: number; height: number }>;
	resize(bytes: ArrayBuffer, width: number, height: number): Promise<Encoded>;
	crop(bytes: ArrayBuffer, box: PixelBox): Promise<Encoded>;
	/** Expand the canvas with border padding (used for generative outpainting). */
	pad(bytes: ArrayBuffer, pad: PadSpec): Promise<Encoded>;
	/** Detail enhance: AI upscale (ESRGAN) when small, plus mild sharpening. */
	enhance(bytes: ArrayBuffer): Promise<Encoded & { model: string }>;
	/** Subject on transparency (PNG with alpha). */
	removeBackground(bytes: ArrayBuffer): Promise<Encoded>;
	/** Paste `patch` (resized to box) onto `base` at box, weighted by the
	 * alpha of `maskPng` (resized to box). Outside the box: untouched. */
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

/** Preserve PNG transparency on PNG/WebP inputs; encode JPEGs as quality 92. */
function outputFormatFor(bytes: ArrayBuffer): { format: "image/png" | "image/jpeg"; quality?: number } {
	const mime = sniffMime(bytes);
	return mime === "image/png" || mime === "image/webp"
		? { format: "image/png" }
		: { format: "image/jpeg", quality: 92 };
}

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
		const mime = sniffMime(bytes);
		// JPEGs may carry EXIF orientation; images.info() returns displayed dims.
		if (mime === "image/jpeg") {
			try {
				const info = await this.images.info(new Response(bytes).body!);
				if ("width" in info && info.width > 0 && info.height > 0) {
					return { width: info.width, height: info.height };
				}
			} catch {
				// Fallback to header parse below.
			}
		}
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
		const outOpts = outputFormatFor(bytes);
		const out = await handle.output(outOpts);
		return { bytes: await bytesOf(out), mime: outOpts.format };
	}

	async resize(bytes: ArrayBuffer, width: number, height: number): Promise<Encoded> {
		const outOpts = outputFormatFor(bytes);
		const out = await this.input(bytes).transform({ width, height, fit: "squeeze" }).output(outOpts);
		return { bytes: await bytesOf(out), mime: outOpts.format };
	}

	async crop(bytes: ArrayBuffer, box: PixelBox): Promise<Encoded> {
		const outOpts = outputFormatFor(bytes);
		const out = await this.input(bytes)
			.transform({ trim: { left: box.left, top: box.top, width: box.width, height: box.height } })
			.output(outOpts.format === "image/jpeg" ? { format: "image/jpeg", quality: 95 } : { format: "image/png" });
		return { bytes: await bytesOf(out), mime: outOpts.format };
	}

	async pad(bytes: ArrayBuffer, pad: PadSpec): Promise<Encoded> {
		const out = await this.input(bytes)
			.transform({
				border: {
					top: pad.top,
					bottom: pad.bottom,
					left: pad.left,
					right: pad.right,
					color: pad.color ?? "#18181b",
				},
			})
			.output({ format: "image/png" });
		return { bytes: await bytesOf(out), mime: "image/png" };
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
		const outOpts = outputFormatFor(bytes);
		const out = await handle.transform({ sharpen: 1 }).output(outOpts);
		return { bytes: await bytesOf(out), mime: outOpts.format, model };
	}

	async removeBackground(bytes: ArrayBuffer): Promise<Encoded> {
		const out = await this.input(bytes).transform({ segment: "foreground" }).output({ format: "image/png" });
		return { bytes: await bytesOf(out), mime: "image/png" };
	}

	async composite(base: ArrayBuffer, patch: ArrayBuffer, maskPng: ArrayBuffer, box: PixelBox): Promise<Encoded> {
		const [fitted, sizedMask] = await Promise.all([
			bytesOf(
				await this.input(patch)
					.transform({ width: box.width, height: box.height, fit: "squeeze" })
					.output({ format: "image/png" }),
			),
			bytesOf(
				await this.input(maskPng)
					.transform({ width: box.width, height: box.height, fit: "squeeze" })
					.output({ format: "image/png" }),
			),
		]);
		// "in": the patch shows only where the mask is opaque (feathered alpha).
		const masked = await bytesOf(
			await this.input(sizedMask).draw(new Response(fitted).body!, { composite: "in" }).output({ format: "image/png" }),
		);
		const outOpts = outputFormatFor(base);
		const out = await this.input(base)
			.draw(new Response(masked).body!, { left: box.left, top: box.top })
			.output(outOpts);
		return { bytes: await bytesOf(out), mime: outOpts.format };
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
		const left = Math.max(0, Math.min(src.width - 1, box.left));
		const top = Math.max(0, Math.min(src.height - 1, box.top));
		const width = Math.max(1, Math.min(src.width - left, box.width));
		const height = Math.max(1, Math.min(src.height - top, box.height));
		const data = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++) {
			const from = ((top + y) * src.width + left) * 4;
			data.set(src.data.subarray(from, from + width * 4), y * width * 4);
		}
		return png({ width, height, data });
	}

	async pad(bytes: ArrayBuffer, pad: PadSpec): Promise<Encoded> {
		const src = await decodePng(bytes);
		const width = src.width + pad.left + pad.right;
		const height = src.height + pad.top + pad.bottom;
		const data = new Uint8Array(width * height * 4);
		for (let i = 0; i < data.length; i += 4) {
			data[i] = 24;
			data[i + 1] = 24;
			data[i + 2] = 27;
			data[i + 3] = 255;
		}
		for (let y = 0; y < src.height; y++) {
			const dstStart = ((y + pad.top) * width + pad.left) * 4;
			const srcStart = y * src.width * 4;
			data.set(src.data.subarray(srcStart, srcStart + src.width * 4), dstStart);
		}
		return png({ width, height, data });
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
		const mask = sample(await decodePng(maskPng), box.width, box.height);
		const out = new Uint8Array(dst.data);
		for (let y = 0; y < box.height; y++) {
			const dy = box.top + y;
			if (dy < 0 || dy >= dst.height) continue;
			for (let x = 0; x < box.width; x++) {
				const dx = box.left + x;
				if (dx < 0 || dx >= dst.width) continue;
				const s = (y * box.width + x) * 4;
				const a = (mask.data[s + 3]! / 255) * (src.data[s + 3]! / 255);
				if (a === 0) continue;
				const d = (dy * dst.width + dx) * 4;
				const da = out[d + 3]! / 255;
				const outA = a + da * (1 - a);
				if (outA > 0) {
					for (let c = 0; c < 3; c++) {
						out[d + c] = Math.round((src.data[s + c]! * a + out[d + c]! * da * (1 - a)) / outA);
					}
				}
				out[d + 3] = Math.round(outA * 255);
			}
		}
		return png({ width: dst.width, height: dst.height, data: out });
	}

	async thumbnail(bytes: ArrayBuffer, size: number): Promise<Rgba> {
		return sample(await decodePng(bytes), size, size);
	}
}
