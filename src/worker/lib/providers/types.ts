/**
 * Provider abstraction for every AI capability Editorium uses. The v1 binding
 * is Workers AI; heavier models (SAM-class masks, 4K upscale) can attach an
 * external provider behind the same interface without touching product code.
 */

export interface DetectedBox {
	label: string;
	/** Normalized 0..1 coordinates relative to the full image. */
	x: number;
	y: number;
	w: number;
	h: number;
	score: number;
}

export interface RegionCaption {
	label: string;
	caption: string;
}

export interface GeneratedImage {
	data: ArrayBuffer;
	mime: string;
	width: number;
	height: number;
}

export interface AIProvider {
	/** Detect salient objects: boxes + class labels. */
	detect(image: ArrayBuffer, mime: string): Promise<DetectedBox[]>;

	/** Person backstop: when the detector finds no person but the VLM sees
	 * one, return an approximate normalized box (null if truly no person). */
	locatePerson(
		image: ArrayBuffer,
		mime: string,
	): Promise<DetectedBox | null>;

	/** VLM scene inventory: semantic regions (sky/water/ground/foliage…) with
	 * their vertical band — regions object detectors cannot name. */
	sceneInventory(
		image: ArrayBuffer,
		mime: string,
	): Promise<Array<{ label: string; band: "top" | "middle" | "bottom" }>>;

	/** Estimate head/eyes/mouth boxes INSIDE a person crop; boxes are relative
	 * to the crop (0..1). AI-driven per the user requirement — no hardcoding. */
	detectFaceDetails(
		crop: ArrayBuffer,
		mime: string,
	): Promise<DetectedBox[]>;

	/** Write a clean label + 1-2 sentence caption for a cropped region. */
	captionRegion(
		crop: ArrayBuffer,
		mime: string,
		hint: string,
		position: string,
	): Promise<RegionCaption>;

	/** Text-to-image generation. */
	textToImage(
		prompt: string,
		opts: { aspect?: string },
	): Promise<GeneratedImage>;

	/**
	 * Edit guided by a reference photo (phase 4). The reference must already
	 * be downscaled to fit REFERENCE_MAX_PX (FLUX.2's input limit); the
	 * provider MUST condition on it — never fall back to text-only generation.
	 * `dims` is the aspect-preserving output size (see editDims).
	 */
	editWithReference(
		reference: { bytes: ArrayBuffer; mime: string },
		prompt: string,
		dims: { width: number; height: number },
	): Promise<GeneratedImage & { model: string }>;

	/** Rewrite casual user text into a structured generation prompt. */
	rewritePrompt(
		text: string,
		operation: string,
		context: string,
	): Promise<string>;

	/** Chat completion with streaming text deltas. */
	streamChat(
		messages: Array<{ role: string; content: string }>,
	): Promise<ReadableStream<string>>;
}

/**
 * Output size for image-edit models: preserve the source aspect ratio, fit the
 * longest side to `maxSide`, round to multiples of 16 (diffusion latents),
 * clamp each side to [256, maxSide]. The old code clamped width and height
 * independently, turning every large photo into a 1024x1024 square.
 */
export function editDims(
	width: number,
	height: number,
	maxSide = 1024,
): { width: number; height: number } {
	const w = width > 0 ? width : maxSide;
	const h = height > 0 ? height : maxSide;
	const scale = maxSide / Math.max(w, h);
	const snap = (n: number) => Math.min(maxSide, Math.max(256, Math.round((n * scale) / 16) * 16));
	return { width: snap(w), height: snap(h) };
}

/** FLUX.2 reference images must be smaller than 512×512 (Workers AI docs). */
export const REFERENCE_MAX_PX = 511;

/** Reference size: fit inside REFERENCE_MAX_PX, aspect preserved. */
export function referenceDims(width: number, height: number): { width: number; height: number } {
	const scale = Math.min(1, REFERENCE_MAX_PX / Math.max(width, height));
	return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** Pruna P-Image-Edit only accepts these ratios; pick the closest. */
export const PRUNA_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;

export function closestAspect(width: number, height: number): (typeof PRUNA_ASPECTS)[number] {
	if (!(width > 0 && height > 0)) return "1:1";
	const target = Math.log(width / height);
	let best: (typeof PRUNA_ASPECTS)[number] = "1:1";
	let bestDiff = Infinity;
	for (const aspect of PRUNA_ASPECTS) {
		const [a, b] = aspect.split(":").map(Number) as [number, number];
		const diff = Math.abs(Math.log(a / b) - target);
		if (diff < bestDiff) {
			bestDiff = diff;
			best = aspect;
		}
	}
	return best;
}


export class ProviderError extends Error {
	constructor(
		message: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "ProviderError";
	}
}
