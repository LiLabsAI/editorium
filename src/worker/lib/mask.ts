import { encodePng } from "./png";

export { encodePng };

/** Server-side mask synthesis (plan 16). PNG encoding lives in lib/png.ts. */

export interface Bbox {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface MaskOptions {
	/** Cap the longer side to keep masks small (aspect preserved). */
	maxSize?: number;
	/** Feather width as a fraction of the shorter side (box) or image (polygon). */
	feather?: number;
}

function maskSize(imageWidth: number, imageHeight: number, maxSize: number) {
	const w = Math.max(1, imageWidth);
	const h = Math.max(1, imageHeight);
	const scale = Math.min(1, maxSize / Math.max(w, h));
	return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Grayscale PNG: white inside the feathered box, black outside. 255 = editable. */
export async function buildBoxMask(
	box: Bbox,
	imageWidth: number,
	imageHeight: number,
	opts: MaskOptions = {},
): Promise<ArrayBuffer> {
	const { width, height } = maskSize(imageWidth, imageHeight, opts.maxSize ?? 1024);
	const featherFrac = Math.min(0.5, Math.max(opts.feather ?? 0.08, 0.01));
	const bx = box.x * width;
	const by = box.y * height;
	const bw = Math.max(1, box.w * width);
	const bh = Math.max(1, box.h * height);
	const feather = Math.max(1, Math.min(bw, bh) * featherFrac);

	const pixels = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		const dy = y < by ? by - y : y > by + bh ? y - (by + bh) : 0;
		for (let x = 0; x < width; x++) {
			const dx = x < bx ? bx - x : x > bx + bw ? x - (bx + bw) : 0;
			// Signed distance to the box edge: positive inside, negative outside.
			const edgeDist =
				dx === 0 && dy === 0
					? Math.min(x - bx, bx + bw - x, y - by, by + bh - y)
					: -Math.hypot(dx, dy);
			const v = Math.min(1, Math.max(0, (edgeDist + feather) / feather));
			pixels[y * width + x] = Math.round(v * 255);
		}
	}
	return encodePng(width, height, 1, pixels);
}

/**
 * Feathered grayscale mask for a normalized polygon (plan 20).
 * O(height × vertices) scanline even-odd fill, then an O(pixels) separable
 * box blur for the feather — replaces the old per-pixel point-in-polygon
 * search that could blow the Worker CPU limit on large polygons.
 */
export async function buildPolygonMask(
	polygon: Array<{ x: number; y: number }>,
	imageWidth: number,
	imageHeight: number,
	opts: MaskOptions = {},
): Promise<ArrayBuffer> {
	const { width, height } = maskSize(imageWidth, imageHeight, opts.maxSize ?? 512);
	const pts = polygon.map((p) => [p.x * width, p.y * height] as const);
	const pixels = new Uint8Array(width * height);
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
			if (x1 >= x0) pixels.fill(255, y * width + x0, y * width + x1 + 1);
		}
	}
	const radius = Math.max(1, Math.round(Math.min(width, height) * (opts.feather ?? 0.01)));
	boxBlur(pixels, width, height, radius);
	return encodePng(width, height, 1, pixels);
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
 * RGBA compositing mask (phase 4): white everywhere, alpha 255 inside `box`
 * (pixel coords within a width×height canvas) feathering to 0 over `feather`
 * px outside it. Used with Images `draw(..., { composite: "in" })` so an
 * edited patch only lands inside the region.
 */
export async function buildAlphaMask(
	width: number,
	height: number,
	box: { left: number; top: number; width: number; height: number },
	feather: number,
): Promise<ArrayBuffer> {
	const rgba = new Uint8Array(width * height * 4).fill(255);
	const f = Math.max(1, feather);
	const x0 = box.left;
	const y0 = box.top;
	const x1 = box.left + box.width;
	const y1 = box.top + box.height;
	for (let y = 0; y < height; y++) {
		const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
		for (let x = 0; x < width; x++) {
			const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
			const outside = Math.hypot(dx, dy);
			rgba[(y * width + x) * 4 + 3] = Math.round(255 * Math.max(0, 1 - outside / f));
		}
	}
	return encodePng(width, height, 4, rgba);
}
