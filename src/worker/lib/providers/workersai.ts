import { sniffMime } from "../r2";
import {
	type AIProvider,
	type DetectedBox,
	type GeneratedImage,
	type RegionCaption,
	ProviderError,
} from "./types";

/**
 * Workers AI binding implementation. Model IDs come from wrangler vars so they
 * can track the live catalog without code changes. Moondream discovers
 * objects; a vision-language model captions crops; FLUX/SDXL handle edits;
 * the instruct LLM powers chat and prompt rewriting.
 *
 * Known limits (until an external provider is attached): no bound model does
 * pixel-local masked inpainting, and face details come from a VLM pass on the
 * person crop rather than a dedicated landmark model.
 */

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

type RunnableAi = { run: (model: string, input: unknown) => Promise<unknown> };

function warn(message: string, error: unknown, extra: Record<string, unknown> = {}): void {
	console.warn(
		JSON.stringify({ message, error: error instanceof Error ? error.message : String(error), ...extra }),
	);
}

/** Moondream `detect` boxes are normalized CORNERS ({x_min,y_min,x_max,y_max}
 * or the same four numbers as an array). The old heuristic read small corner
 * values as width/height, producing wrong boxes. */
export function normalizeMoondreamBox(o: unknown, label: string): DetectedBox | null {
	let nums: unknown[];
	if (Array.isArray(o)) {
		nums = o;
	} else if (o && typeof o === "object") {
		const rec = o as Record<string, unknown>;
		nums = [rec.x_min ?? rec.xmin, rec.y_min ?? rec.ymin, rec.x_max ?? rec.xmax, rec.y_max ?? rec.ymax];
	} else {
		return null;
	}
	const four = nums.slice(0, 4);
	if (four.length < 4 || four.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
	const clamp = (n: number) => Math.min(1, Math.max(0, n));
	const [x0, y0, x1, y1] = (four as number[]).map(clamp) as [number, number, number, number];
	if (x1 <= x0 || y1 <= y0) return null;
	return { label, x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: 0.8 };
}

/**
 * Normalize the image output shapes Workers AI models use —
 * `{ image: base64 | data-URL }`, `{ result: { image } }` (Pruna), a byte
 * stream, or an int array — into bytes with a SNIFFED mime type.
 */
export async function decodeImageOutput(
	out: unknown,
): Promise<{ data: ArrayBuffer; mime: string } | null> {
	let data: ArrayBuffer | null = null;
	if (out instanceof ReadableStream) {
		data = await new Response(out).arrayBuffer();
	} else if (Array.isArray(out) && out.length > 0 && typeof out[0] === "number") {
		data = new Uint8Array(out as number[]).buffer as ArrayBuffer;
	} else if (out && typeof out === "object") {
		const rec = out as { image?: unknown; result?: { image?: unknown } };
		const image = typeof rec.image === "string" ? rec.image : rec.result?.image;
		if (typeof image === "string" && image.length > 0) {
			data = base64ToArrayBuffer(image.replace(/^data:[^,]*,/, ""));
		}
	}
	if (!data || data.byteLength === 0) return null;
	const mime = sniffMime(data);
	return mime ? { data, mime } : null;
}

/** SSE → text deltas. Buffers partial lines across chunks and decodes UTF-8
 * in streaming mode (the old parser dropped any frame split between chunks
 * and could corrupt multi-byte characters). */
export function sseDeltaStream(): TransformStream<Uint8Array, string> {
	const decoder = new TextDecoder();
	let buffer = "";
	const emit = (line: string, controller: TransformStreamDefaultController<string>) => {
		if (!line.startsWith("data:")) return;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") return;
		try {
			const evt = JSON.parse(payload) as {
				response?: string;
				choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
			};
			// OpenAI-style (GLM): choices[0].delta.content; Workers AI style: response
			const delta =
				evt.choices?.[0]?.delta?.content ?? evt.choices?.[0]?.message?.content ?? evt.response ?? "";
			if (delta) controller.enqueue(delta);
		} catch (error) {
			warn("sse_frame_unparseable", error);
		}
	};
	return new TransformStream<Uint8Array, string>({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) emit(line.trimEnd(), controller);
		},
		flush(controller) {
			buffer += decoder.decode();
			if (buffer) emit(buffer.trimEnd(), controller);
		},
	});
}

/**
 * FLUX.2 reference-edit request (Workers AI docs + live catalog, 2026-09-25):
 * multipart form, reference image as a BINARY field named `input_image_0`,
 * smaller than 512×512. The old code sent a base64 string named `image`,
 * which the model silently ignored — every "edit" was text-to-image.
 */
export function buildFluxEditForm(
	reference: { bytes: ArrayBuffer; mime: string },
	prompt: string,
	dims: { width: number; height: number },
): FormData {
	const form = new FormData();
	form.append("prompt", prompt);
	form.append("input_image_0", new Blob([reference.bytes], { type: reference.mime }), "reference");
	form.append("width", String(dims.width));
	form.append("height", String(dims.height));
	return form;
}

export class WorkersAIProvider implements AIProvider {
	private readonly run: RunnableAi["run"];

	constructor(
		ai: Ai,
		private readonly models: {
			moondream: string;
			vlm: string;
			vlmSecondary?: string;
			t2i: string;
			llm: string;
			edit?: string;
		},
	) {
		const runnable = ai as unknown as RunnableAi;
		this.run = (model, input) => runnable.run(model, input);
	}

	/** Vision ask: tries each VLM in the chain (GLM first, then llama-vision)
	 * with both the multimodal content-parts and flat-prompt input shapes. */
	private async vlmAsk(
		prompt: string,
		image: ArrayBuffer,
		mime: string,
		maxTokens: number,
	): Promise<string | null> {
		const dataUrl = this.toDataUrl(image, mime);
		const models = [this.models.vlmSecondary, this.models.vlm].filter((m): m is string => !!m);
		for (const model of models) {
			const attempts: Array<Record<string, unknown>> = [
				{
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: prompt },
								{ type: "image_url", image_url: { url: dataUrl } },
							],
						},
					],
					max_tokens: Math.max(maxTokens, 1500),
				},
				{ prompt, image: dataUrl, max_tokens: Math.max(maxTokens, 1500) },
			];
			for (const input of attempts) {
				try {
					const out = (await this.run(model, input)) as {
						response?: string;
						description?: string;
						choices?: Array<{ message?: { content?: string } }>;
					};
					const text =
						out.response?.trim() ||
						out.description?.trim() ||
						out.choices?.[0]?.message?.content?.trim() ||
						"";
					if (text) return text;
				} catch (error) {
					warn("vlm_attempt_failed", error, { model });
				}
			}
		}
		return null;
	}

	private toDataUrl(image: ArrayBuffer, mime: string): string {
		if (image.byteLength > MAX_IMAGE_BYTES) {
			throw new ProviderError("Image too large for model input");
		}
		return `data:${mime};base64,${arrayBufferToBase64(image)}`;
	}

	async detect(image: ArrayBuffer, mime: string): Promise<DetectedBox[]> {
		const dataUrl = this.toDataUrl(image, mime);
		// Moondream-only detection (user decision, 2026-09-21): discover names
		// with task=query, then box each with task=detect (which returns empty
		// platform-side until Cloudflare fixes it).
		const names = await this.moondreamNames(dataUrl);
		const boxes: DetectedBox[] = [];
		for (const name of names.slice(0, 12)) {
			boxes.push(...(await this.moondreamDetectBoxes(dataUrl, name)));
		}
		return boxes.filter((b) => b.w > 0.01 && b.h > 0.01).sort((a, b) => b.score - a.score);
	}

	/** Collect the full text of a Moondream SSE stream. */
	private async moondreamStreamText(input: unknown): Promise<string> {
		const out = await this.run(this.models.moondream, input);
		if (!(out instanceof ReadableStream)) {
			return typeof out === "string" ? out : JSON.stringify(out);
		}
		return await new Response(out).text();
	}

	private static sseJson(buf: string): unknown[] {
		const frames: unknown[] = [];
		for (const line of buf.split("\n")) {
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (!payload || payload === "[DONE]") continue;
			try {
				frames.push(JSON.parse(payload));
			} catch {
				// non-JSON keepalive frame
			}
		}
		return frames;
	}

	/** task=query → JSON array of visible object names. */
	private async moondreamNames(dataUrl: string): Promise<string[]> {
		try {
			const buf = await this.moondreamStreamText({
				task: "query",
				image: dataUrl,
				question:
					'List every visible object in this image as a short JSON array of names, e.g. ["man","dog","couch"].',
			});
			let answer = "";
			for (const frame of WorkersAIProvider.sseJson(buf)) {
				const chunk = frame as { answer?: string };
				if (chunk.answer) answer = chunk.answer;
			}
			const parsed = JSON.parse(answer) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed
				.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
				.map((n) => n.trim().toLowerCase().slice(0, 32));
		} catch (error) {
			warn("moondream_query_failed", error);
			return [];
		}
	}

	/** task=detect → boxes for one named object. */
	private async moondreamDetectBoxes(dataUrl: string, name: string): Promise<DetectedBox[]> {
		try {
			const buf = await this.moondreamStreamText({ task: "detect", image: dataUrl, question: name });
			let objects: unknown = null;
			for (const frame of WorkersAIProvider.sseJson(buf)) {
				const chunk = frame as { objects?: unknown };
				if (chunk.objects) objects = chunk.objects;
			}
			if (!Array.isArray(objects)) return [];
			return objects
				.map((o) => normalizeMoondreamBox(o, name))
				.filter((b): b is DetectedBox => b !== null);
		} catch (error) {
			warn("moondream_detect_failed", error, { name });
			return [];
		}
	}

	async detectFaceDetails(crop: ArrayBuffer, mime: string): Promise<DetectedBox[]> {
		// AI-driven person parts (plan 25): the VLM locates head/eyes/mouth
		// inside the person crop. With no usable answer we return nothing —
		// never canned boxes presented as if a model had found them.
		try {
			const text =
				(await this.vlmAsk(
					'Locate the head, eyes, and mouth in this photo of a person. Reply ONLY with JSON: {"head":[x,y,w,h],"eyes":[x,y,w,h],"mouth":[x,y,w,h]} where each value is the box as percentages (0-100) of the image size in order left,top,width,height.',
					crop,
					mime,
					200,
				)) ?? "";
			const json = /\{[\s\S]*\}/.exec(text)?.[0];
			if (!json) return [];
			const parsed = JSON.parse(json) as Record<string, unknown>;
			const toBox = (key: string): DetectedBox | null => {
				const v = parsed[key];
				if (!Array.isArray(v) || v.length !== 4 || v.some((n) => typeof n !== "number")) return null;
				const [x, y, w, h] = v as [number, number, number, number];
				if ([x, y, w, h].some((n) => n < -5 || n > 105) || w <= 0 || h <= 0) return null;
				const norm = (n: number) => Math.min(1, Math.max(0, n / 100));
				return { label: key, x: norm(x), y: norm(y), w: norm(w), h: norm(h), score: 0.75 };
			};
			return [toBox("head"), toBox("eyes"), toBox("mouth")].filter(
				(b): b is DetectedBox => b !== null,
			);
		} catch (error) {
			warn("face_details_failed", error);
			return [];
		}
	}

	async locatePerson(image: ArrayBuffer, mime: string): Promise<DetectedBox | null> {
		try {
			const out = (await this.run(this.models.vlm, {
				prompt:
					'Is there a person in this photo? If yes, reply ONLY with JSON {"present":true,"box":[left,top,width,height]} where the box is percentages (0-100) of the image covering the whole person. If no person, reply {"present":false}.',
				image: this.toDataUrl(image, mime),
				max_tokens: 1500,
			})) as { response?: string; choices?: Array<{ message?: { content?: string } }> };
			const raw = out?.response ?? out?.choices?.[0]?.message?.content ?? "";
			const json = /\{[\s\S]*\}/.exec(raw)?.[0];
			if (!json) return null;
			const parsed = JSON.parse(json) as { present?: boolean; box?: unknown };
			if (!parsed.present || !Array.isArray(parsed.box) || parsed.box.length !== 4) return null;
			const [x, y, w, h] = parsed.box as [number, number, number, number];
			const norm = (n: number) => Math.min(1, Math.max(0, n / 100));
			if (!(w > 0 && h > 0)) return null;
			return { label: "person", x: norm(x), y: norm(y), w: norm(w), h: norm(h), score: 0.6 };
		} catch (error) {
			warn("locate_person_failed", error);
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
		} catch (error) {
			warn("scene_inventory_failed", error);
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

	async textToImage(prompt: string, opts: { aspect?: string }): Promise<GeneratedImage> {
		const [width, height] = aspectSize(opts.aspect ?? "1:1");
		const result = await this.runImageModel(this.models.t2i, { prompt, steps: 4, width, height });
		if (!result) throw new ProviderError("Text-to-image returned no image", true);
		return { ...result, width, height };
	}

	async editWithReference(
		reference: { bytes: ArrayBuffer; mime: string },
		prompt: string,
		dims: { width: number; height: number },
	): Promise<GeneratedImage & { model: string }> {
		const model = this.models.edit;
		if (!model) throw new ProviderError("No reference-edit model configured");
		const form = buildFluxEditForm(reference, prompt, dims);
		const request = new Request("https://multipart.local", { method: "POST", body: form });
		const out = await this.run(model, {
			multipart: {
				body: request.body,
				contentType: request.headers.get("content-type") || "multipart/form-data",
			},
		});
		const decoded = await decodeImageOutput(out);
		// No fallback to a model that would ignore the photo: fail and refund.
		if (!decoded) throw new ProviderError("Edit model returned no image", true);
		return { ...decoded, ...dims, model };
	}

	async rewritePrompt(text: string, operation: string, context: string): Promise<string> {
		const result = (await this.run(this.models.llm, {
			messages: [
				{
					role: "system",
					content:
						"Rewrite the user's request as one vivid image-generation prompt: subject, then attributes, then placement, then style. Reply with the prompt only.",
				},
				{ role: "user", content: `Operation: ${operation}\nContext: ${context}\nRequest: ${text}` },
			],
			max_tokens: 400,
		})) as { response?: string; choices?: Array<{ message?: { content?: string } }> };
		const out = result.response?.trim() || result.choices?.[0]?.message?.content?.trim() || "";
		return out || text;
	}

	async streamChat(messages: Array<{ role: string; content: string }>): Promise<ReadableStream<string>> {
		const result = await this.run(this.models.llm, { messages, max_tokens: 3000, stream: true });
		if (!(result instanceof ReadableStream)) {
			throw new ProviderError("Chat model did not return a stream", true);
		}
		return (result as ReadableStream<Uint8Array>).pipeThrough(sseDeltaStream());
	}

	private async runImageModel(
		model: string,
		input: Record<string, unknown>,
	): Promise<{ data: ArrayBuffer; mime: string } | null> {
		return decodeImageOutput(await this.run(model, input));
	}
}

function aspectSize(aspect: string): [number, number] {
	switch (aspect) {
		case "16:9":
			return [1024, 576];
		case "9:16":
			return [576, 1024];
		case "4:3":
			return [1024, 768];
		case "3:4":
			return [768, 1024];
		default:
			return [1024, 1024];
	}
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
