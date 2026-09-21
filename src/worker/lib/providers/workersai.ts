import { imageDimensions } from "../r2";
import {
	type AIProvider,
	type DetectedBox,
	type GeneratedImage,
	type RegionCaption,
	ProviderError,
} from "./types";

/**
 * Workers AI binding implementation. Model IDs come from wrangler vars so they
 * can track the live catalog without code changes. DETR provides boxes; a
 * vision-language model captions crops; flux/schnell-class handles T2I; the
 * instruct LLM powers chat and prompt rewriting.
 *
 * Known limits (until an external provider is attached): masks degrade to
 * feathered boxes, and face details come from a re-detect pass on the person
 * crop rather than a dedicated landmark model.
 */

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export class WorkersAIProvider implements AIProvider {
	constructor(
		private readonly ai: Ai,
		private readonly models: {
			detect: string;
			vlm: string;
			vlmSecondary?: string;
			t2i: string;
			llm: string;
			inpaint: string;
			img2img: string;
			edit?: string;
		},
	) {}

	/** FLUX.2-family models take multipart form data (prompt + base64 image).
	 * Output is a base64 image string or a byte stream. */
	private async runMultipartEdit(
		model: string,
		fields: Record<string, string>,
	): Promise<{ data: ArrayBuffer; mime: string } | null> {
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			form.append(key, value);
		}
		const probe = new Request("https://multipart.local", { method: "POST", body: form });
		const result = await (this.ai as { run: (m: string, input: unknown) => Promise<unknown> }).run(
			model,
			{
				multipart: {
					body: probe.body,
					contentType: probe.headers.get("content-type") || "multipart/form-data",
				},
			},
		);
		if (result && typeof result === "object" && "image" in (result as object)) {
			const b64 = (result as { image: string }).image;
			if (typeof b64 === "string" && b64.length > 0) {
				return { data: base64ToArrayBuffer(b64), mime: "image/png" };
			}
		}
		if (result instanceof ReadableStream) {
			const buf = await new Response(result).arrayBuffer();
			if (buf.byteLength > 0) {
				return { data: buf, mime: sniffPng(buf) ? "image/png" : "image/jpeg" };
			}
		}
		return null;
	}

	/** Secondary VLM (gemma) with automatic fallback to the primary VLM. */
	private async vlmAsk(
		prompt: string,
		image: ArrayBuffer,
		mime: string,
		maxTokens: number,
	): Promise<string | null> {
		const dataUrl = await this.toDataUrl(image, mime);
		const models = [this.models.vlmSecondary, this.models.vlm].filter(Boolean);
		for (const model of models) {
			try {
				const out = (await this.ai.run(model!, {
					prompt,
					image: dataUrl,
					max_tokens: maxTokens,
				})) as { response?: string; description?: string };
				const text = out?.response ?? out?.description ?? "";
				if (text.trim()) return text;
			} catch {
				// try the next VLM in the chain
			}
		}
		return null;
	}

	private async toDataUrl(image: ArrayBuffer, mime: string): Promise<string> {
		if (image.byteLength > MAX_IMAGE_BYTES) {
			throw new ProviderError("Image too large for model input");
		}
		const b64 = arrayBufferToBase64(image);
		return `data:${mime};base64,${b64}`;
	}

	async detect(image: ArrayBuffer, mime: string): Promise<DetectedBox[]> {
		void mime;
		// DETR schema (empirically verified in production 2026-09-20): input is
		// { image: [8-bit ints] }; output is an array of PIXEL-space boxes.
		const bytes = new Uint8Array(image);
		const dims = imageDimensions(image) ?? { width: 1024, height: 1024 };
		const run = (this.ai as { run: (m: string, input: unknown) => Promise<unknown> }).run;
		const out = await run.call(this.ai, this.models.detect, {
			image: Array.from(bytes),
		});
		const items = (Array.isArray(out) ? out : []) as Array<{
			label?: string;
			score?: number;
			box?: { xmin: number; ymin: number; xmax: number; ymax: number };
		}>;
		return items
			.filter((i) => i.box && i.label)
			.map((i) => ({
				label: i.label!.toLowerCase(),
				x: i.box!.xmin / dims.width,
				y: i.box!.ymin / dims.height,
				w: (i.box!.xmax - i.box!.xmin) / dims.width,
				h: (i.box!.ymax - i.box!.ymin) / dims.height,
				score: i.score ?? 0.5,
			}))
			.filter((b) => b.w > 0.01 && b.h > 0.01)
			.sort((a, b) => b.score - a.score)
			.slice(0, 24);
	}

	async detectFaceDetails(
		crop: ArrayBuffer,
		mime: string,
	): Promise<DetectedBox[]> {
		// AI-driven person parts (plan 25): the VLM locates head/eyes/mouth
		// inside the person crop and answers as percentage-box JSON.
		const FALLBACK: DetectedBox[] = [
			{ label: "head", x: 0.25, y: 0.02, w: 0.5, h: 0.36, score: 0.7 },
			{ label: "eyes", x: 0.32, y: 0.14, w: 0.36, h: 0.08, score: 0.6 },
			{ label: "mouth", x: 0.38, y: 0.28, w: 0.24, h: 0.06, score: 0.6 },
		];
		try {
			const text =
				(await this.vlmAsk(
					'Locate the head, eyes, and mouth in this photo of a person. Reply ONLY with JSON: {"head":[x,y,w,h],"eyes":[x,y,w,h],"mouth":[x,y,w,h]} where each value is the box as percentages (0-100) of the image size in order left,top,width,height.',
					crop,
					mime,
					200,
				)) ?? "";
			const json = /\{[\s\S]*\}/.exec(text)?.[0];
			if (!json) return FALLBACK;
			const parsed = JSON.parse(json) as Record<string, number[]>;
			const toBox = (key: string, _fallback: DetectedBox): DetectedBox | null => {
				void _fallback;
				const v = parsed[key];
				if (!Array.isArray(v) || v.length !== 4 || v.some((n) => typeof n !== "number")) return null;
				const [x, y, w, h] = v as [number, number, number, number];
				if ([x, y, w, h].some((n) => n < -5 || n > 105) || w <= 0 || h <= 0) return null;
				const norm = (n: number) => Math.min(1, Math.max(0, n / 100));
				return { label: key, x: norm(x), y: norm(y), w: norm(w), h: norm(h), score: 0.75 };
			};
			const boxes = [
				toBox("head", FALLBACK[0]!),
				toBox("eyes", FALLBACK[1]!),
				toBox("mouth", FALLBACK[2]!),
			].filter((b): b is DetectedBox => b !== null);
			return boxes.length > 0 ? boxes : FALLBACK;
		} catch {
			return FALLBACK;
		}
	}

	async locatePerson(
		image: ArrayBuffer,
		mime: string,
	): Promise<DetectedBox | null> {
		try {
			const dataUrl = await this.toDataUrl(image, mime);
			const out = (await this.ai.run(this.models.vlm, {
				prompt:
					'Is there a person in this photo? If yes, reply ONLY with JSON {"present":true,"box":[left,top,width,height]} where the box is percentages (0-100) of the image covering the whole person. If no person, reply {"present":false}.',
				image: dataUrl,
				max_tokens: 120,
			})) as { response?: string };
			const json = /\{[\s\S]*\}/.exec(out?.response ?? "")?.[0];
			if (!json) return null;
			const parsed = JSON.parse(json) as { present?: boolean; box?: number[] };
			if (!parsed.present || !Array.isArray(parsed.box) || parsed.box.length !== 4) return null;
			const [x, y, w, h] = parsed.box as [number, number, number, number];
			const norm = (n: number) => Math.min(1, Math.max(0, n / 100));
			if (w <= 0 || h <= 0) return null;
			return { label: "person", x: norm(x), y: norm(y), w: norm(w), h: norm(h), score: 0.6 };
		} catch {
			return null;
		}
	}

	async sceneInventory(
		image: ArrayBuffer,
		mime: string,
	): Promise<Array<{ label: string; band: "top" | "middle" | "bottom" }>> {
		try {
			const text =
				(await this.vlmAsk(
					'Identify the major SCENE regions visible in this photo (for example: sky, water, sea, sand, grass, snow, road, floor, wall, foliage). Do NOT list discrete objects like people or furniture. Reply ONLY with JSON: [{"label":"sky","band":"top"},{"label":"water","band":"middle"}] where band is one of "top", "middle", "bottom". Maximum 5 entries.',
					image,
					mime,
					200,
				)) ?? "";
			const json = /\[[\s\S]*\]/.exec(text)?.[0];
			if (!json) return [];
			const parsed = JSON.parse(json) as Array<{ label?: string; band?: string }>;
			const bands = new Set(["top", "middle", "bottom"]);
			return parsed
				.filter((r) => r?.label && r?.band && bands.has(r.band))
				.slice(0, 5)
				.map((r) => ({
					label: String(r.label).toLowerCase().slice(0, 24),
					band: r.band as "top" | "middle" | "bottom",
				}));
		} catch {
			return [];
		}
	}

	async captionRegion(
		crop: ArrayBuffer,
		mime: string,
		hint: string,
		position: string,
	): Promise<RegionCaption> {
		const prompt =
			`Look at the main subject of this image. In one or two sentences, describe exactly ` +
			`what you see (object type, materials, colors, notable parts) and where it is ` +
			`(${position}). If the expected "${hint}" is not actually visible, say what is ` +
			`visible instead. Then on a new last line write exactly: LABEL: <one or two word ` +
			`name for what is shown>.`;
		const text = (await this.vlmAsk(prompt, crop, mime, 200)) ?? "";
		const labelMatch = /LABEL:\s*(.+)/i.exec(text);
		const label = (labelMatch?.[1] ?? hint)
			.trim()
			.toLowerCase()
			.replace(/[.!?\s]+$/, "")
			.slice(0, 32);
		const caption = text
			.replace(/LABEL:.*/i, "")
			.replace(/\s+/g, " ")
			.trim();
		return { label, caption: caption || `A ${hint} ${position}.` };
	}

	async textToImage(
		prompt: string,
		opts: { aspect?: string },
	): Promise<GeneratedImage> {
		const [width, height] = aspectSize(opts.aspect ?? "1:1");
		const result = await this.runImageModel(this.models.t2i, {
			prompt,
			steps: 4,
			width,
			height,
		});
		if (!result) throw new ProviderError("Text-to-image returned no image", true);
		return { ...result, width, height };
	}

	async imageToImage(
		image: ArrayBuffer,
		mime: string,
		prompt: string,
		strength: number,
	): Promise<GeneratedImage> {
		const b64 = (await this.toDataUrl(image, mime)).replace(/^data:[^,]+,/, "");
		// Primary: FLUX.2 klein instruction edit (state-of-the-art editing).
		if (this.models.edit) {
			try {
				const edited = await this.runMultipartEdit(this.models.edit, {
					prompt,
					image: b64,
					strength: strength.toFixed(2),
				});
				if (edited) return { ...edited, width: 1024, height: 1024 };
			} catch {
				// fall through to SDXL-lightning
			}
		}
		const result = await this.runImageModel(this.models.img2img, {
			prompt,
			image_b64: b64,
			strength,
			num_steps: 6,
			guidance: 3,
			width: 1024,
			height: 1024,
		});
		if (!result) throw new ProviderError("Image-to-image returned no image", true);
		return { ...result, width: 1024, height: 1024 };
	}

	async inpaint(
		image: ArrayBuffer,
		mime: string,
		mask: ArrayBuffer | null,
		box: { x: number; y: number; w: number; h: number },
		prompt: string,
		dims?: { width: number; height: number },
	): Promise<GeneratedImage> {
		const width = round8(Math.min(1024, Math.max(256, dims?.width ?? 512)));
		const height = round8(Math.min(1024, Math.max(256, dims?.height ?? 512)));

		// Primary path: FLUX.2 klein instruction edit — it follows prompts far
		// better than SD-v1.5 inpainting, whose masked output was often
		// indistinguishable from the input. The preservation clause keeps the
		// rest of the photograph stable.
		if (this.models.edit) {
			try {
				const b64 = (await this.toDataUrl(image, mime)).replace(/^data:[^,]+,/, "");
				const edited = await this.runMultipartEdit(this.models.edit, {
					prompt: `${prompt}. Edit only the region described; keep the person, ` +
						`animals, background, lighting, and composition otherwise exactly unchanged.`,
					image: b64,
					width: String(width),
					height: String(height),
				});
				if (edited) return { ...edited, width, height };
			} catch {
				// fall through to the mask model
			}
		}

		if (mask) {
			const dataUrl = (await this.toDataUrl(image, mime)).replace(/^data:[^,]+,/, "");
			const result = await this.runImageModel(this.models.inpaint, {
				prompt,
				image_b64: dataUrl.replace(/^data:[^,]+,/, ""),
				mask: Array.from(new Uint8Array(mask)),
				strength: 1.0,
				num_steps: 12,
				guidance: 7.5,
				width,
				height,
			});
			if (result) {
				return { ...result, width, height };
			}
		}
		// Fallback: whole-frame img2img constrained by low strength.
		return this.imageToImage(image, mime, prompt, 0.5);
		void box;
	}

	async upscale(
		image: ArrayBuffer,
		mime: string,
		factor: number,
	): Promise<GeneratedImage> {
		// Detail pass at low strength approximates the "professional camera"
		// enhancement; a dedicated upscaler can attach via an external provider.
		const out = await this.imageToImage(
			image,
			mime,
			"ultra high resolution professional photograph, crisp fine detail, sharp focus, natural depth of field",
			0.25,
		);
		void factor;
		return out;
	}

	async rewritePrompt(
		text: string,
		operation: string,
		context: string,
	): Promise<string> {
		const result = (await this.ai.run(this.models.llm, {
			messages: [
				{
					role: "system",
					content:
						"Rewrite the user's request as one vivid image-generation prompt: subject, then attributes, then placement, then style. No preamble.",
				},
				{ role: "user", content: `Operation: ${operation}\nContext: ${context}\nRequest: ${text}` },
			],
			max_tokens: 160,
		})) as { response?: string };
		return result.response?.trim() || text;
	}

	async streamChat(
		messages: Array<{ role: string; content: string }>,
	): Promise<ReadableStream<string>> {
		const result = await this.ai.run(this.models.llm, {
			messages,
			max_tokens: 500,
			stream: true,
		});
		const source = result as unknown as ReadableStream<Uint8Array>;
		return source.pipeThrough(
			new TransformStream<Uint8Array, string>({
				transform(chunk, controller) {
					const text = new TextDecoder().decode(chunk);
					for (const line of text.split("\n")) {
						if (line.startsWith("data:")) {
							const payload = line.slice(5).trim();
							if (payload && payload !== "[DONE]") {
								try {
									const evt = JSON.parse(payload);
									if (evt.response) controller.enqueue(evt.response as string);
								} catch {
									// partial SSE frame; the next chunk completes it
								}
							}
						}
					}
				},
			}),
		);
	}

	async moderateImage(image: ArrayBuffer, mime: string): Promise<string | null> {
		// Best-effort: ask the VLM a safety question; treat affirmative as a flag.
		try {
			const answer =
				(await this.vlmAsk(
					"Does this image contain explicit nudity, graphic violence, or other clearly unsafe content? Answer only YES or NO.",
					image,
					mime,
					8,
				)) ?? "";
			return /yes/i.test(answer) ? "unsafe-content" : null;
		} catch {
			return null;
		}
	}

/** Run an image model and normalize the many output shapes Workers AI uses:
 * { image: base64 }, an array of ints, or a ReadableStream of PNG bytes. */
	private async runImageModel(
		model: string,
		input: Record<string, unknown>,
	): Promise<{ data: ArrayBuffer; mime: string } | null> {
		const out: unknown = await this.ai.run(model, input as never);
		// Shape 1: { image: base64 }
		if (out && typeof out === "object" && "image" in out) {
			const b64 = (out as { image: string }).image;
			if (typeof b64 === "string" && b64.length > 0) {
				return { data: base64ToArrayBuffer(b64), mime: "image/png" };
			}
		}
		// Shape 2: ReadableStream of image bytes
		if (out instanceof ReadableStream) {
			const buf = await new Response(out).arrayBuffer();
			if (buf.byteLength > 0) {
				return { data: buf, mime: sniffPng(buf) ? "image/png" : "image/jpeg" };
			}
		}
		// Shape 3: array of ints
		if (Array.isArray(out) && out.length > 0 && typeof out[0] === "number") {
			return {
				data: new Uint8Array(out as number[]).buffer as ArrayBuffer,
				mime: "image/png",
			};
		}
		return null;
	}
}


function round8(n: number): number {
	return Math.max(256, Math.round(n / 8) * 8);
}

function aspectSize(aspect: string): [number, number] {
	switch (aspect) {
		case "16:9":
			return [1024, 576];
		case "9:16":
			return [576, 1024];
		case "4:3":
			return [1024, 768];
		default:
			return [1024, 1024];
	}
}

function sniffPng(bytes: ArrayBuffer): boolean {
	return new DataView(bytes).getUint32(0) === 0x89504e47;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}
