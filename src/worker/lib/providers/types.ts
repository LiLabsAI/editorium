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

export type ReferenceMode = "literal" | "balanced" | "creative";

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

	/** Image-to-image edit constrained by strength (reference mode). */
	imageToImage(
		image: ArrayBuffer,
		mime: string,
		prompt: string,
		strength: number,
	): Promise<GeneratedImage>;

	/** Inpaint a masked region of the image from a prompt. */
	inpaint(
		image: ArrayBuffer,
		mime: string,
		mask: ArrayBuffer | null,
		box: { x: number; y: number; w: number; h: number },
		prompt: string,
		dims?: { width: number; height: number },
	): Promise<GeneratedImage>;

	/** Upscale + detail enhance ("4k professional camera" flow). */
	upscale(
		image: ArrayBuffer,
		mime: string,
		factor: number,
	): Promise<GeneratedImage>;

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

	/** Best-effort safety check for uploads. Returns violation label or null. */
	moderateImage(image: ArrayBuffer, mime: string): Promise<string | null>;
}

export const MODE_STRENGTH: Record<ReferenceMode, number> = {
	literal: 0.85,
	balanced: 0.6,
	creative: 0.35,
};

export class ProviderError extends Error {
	constructor(
		message: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "ProviderError";
	}
}
