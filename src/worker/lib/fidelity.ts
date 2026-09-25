/**
 * Fidelity guard (phase 4). Every AI result is compared with its source on a
 * 32×32 luma thumbnail before it may be saved. A result that drifted beyond
 * its operation class's budget fails the job (and is refunded) instead of
 * being stored as "your photo, edited".
 *
 * Budgets are calibrated on live outputs (plans/phase4): ESRGAN r=1.00,
 * background removal r=0.98 on the kept subject, a faithful FLUX edit r=0.99,
 * while unrelated images score r≤0.12.
 *
 * Reimagine also scores STRUCTURE (edge-map correlation), because a faithful
 * large recolour — a white shirt turned green over ~45% of the frame — moves
 * brightness enough to drop luma r to 0.37 (a false rejection, 2026-09-25),
 * while its edges still match (structure 0.58). Unrelated images fail both
 * (luma ≤0.07, structure ≤0.14).
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
	/** Reimagine only: edge-map correlation (colour/brightness-insensitive). */
	structure?: number;
	/** The score that decided and is recorded on the version (0..1). */
	fidelity: number;
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
	// the model never saw it (the bug that produced a stranger's face). It
	// passes on EITHER luma r ≥ 0.4 or structure ≥ REIMAGINE_MIN_STRUCTURE.
	reimagine: { minR: 0.4, maxMad: 255 },
};

/** Structure floor for Reimagine: faithful recolour 0.58, unrelated ≤ 0.14. */
const REIMAGINE_MIN_STRUCTURE = 0.3;
/** Structure is measured on a slightly larger thumbnail so edges survive. */
const STRUCTURE_SIZE = 48;

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
	// Flat regions carry no structure: judge them on tone alone.
	const r = sxx < 1e-6 || syy < 1e-6 ? (mad < 8 ? 1 : 0) : sxy / Math.sqrt(sxx * syy);
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
			const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
			const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
			out.push(Math.hypot(gx, gy));
		}
	}
	return out;
}

/**
 * Structure similarity: correlation of edge maps. Insensitive to recolouring
 * and relighting (edges stay where they were), but an unrelated image —
 * e.g. a model that never saw the photo — has edges somewhere else.
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
	if (saa < 1e-6 || sbb < 1e-6) return saa < 1e-6 && sbb < 1e-6 ? 1 : 0;
	return Math.round((sab / Math.sqrt(saa * sbb)) * 1000) / 1000;
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
	} else if (cls === "reimagine") {
		score = similarity(a, b);
		budget = BUDGETS.reimagine;
		const [sa, sb] = await Promise.all([ops.thumbnail(source, STRUCTURE_SIZE), ops.thumbnail(result, STRUCTURE_SIZE)]);
		const structure = structureSimilarity(sa, sb);
		score = { ...score, structure, fidelity: Math.max(score.fidelity, Math.max(0, structure)) };
		// No brightness cap here: relighting (day → night) legitimately moves
		// every pixel (mad 114 on a faithful edit). A blank or unrelated output
		// still fails, because it matches neither tone nor edges.
		const related = score.r >= budget.minR || structure >= REIMAGINE_MIN_STRUCTURE;
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
