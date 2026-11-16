/**
 * Fidelity guard (phase 4 + outpaint/style extensions). Every AI result is
 * compared with its source before it may be saved. Drift beyond the class's
 * budget fails the job (and is refunded) instead of saving a wrong image.
 */

import type { PixelBox, PixelOps } from "./pixels";
import { ProviderError } from "./providers/types";
import type { Rgba } from "./png";

export type OperationClass =
	| "adjust"
	| "enhance"
	| "segment"
	| "local"
	| "outpaint"
	| "style_transfer"
	| "reimagine"
	| "generate";

const SIZE = 32;
const HIGH_RES_LOCAL_SIZE = 64;

export interface Similarity {
	/** Pearson correlation of luma (structure). */
	r: number;
	/** Mean absolute luma difference, 0..255 (tone). */
	mad: number;
	/** Pixels compared. */
	n: number;
	/** Fraction of compared pixels whose luma moved by more than OUTLIER_DELTA. */
	outliers: number;
	/** Reimagine/style only: edge-map correlation (colour/brightness-insensitive). */
	structure?: number;
	/** The score that decided and is recorded on the version (0..1). */
	fidelity: number;
}

interface Budget {
	minR: number;
	maxMad: number;
	/** Local edits: outside the region we also cap how many pixels may change noticeably. */
	maxOutliers?: number;
}

const OUTLIER_DELTA = 24;

const BUDGETS: Record<Exclude<OperationClass, "generate" | "local" | "outpaint" | "style_transfer">, Budget> = {
	adjust: { minR: 0.9, maxMad: 40 },
	enhance: { minR: 0.9, maxMad: 25 },
	segment: { minR: 0.85, maxMad: 30 },
	reimagine: { minR: 0.4, maxMad: 255 },
};

/** Structure floor for Reimagine: faithful recolour 0.58, unrelated <= 0.14. */
const REIMAGINE_MIN_STRUCTURE = 0.3;
const STYLE_MIN_STRUCTURE = 0.25;
const STRUCTURE_SIZE = 48;
const STYLE_STRUCTURE_SIZE = 24;

/** Outside an edited region (or inside an outpaint), only re-encoding noise is allowed. */
const LOCAL_OUTSIDE: Budget = { minR: 0.95, maxMad: 8, maxOutliers: 0.01 };

function luma(img: Rgba, i: number): number {
	const o = i * 4;
	return 0.299 * img.data[o]! + 0.587 * img.data[o + 1]! + 0.114 * img.data[o + 2]!;
}

/** Compare two thumbnails over the pixels `include` selects. */
export function similarity(a: Rgba, b: Rgba, include: (i: number) => boolean = () => true): Similarity {
	const xs: number[] = [];
	const ys: number[] = [];
	for (let i = 0; i < a.width * a.height; i++) {
		if (!include(i)) continue;
		xs.push(luma(a, i));
		ys.push(luma(b, i));
	}
	const n = xs.length;
	if (n === 0) return { r: 1, mad: 0, n, outliers: 0, fidelity: 1 };
	const mx = xs.reduce((s, v) => s + v, 0) / n;
	const my = ys.reduce((s, v) => s + v, 0) / n;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	let mad = 0;
	let outliers = 0;
	for (let i = 0; i < n; i++) {
		if (Math.abs(xs[i]! - ys[i]!) > OUTLIER_DELTA) outliers++;
		sxy += (xs[i]! - mx) * (ys[i]! - my);
		sxx += (xs[i]! - mx) ** 2;
		syy += (ys[i]! - my) ** 2;
		mad += Math.abs(xs[i]! - ys[i]!);
	}
	mad /= n;
	// Only both-flat regions carry no structure; flat -> noisy fails (r = 0).
	const r =
		sxx < 1e-6 && syy < 1e-6
			? mad < 8
				? 1
				: 0
			: sxx < 1e-6 || syy < 1e-6
				? 0
				: sxy / Math.sqrt(sxx * syy);
	const rounded = Math.round(r * 1000) / 1000;
	return {
		r: rounded,
		mad: Math.round(mad * 10) / 10,
		n,
		outliers: Math.round((outliers / n) * 1000) / 1000,
		fidelity: Math.max(0, rounded),
	};
}

/** Sobel gradient magnitude of a thumbnail's luma, row-major. */
function gradients(img: Rgba): number[] {
	const at = (x: number, y: number) =>
		luma(img, Math.min(img.height - 1, Math.max(0, y)) * img.width + Math.min(img.width - 1, Math.max(0, x)));
	const out: number[] = [];
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			const gx =
				at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
			const gy =
				at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
			out.push(Math.hypot(gx, gy));
		}
	}
	return out;
}

/**
 * Structure similarity: correlation of edge maps. Insensitive to recolouring
 * and relighting, while unrelated generations have edges elsewhere.
 */
export function structureSimilarity(a: Rgba, b: Rgba): number {
	const ga = gradients(a);
	const gb = gradients(b);
	const n = ga.length;
	const ma = ga.reduce((s, v) => s + v, 0) / n;
	const mb = gb.reduce((s, v) => s + v, 0) / n;
	let sab = 0;
	let saa = 0;
	let sbb = 0;
	for (let i = 0; i < n; i++) {
		sab += (ga[i]! - ma) * (gb[i]! - mb);
		saa += (ga[i]! - ma) ** 2;
		sbb += (gb[i]! - mb) ** 2;
	}
	if (saa < 1e-6 && sbb < 1e-6) return 1;
	if (saa < 1e-6 || sbb < 1e-6) return 0;
	return Math.round((sab / Math.sqrt(saa * sbb)) * 1000) / 1000;
}

export interface FidelityOptions {
	/** Local edits: regions (normalized 0..1) that were allowed to change. */
	regions?: Array<{ x: number; y: number; w: number; h: number }>;
	/** Outpaint: original image's pixel rect inside `result`. */
	outpaintBox?: PixelBox;
}

/** Verify result keeps the same aspect ratio (within 15% tolerance for model rounding). */
async function checkAspect(ops: PixelOps, cls: OperationClass, source: ArrayBuffer, result: ArrayBuffer): Promise<void> {
	try {
		const [sd, dd] = await Promise.all([ops.dims(source), ops.dims(result)]);
		if (sd.width > 0 && sd.height > 0 && dd.width > 0 && dd.height > 0) {
			const ratio = (sd.width / sd.height) / (dd.width / dd.height);
			if (ratio > 1.18 || ratio < 1 / 1.18) {
				fail(cls, { r: 0, mad: 255, n: 0, outliers: 1, fidelity: 0 }, "result aspect ratio changed unexpectedly");
			}
		}
	} catch {
		// Ignore dims check failure when bytes aren't header-parseable; thumbnail check follows.
	}
}

/**
 * Score `result` against `source` for the class and throw a non-retryable
 * ProviderError if it is outside budget. Returns the score for auditing.
 */
export async function assertFidelity(
	ops: PixelOps,
	cls: OperationClass,
	source: ArrayBuffer,
	result: ArrayBuffer,
	opts: FidelityOptions = {},
): Promise<Similarity | null> {
	if (cls === "generate") return null;

	if (cls === "outpaint") {
		if (!opts.outpaintBox) throw new ProviderError("outpaint fidelity check missing inner box");
		const innerResult = await ops.crop(result, opts.outpaintBox);
		const [a, b] = await Promise.all([ops.thumbnail(source, SIZE), ops.thumbnail(innerResult.bytes, SIZE)]);
		const score = similarity(a, b);
		if (score.r < LOCAL_OUTSIDE.minR || score.mad > LOCAL_OUTSIDE.maxMad || score.outliers > (LOCAL_OUTSIDE.maxOutliers ?? 1)) {
			fail(cls, score, "outpaint altered pixels inside the original photo");
		}
		return score;
	}

	await checkAspect(ops, cls, source, result);
	const [a, b] = await Promise.all([ops.thumbnail(source, SIZE), ops.thumbnail(result, SIZE)]);

	let score: Similarity;
	let budget: Budget;
	if (cls === "segment") {
		let bgPixels = 0;
		let srcBgPixels = 0;
		for (let i = 0; i < SIZE * SIZE; i++) {
			if (b.data[i * 4 + 3]! <= 128) bgPixels++;
			if (a.data[i * 4 + 3]! <= 128) srcBgPixels++;
		}
		score = similarity(a, b, (i) => b.data[i * 4 + 3]! > 128);
		if (score.n < SIZE * SIZE * 0.02) fail(cls, score, "nothing was kept as foreground");
		if (srcBgPixels < SIZE * SIZE * 0.02 && bgPixels < SIZE * SIZE * 0.02) {
			fail(cls, score, "background was not separated from the subject");
		}
		budget = BUDGETS.segment;
	} else if (cls === "local") {
		const outsideMask = (size: number) => (i: number) => {
			const x = ((i % size) + 0.5) / size;
			const y = (Math.floor(i / size) + 0.5) / size;
			const pad = 1.5 / size;
			return !(opts.regions ?? []).some(
				(r) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad,
			);
		};
		score = similarity(a, b, outsideMask(SIZE));
		if (score.n === 0) {
			const [ha, hb] = await Promise.all([
				ops.thumbnail(source, HIGH_RES_LOCAL_SIZE),
				ops.thumbnail(result, HIGH_RES_LOCAL_SIZE),
			]);
			score = similarity(ha, hb, outsideMask(HIGH_RES_LOCAL_SIZE));
		}
		if (score.n === 0) {
			// Region covered the entire photo — ensure the result isn't unrelated noise.
			const [sa, sb] = await Promise.all([ops.thumbnail(source, STRUCTURE_SIZE), ops.thumbnail(result, STRUCTURE_SIZE)]);
			const structure = structureSimilarity(sa, sb);
			score = { ...similarity(a, b), structure };
			if (score.r < 0.4 && (structure < REIMAGINE_MIN_STRUCTURE || score.r < 0)) {
				fail(cls, score, "result drifted too far from the source photo");
			}
			return score;
		}
		budget = LOCAL_OUTSIDE;
	} else if (cls === "reimagine" || cls === "style_transfer") {
		score = similarity(a, b);
		const structSize = cls === "style_transfer" ? STYLE_STRUCTURE_SIZE : STRUCTURE_SIZE;
		const minStruct = cls === "style_transfer" ? STYLE_MIN_STRUCTURE : REIMAGINE_MIN_STRUCTURE;
		const minR = cls === "style_transfer" ? -0.1 : BUDGETS.reimagine.minR;
		const [sa, sb] = await Promise.all([ops.thumbnail(source, structSize), ops.thumbnail(result, structSize)]);
		const structure = structureSimilarity(sa, sb);
		score = { ...score, structure, fidelity: Math.max(score.fidelity, Math.max(0, structure)) };
		const related = score.r >= minR || (structure >= minStruct && score.r >= (cls === "style_transfer" ? -0.1 : -0.65));
		if (!related) {
			fail(cls, score, "result drifted too far from the source photo");
		}
		return score;
	} else {
		score = similarity(a, b);
		budget = BUDGETS[cls];
	}

	if (
		score.r < budget.minR ||
		score.mad > budget.maxMad ||
		(budget.maxOutliers !== undefined && score.outliers > budget.maxOutliers)
	) {
		fail(cls, score, "result drifted too far from the source photo");
	}
	return score;
}

function fail(cls: OperationClass, score: Similarity, why: string): never {
	console.warn(JSON.stringify({ message: "fidelity_check_failed", cls, ...score }));
	const structure = score.structure !== undefined ? `, structure=${score.structure}` : "";
	throw new ProviderError(`fidelity_check_failed: ${why} (${cls}: r=${score.r}, mad=${score.mad}${structure})`);
}

/** Region (normalized) -> pixel box within a width×height image. */
export function toPixelBox(
	r: { x: number; y: number; w: number; h: number },
	width: number,
	height: number,
): PixelBox {
	const left = Math.max(0, Math.min(width - 1, Math.floor(r.x * width)));
	const top = Math.max(0, Math.min(height - 1, Math.floor(r.y * height)));
	return {
		left,
		top,
		width: Math.max(1, Math.min(width - left, Math.round(r.w * width))),
		height: Math.max(1, Math.min(height - top, Math.round(r.h * height))),
	};
}
