import { eq } from "drizzle-orm";

import { segments } from "../../../database/schema";
import { createDb } from "./db";
import { getProvider, type DetectedBox } from "./providers";
import { mediaKeys, putObject } from "./r2";

/**
 * Auto-segmentation pipeline (plan 9): detect boxes → build a hierarchy
 * (person boxes gain head/eyes/mouth children) → caption each region →
 * persist normalized rows + crop thumbnails. Runs inside SegmentWorkflow
 * steps so each stage is retried independently.
 */

export interface SegmentationContext {
	env: Env;
	imageId: string;
	userId: string;
	albumId: string;
	imageBytes: ArrayBuffer;
	mime: string;
	widthPx: number;
	heightPx: number;
}

export interface CaptionedNode {
	box: DetectedBox;
	label: string;
	caption: string;
	children: CaptionedNode[];
}

// Scene-region vocabulary the VLM inventory may use — anything else it
// returns is treated as a discrete-object hallucination and dropped.
const SCENE_WORDS = new Set([
	"sky", "water", "sea", "ocean", "sand", "beach", "grass", "lawn", "snow",
	"road", "street", "floor", "wooden floor", "wall", "foliage", "ceiling",
	"hill", "hills", "mountain", "mountains", "ground", "pavement", "carpet",
	"tiles", "curtain", "background", "surface", "table surface",
]);

/** Merge near-duplicate boxes: any overlap above IoU 0.85 collapses outright,
 * and same-label boxes above 0.4 collapse too (DETR fires 3-4 times on one
 * dog otherwise). The higher-scoring box always wins. */
export function dedupeBoxes(boxes: DetectedBox[]): DetectedBox[] {
	const sorted = [...boxes].sort((a, b) => b.score - a.score);
	const kept: DetectedBox[] = [];
	for (const box of sorted) {
		const dup = kept.find((k) => iou(k, box) > 0.85 || (k.label === box.label && iou(k, box) > 0.3));
		if (!dup) kept.push(box);
	}
	return kept;
}

function iou(a: DetectedBox, b: DetectedBox): number {
	const x1 = Math.max(a.x, b.x);
	const y1 = Math.max(a.y, b.y);
	const x2 = Math.min(a.x + a.w, b.x + b.w);
	const y2 = Math.min(a.y + a.h, b.y + b.h);
	if (x2 <= x1 || y2 <= y1) return 0;
	const inter = (x2 - x1) * (y2 - y1);
	return inter / (a.w * a.h + b.w * b.h - inter);
}

const PERSON_LABELS = new Set(["person", "man", "woman", "face", "human"]);

export interface DetectedTree {
	topLevel: Array<{ box: DetectedBox; children: DetectedBox[] }>;
	partial: boolean;
}

// COCO label polish + quality filters (plan 17): friendlier display names,
// drop low-confidence and background-dominant boxes so the tree stays clean.
const LABEL_MAP: Record<string, string> = {
	"dining table": "table",
	"cell phone": "phone",
	"teddy bear": "teddy bear",
	"potted plant": "plant",
	"sports ball": "ball",
	"wine glass": "wine glass",
	"handbag": "bag",
	"backpack": "bag",
	"tv": "screen",
	"laptop": "laptop",
};
const MIN_SCORE = 0.45;
const MAX_AREA_FRACTION = 0.9;

// COCO classes that are meaningful even when small; everything else must
// clear a minimum area so long-tail misfires (straw→"toothbrush") die early.
const SMALL_OK = new Set(["person", "cup", "bottle", "dog", "cat", "bird", "cell phone", "phone"]);
const MIN_AREA = 0.004;

function qualityFilter(boxes: DetectedBox[], _ctx: SegmentationContext): DetectedBox[] {
	void _ctx;
	return boxes
		.map((b) => ({ ...b, label: LABEL_MAP[b.label] ?? b.label }))
		.filter((b) => b.score >= MIN_SCORE)
		.filter((b) => b.w * b.h <= MAX_AREA_FRACTION)
		.filter((b) => b.w * b.h >= MIN_AREA || SMALL_OK.has(b.label));
}

/** Downscale raster input before model calls (≤1024px) to respect model
 * limits; SVG passes through untouched. */
async function prepareModelInput(ctx: SegmentationContext): Promise<{ bytes: ArrayBuffer; mime: string }> {
	if (ctx.mime === "image/svg+xml" || ctx.widthPx === 0) {
		return { bytes: ctx.imageBytes, mime: ctx.mime };
	}
	try {
		const { transformWithImagesBytes } = await import("./operations");
		const longest = Math.max(ctx.widthPx, ctx.heightPx);
		if (longest > 1024) {
			const scaled = await transformWithImagesBytes(ctx.env, ctx.imageBytes, 1024);
			if (scaled) return { bytes: scaled, mime: "image/jpeg" };
		}
	} catch {
		// fall through to the original bytes
	}
	return { bytes: ctx.imageBytes, mime: ctx.mime };
}

/** Detect + hierarchy. Boxes nested inside a person become that person's children. */
export async function runDetection(
	ctx: SegmentationContext,
	onProgress?: (p: number) => Promise<void> | void,
): Promise<DetectedTree> {
	const provider = getProvider(ctx.env);
	const input = await prepareModelInput(ctx);
	const rawBoxes = await provider.detect(input.bytes, input.mime);
	const boxes = dedupeBoxes(qualityFilter(rawBoxes, ctx));
	if (onProgress) await onProgress(25);

	const people = boxes.filter((b) => PERSON_LABELS.has(b.label));
	const others = boxes.filter((b) => !PERSON_LABELS.has(b.label));
	const topLevel: DetectedTree["topLevel"] = [];
	let partial = false;

	for (const person of people) {
		let children: DetectedBox[] = [];
		try {
			// Crop the person region and let the VLM locate head/eyes/mouth
			// inside it (boxes come back relative to the crop — map them back).
			const crop = await cropRegion(ctx, person);
			const rel = await provider.detectFaceDetails(crop.data, crop.mime);
			children = rel.map((b) => ({
				label: b.label,
				x: person.x + b.x * person.w,
				y: person.y + b.y * person.h,
				w: b.w * person.w,
				h: b.h * person.h,
				score: b.score,
			}));
		} catch {
			partial = true;
		}
		topLevel.push({ box: person, children });
		if (onProgress) await onProgress(45);
	}
	for (const box of others) topLevel.push({ box, children: [] });

	// Person backstop (plan 25b): DETR occasionally misses people in unusual
	// poses. If the VLM says there IS a person but DETR found none, ask the
	// VLM where and add an approximate box.
	if (people.length === 0) {
		try {
			const guess = await provider.locatePerson(ctx.imageBytes, ctx.mime);
			if (guess) topLevel.push({ box: guess, children: [] });
		} catch {
			// backstop is best-effort
		}
	}

	// VLM scene inventory (plan 25): semantic bands (sky/water/ground…) that
	// object detectors cannot name. Skip labels already present.
	try {
		const inventory = await provider.sceneInventory(ctx.imageBytes, ctx.mime);
		const known = new Set(
			[...people, ...others].map((b) => b.label.toLowerCase()),
		);
		const bands: Record<string, [number, number]> = {
			top: [0, 0.34],
			middle: [0.33, 0.67],
			bottom: [0.66, 1],
		};
		for (const region of inventory) {
			if (known.has(region.label)) continue;
			// Whitelist: scene words only. "tumbler" style object leaks die here.
			if (!SCENE_WORDS.has(region.label)) continue;
			const [y0, y1] = bands[region.band] ?? [0.33, 0.67];
			topLevel.push({
				box: { label: region.label, x: 0, y: y0, w: 1, h: y1 - y0, score: 0.6 },
				children: [],
			});
			known.add(region.label);
		}
		if (inventory.length > 0 && onProgress) await onProgress(50);
	} catch {
		// inventory is additive; detection continues without it
	}
	return { topLevel, partial };
}

function positionWord(centerX: number, isChild: boolean): string {
	if (isChild) return "within the person's upper region";
	if (centerX < 0.33) return "on the image-left";
	if (centerX > 0.66) return "on the image-right";
	return "at the center of the frame";
}

async function cropRegion(
	ctx: SegmentationContext,
	box: DetectedBox,
): Promise<{ data: ArrayBuffer; mime: string }> {
	if (ctx.mime === "image/svg+xml" || ctx.widthPx === 0) {
		return { data: ctx.imageBytes, mime: ctx.mime };
	}
	// Prefer a true crop via the Images binding; fall back to the full image.
	try {
		const images = ctx.env.IMAGES;
		if (images && typeof images.input === "function") {
			const stream = new Response(ctx.imageBytes).body;
			if (stream) {
				const out = await images
					.input(stream)
					.transform({
						width: Math.max(64, Math.round(box.w * ctx.widthPx)),
						height: Math.max(64, Math.round(box.h * ctx.heightPx)),
						fit: "cover",
					})
					.output({ format: "image/png" });
				const buf = await (out.response() as Response).arrayBuffer();
				return { data: buf, mime: "image/png" };
			}
		}
	} catch {
		// fall through to full-image fallback
	}
	return { data: ctx.imageBytes, mime: ctx.mime };
}

/** Caption every node of the detected tree (children after parents). */
export async function runCaptioning(
	ctx: SegmentationContext,
	tree: DetectedTree,
	onProgress?: (p: number) => Promise<void> | void,
): Promise<{ nodes: CaptionedNode[]; partial: boolean }> {
	const provider = getProvider(ctx.env);
	const nodes: CaptionedNode[] = [];
	let partial = tree.partial;
	let count = 0;

	for (const node of tree.topLevel) {
		nodes.push(await captionNode(node.box, node.children, false));
	}
	// Post-caption merge: DETR often fires overlapping boxes for the same
	// subject (person + couch + "man on couch"). When two top-level regions
	// overlap above IoU 0.6, fold the smaller into the larger and keep its
	// children attached to the survivor.
	const merged: CaptionedNode[] = [];
	for (const node of nodes) {
		const twin = merged.find((m) => iou(m.box, node.box) > 0.5);
		if (twin) {
			twin.children.push(...node.children);
			if (node.box.w * node.box.h > twin.box.w * twin.box.h) twin.box = node.box;
		} else {
			merged.push(node);
		}
	}
	if (onProgress) await onProgress(85);
	return { nodes: merged, partial };

	async function captionNode(
		box: DetectedBox,
		children: DetectedBox[],
		isChild: boolean,
	): Promise<CaptionedNode> {
		const position = positionWord(box.x + box.w / 2, isChild);
		let label = box.label;
		let caption = `A ${box.label} ${position}.`;
		try {
			const crop = await cropRegion(ctx, box);
			const result = await provider.captionRegion(crop.data, crop.mime, box.label, position);
			if (result.label) label = result.label;
			caption = result.caption;
		} catch {
			partial = true;
		}
		count += 1;
		if (onProgress) await onProgress(Math.min(85, 50 + count * 4));
		return {
			box,
			label,
			caption,
			children: await Promise.all(
				children.map((child) => captionNode(child, [], true)),
			),
		};
	}
}

/** Persist the captioned tree; top-level rows are inserted first so children
 * reference real parent ids. Returns the count of stored segments. */
export async function persistSegments(
	ctx: SegmentationContext,
	nodes: CaptionedNode[],
): Promise<number> {
	const db = createDb(ctx.env.DB);
	await db.delete(segments).where(eq(segments.imageId, ctx.imageId));

	let stored = 0;
	let nodeIdCounter = 0;
	for (const node of nodes) {
		stored += await insertNode(ctx, db, node, null, () => nodeIdCounter++);
	}
	return stored;
}

async function insertNode(
	ctx: SegmentationContext,
	db: ReturnType<typeof createDb>,
	node: CaptionedNode,
	parentId: string | null,
	nextOrder: () => number,
): Promise<number> {
	const id = crypto.randomUUID();
	await db.insert(segments).values({
		id,
		imageId: ctx.imageId,
		parentSegmentId: parentId,
		label: node.label,
		caption: node.caption,
		bboxX: node.box.x,
		bboxY: node.box.y,
		bboxW: node.box.w,
		bboxH: node.box.h,
		orderIdx: nextOrder(),
	});
	try {
		const keys = mediaKeys(ctx.userId, ctx.albumId, ctx.imageId);
		const crop = await cropRegion(ctx, node.box);
		await putObject(ctx.env.MEDIA, keys.segmentCrop(id), crop.data, crop.mime);
	} catch {
		// thumbnails are cosmetic; never fail persistence on them
	}
	let count = 1;
	for (const child of node.children) {
		count += await insertNode(ctx, db, child, id, nextOrder);
	}
	return count;
}

export async function markSegmentStatus(
	env: Env,
	imageId: string,
	status: "pending" | "partial" | "ready" | "failed",
): Promise<void> {
	const db = createDb(env.DB);
	const { images } = await import("../../../database/schema");
	await db.update(images).set({ segmentStatus: status }).where(eq(images.id, imageId));
}
