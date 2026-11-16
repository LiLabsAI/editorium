import { MAX_MASK_PX } from "./config";
import { encodePng } from "./png";

export { encodePng };

/**
 * Server-side RGBA alpha mask synthesis (plan 16 + phase 4/5).
 * Every mask emitted here is 4-channel RGBA (white RGB with alpha 0..255) so
 * Cloudflare Images `draw(..., { composite: "in" })` and `PngOps.composite`
 * read the exact same alpha channel contract.
 */

export interface Bbox {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface MaskOptions {
	/** Cap the longer side to keep masks fast and within 128 MB isolate RAM. */
	maxSize?: number;
	/** Feather width as a fraction of image min side (polygon). */
	feather?: number;
}

function maskSize(imageWidth: number, imageHeight: number, maxSize: number) {
	const w = Math.max(1, imageWidth);
	const h = Math.max(1, imageHeight);
	const scale = Math.min(1, maxSize / Math.max(w, h));
	return {
		width: Math.max(1, Math.round(w * scale)),
		height: Math.max(1, Math.round(h * scale)),
		scale,
	};
}

/**
 * Feathered RGBA alpha mask for a normalized polygon (plan 20).
 * O(height × vertices) scanline even-odd fill, then an O(pixels) separable
 * box blur for the feather, packed into white RGBA with feathered alpha.
 */
export async function buildPolygonMask(
	polygon: Array<{ x: number; y: number }>,
	imageWidth: number,
	imageHeight: number,
	opts: MaskOptions = {},
): Promise<ArrayBuffer> {
	const { width, height } = maskSize(imageWidth, imageHeight, opts.maxSize ?? 512);
	const pts = polygon.map((p) => [p.x * width, p.y * height] as const);
	const alpha = new Uint8Array(width * height);
	const crossings: number[] = [];
	for (let y = 0; y < height; y++) {
		const sy = y + 0.5;
		crossings.length = 0;
		for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
			const [xi, yi] = pts[i]!;
			const [xj, yj] = pts[j]!;
			if (yi > sy !== yj > sy) crossings.push(xi + ((sy - yi) * (xj - xi)) / (yj - yi));
		}
		crossings.sort((a, b) => a - b);
		for (let k = 0; k + 1 < crossings.length; k += 2) {
			const x0 = Math.max(0, Math.ceil(crossings[k]! - 0.5));
			const x1 = Math.min(width - 1, Math.floor(crossings[k + 1]! - 0.5));
			if (x1 >= x0) alpha.fill(255, y * width + x0, y * width + x1 + 1);
		}
	}
	const radius = Math.max(1, Math.round(Math.min(width, height) * (opts.feather ?? 0.01)));
	boxBlur(alpha, width, height, radius);

	const rgba = new Uint8Array(width * height * 4).fill(255);
	for (let i = 0; i < alpha.length; i++) {
		rgba[i * 4 + 3] = alpha[i]!;
	}
	return encodePng(width, height, 4, rgba);
}

/** In-place separable box blur (horizontal then vertical), running sums. */
function boxBlur(pixels: Uint8Array, width: number, height: number, r: number): void {
	const tmp = new Float32Array(Math.max(width, height));
	const pass = (count: number, length: number, index: (line: number, i: number) => number) => {
		for (let line = 0; line < count; line++) {
			let sum = 0;
			for (let i = -r; i <= r; i++) sum += pixels[index(line, Math.min(length - 1, Math.max(0, i)))]!;
			for (let i = 0; i < length; i++) {
				tmp[i] = sum / (2 * r + 1);
				const add = Math.min(length - 1, i + r + 1);
				const drop = Math.max(0, i - r);
				sum += pixels[index(line, add)]! - pixels[index(line, drop)]!;
			}
			for (let i = 0; i < length; i++) pixels[index(line, i)] = Math.round(tmp[i]!);
		}
	};
	pass(height, width, (y, x) => y * width + x);
	pass(width, height, (x, y) => y * width + x);
}

/**
 * RGBA compositing mask: white everywhere, alpha 255 inside `box` feathering
 * to 0 over `feather` px outside it. Capped to `maxSize` (`MAX_MASK_PX`) so
 * large 4096px crops stay well inside the 128 MB Worker memory limit;
 * `ImagesOps.composite` resizes the mask natively to the exact crop dimensions.
 */
export async function buildAlphaMask(
	width: number,
	height: number,
	box: { left: number; top: number; width: number; height: number },
	feather: number,
	maxSize = MAX_MASK_PX,
): Promise<ArrayBuffer> {
	const { width: mw, height: mh, scale } = maskSize(width, height, maxSize);
	const rgba = new Uint8Array(mw * mh * 4).fill(255);
	const f = Math.max(1, feather * scale);
	const x0 = box.left * scale;
	const y0 = box.top * scale;
	const x1 = (box.left + box.width) * scale;
	const y1 = (box.top + box.height) * scale;
	for (let y = 0; y < mh; y++) {
		const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
		for (let x = 0; x < mw; x++) {
			const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
			const outside = Math.hypot(dx, dy);
			rgba[(y * mw + x) * 4 + 3] = Math.round(255 * Math.max(0, 1 - outside / f));
		}
	}
	return encodePng(mw, mh, 4, rgba);
}

/**
 * Outpainting inner-preservation mask: alpha 255 strictly inside the original
 * photo rectangle (`inner`), feathering inward over `feather` px near expanded
 * edges so the original pixels composite seamlessly over the outpainted border.
 */
export async function buildOutpaintInnerMask(
	totalW: number,
	totalH: number,
	inner: { left: number; top: number; width: number; height: number },
	feather: number,
	maxSize = MAX_MASK_PX,
): Promise<ArrayBuffer> {
	const { width: mw, height: mh, scale } = maskSize(totalW, totalH, maxSize);
	const rgba = new Uint8Array(mw * mh * 4).fill(255);
	const f = Math.max(1, feather * scale);
	const x0 = inner.left * scale;
	const y0 = inner.top * scale;
	const x1 = (inner.left + inner.width) * scale;
	const y1 = (inner.top + inner.height) * scale;
	const hasLeft = inner.left > 0;
	const hasTop = inner.top > 0;
	const hasRight = inner.left + inner.width < totalW;
	const hasBottom = inner.top + inner.height < totalH;

	for (let y = 0; y < mh; y++) {
		for (let x = 0; x < mw; x++) {
			if (x < x0 || x > x1 || y < y0 || y > y1) {
				rgba[(y * mw + x) * 4 + 3] = 0;
				continue;
			}
			const dLeft = hasLeft ? x - x0 : Infinity;
			const dRight = hasRight ? x1 - x : Infinity;
			const dTop = hasTop ? y - y0 : Infinity;
			const dBottom = hasBottom ? y1 - y : Infinity;
			const dist = Math.min(dLeft, dRight, dTop, dBottom);
			const alpha = dist === Infinity ? 1 : Math.min(1, Math.max(0, dist / f));
			rgba[(y * mw + x) * 4 + 3] = Math.round(255 * alpha);
		}
	}
	return encodePng(mw, mh, 4, rgba);
}
