/**
 * Fidelity guard (phase 4). Every AI result is compared with its source on a
 * 32×32 luma thumbnail before it may be saved. A result that drifted beyond
 * its operation class's budget fails the job (and is refunded) instead of
 * being stored as "your photo, edited".
 *
 * Budgets are calibrated on live outputs (plans/phase4): ESRGAN r=1.00,
 * background removal r=0.98 on the kept subject, a faithful FLUX edit r=0.99,
 * while unrelated images score r≤0.12.
 */

import type { PixelBox, PixelOps } from "./pixels";
import { ProviderError } from "./providers/types";
import type { Rgba } from "./png";

export type OperationClass = "adjust" | "enhance" | "segment" | "local" | "reimagine" | "generate";

const SIZE = 32;

export interface Similarity {
	/** Pearson correlation of luma (structure). */
	r: number;
	/** Mean absolute luma difference, 0..255 (tone). */
	mad: number;
	/** Pixels compared. */
	n: number;
	/** Fraction of compared pixels whose luma moved by more than OUTLIER_DELTA. */
	outliers: number;
}

interface Budget {
	minR: number;
	maxMad: number;
	/** Local edits: a small change is diluted in an average, so outside the
	 * region we also cap how many pixels may change noticeably. */
	maxOutliers?: number;
}

const OUTLIER_DELTA = 24;

const BUDGETS: Record<Exclude<OperationClass, "generate" | "local">, Budget> = {
	adjust: { minR: 0.9, maxMad: 40 },
	enhance: { minR: 0.9, maxMad: 25 },
	segment: { minR: 0.85, maxMad: 30 },
	// Reimagine may change a lot, but a result unrelated to the photo means
	// the model never saw it (the bug that produced a stranger's face).
	reimagine: { minR: 0.4, maxMad: 90 },
};

/** Outside an edited region, only re-encoding noise is allowed. */
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
	if (n === 0) return { r: 1, mad: 0, n, outliers: 0 };
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
	// Flat regions carry no structure: judge them on tone alone.
	const r = sxx < 1e-6 || syy < 1e-6 ? (mad < 8 ? 1 : 0) : sxy / Math.sqrt(sxx * syy);
	return {
		r: Math.round(r * 1000) / 1000,
		mad: Math.round(mad * 10) / 10,
		n,
		outliers: Math.round((outliers / n) * 1000) / 1000,
	};
}

export interface FidelityOptions {
	/** Local edits: regions (normalized 0..1) that were allowed to change. */
	regions?: Array<{ x: number; y: number; w: number; h: number }>;
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
	const [a, b] = await Promise.all([ops.thumbnail(source, SIZE), ops.thumbnail(result, SIZE)]);

	let score: Similarity;
	let budget: Budget;
	if (cls === "segment") {
		// Only the kept subject must match; the background is gone by design.
		score = similarity(a, b, (i) => b.data[i * 4 + 3]! > 128);
		if (score.n < SIZE * SIZE * 0.02) fail(cls, score, "nothing was kept as foreground");
		budget = BUDGETS.segment;
	} else if (cls === "local") {
		// Everything outside the (slightly grown) edited regions must be unchanged.
		const outside = (i: number) => {
			const x = ((i % SIZE) + 0.5) / SIZE;
			const y = (Math.floor(i / SIZE) + 0.5) / SIZE;
			const pad = 1.5 / SIZE;
			return !(opts.regions ?? []).some(
				(r) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad,
			);
		};
		score = similarity(a, b, outside);
		budget = LOCAL_OUTSIDE;
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
	throw new ProviderError(`fidelity_check_failed: ${why} (${cls}: r=${score.r}, mad=${score.mad})`);
}

/** Region (normalized) → pixel box within a width×height image. */
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
