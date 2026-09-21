/**
 * Single coordinate bridge for the editor canvas (plan 15).
 *
 * Segment bboxes are ALWAYS normalized 0..1. Pointer input converts to
 * normalized immediately via the measured, transform-inclusive rects; screen
 * positions are only ever produced by toScreen. Zoom/pan state is used for
 * rendering, never for input math.
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

export interface SegmentLike {
	id: string;
	bboxX: number;
	bboxY: number;
	bboxW: number;
	bboxH: number;
	orderIdx: number;
	parentSegmentId: string | null;
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

/** normalized image space → container-relative screen position. */
export function toScreen(nx: number, ny: number, img: Rect): { left: number; top: number } {
	return {
		left: img.left + nx * img.width,
		top: img.top + ny * img.height,
	};
}

/** Deepest-first hit test: children (higher orderIdx) win over parents. */
export function segmentAt(
	segments: SegmentLike[],
	nx: number,
	ny: number,
): SegmentLike | null {
	const ordered = [...segments].sort((a, b) => b.orderIdx - a.orderIdx);
	for (const s of ordered) {
		if (nx >= s.bboxX && ny >= s.bboxY && nx <= s.bboxX + s.bboxW && ny <= s.bboxY + s.bboxH) {
			return s;
		}
	}
	return null;
}

/** All segment ids whose bbox intersects the normalized marquee rectangle. */
export function marqueeSelect(
	segments: SegmentLike[],
	a: NormPoint,
	b: NormPoint,
): string[] {
	const x1 = Math.min(a.x, b.x);
	const y1 = Math.min(a.y, b.y);
	const x2 = Math.max(a.x, b.x);
	const y2 = Math.max(a.y, b.y);
	return segments
		.filter((s) => s.bboxX < x2 && s.bboxX + s.bboxW > x1 && s.bboxY < y2 && s.bboxY + s.bboxH > y1)
		.map((s) => s.id);
}

export function clampBox(box: Bbox): Bbox {
	const x = Math.min(Math.max(box.x, 0), 1);
	const y = Math.min(Math.max(box.y, 0), 1);
	return {
		x,
		y,
		w: Math.min(Math.max(box.w, 0.01), 1 - x),
		h: Math.min(Math.max(box.h, 0.01), 1 - y),
	};
}

/** Apply a handle drag (dx/dy normalized) to a starting box. */
export function resizeBox(start: Bbox, handle: string, dx: number, dy: number): Bbox {
	const next = { ...start };
	if (handle === "move") return { ...next, x: start.x + dx, y: start.y + dy };
	if (handle.includes("w")) {
		next.x = start.x + dx;
		next.w = start.w - dx;
	}
	if (handle.includes("e")) next.w = start.w + dx;
	if (handle.includes("n")) {
		next.y = start.y + dy;
		next.h = start.h - dy;
	}
	if (handle.includes("s")) next.h = start.h + dy;
	return next;
}

/** Anchor position for the floating prompt card, flipped to stay inside the
 * container. Returns container-relative coordinates. */
export function promptCardPosition(
	segment: SegmentLike,
	img: Rect,
	containerWidth: number,
	cardWidth: number,
): { left: number; top: number } {
	const right = toScreen(segment.bboxX + segment.bboxW, segment.bboxY, img);
	const leftOfBox = toScreen(segment.bboxX, segment.bboxY, img).left;
	const gap = 14;
	let left = right.left + gap;
	if (left + cardWidth > containerWidth - 8) {
		left = Math.max(8, leftOfBox - cardWidth - gap);
	}
	return {
		left,
		top: Math.max(8, right.top),
	};
}
