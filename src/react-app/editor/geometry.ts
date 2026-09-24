/**
 * Single coordinate bridge for the editor canvas (plan 15).
 *
 * Boxes are ALWAYS normalized 0..1. Pointer input converts to normalized
 * immediately via the measured, transform-inclusive rects. Zoom/pan state is
 * used for rendering, never for input math.
 */

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface NormPoint {
	x: number;
	y: number;
}

export interface Bbox {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** client pixels → normalized image space (null before first layout). */
export function toNorm(
	clientX: number,
	clientY: number,
	container: Rect,
	img: Rect,
): NormPoint | null {
	if (img.width <= 0 || img.height <= 0) return null;
	return {
		x: (clientX - container.left - img.left) / img.width,
		y: (clientY - container.top - img.top) / img.height,
	};
}
