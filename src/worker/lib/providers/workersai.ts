import { IMAGES_INPUT_MAX_BYTES, MAX_MODEL_INPUT_BYTES } from "../config";
import { imageDimensions, sniffMime } from "../r2";
import {
	aspectSize,
	type AIProvider,
	type DetectedBox,
	type GeneratedImage,
	type IntentClassification,
	type RegionCaption,
	ProviderError,
} from "./types";

/**
 * Workers AI binding implementation.
 * Model IDs come from wrangler.json `vars` so they track the live catalog:
 * - Moondream 3.1 (task=query + task=detect with `target`) + DETR fallback for boxes
 * - Llama 3.2 Vision & Gemma 4 26B A4B for VLM reasoning/captioning
 * - Pruna P-Image-Edit (primary) + FLUX.2 Klein 9B (reference/local/multi-image)
 * - FLUX.2 Klein 4B / FLUX.1 Schnell for T2I
 * - GLM-4.7-Flash for chat + Llama 3.3 70B FP8 Fast for structured intent routing
 */

type RunnableAi = { run: (model: string, input: unknown) => Promise<unknown> };

const PRUNA_FETCH_TIMEOUT_MS = 25_000;

function warn(message: string, error: unknown, extra: Record<string, unknown> = {}): void {
	console.warn(
		JSON.stringify({ message, error: error instanceof Error ? error.message : String(error), ...extra }),
	);
}

/** Extract the first balanced JSON object `{...}` or array `[...]` from LLM prose. */
export function extractJsonSubstring(text: string, openChar: "{" | "["): string | null {
	const closeChar = openChar === "{" ? "}" : "]";
	const start = text.indexOf(openChar);
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && inString) {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === openChar) depth++;
		else if (ch === closeChar) {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/** Moondream `detect` boxes are normalized CORNERS ({x_min,y_min,x_max,y_max}
 * or the same four numbers as an array). */
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
 * Normalize Workers AI image outputs — `{ image: base64 | data-URL }`,
 * `{ result: { image: https://... | data-URL } }` (Pruna), byte stream,
 * `Uint8Array`/`ArrayBuffer`, or int array — into bytes with a SNIFFED mime type.
 */
export async function decodeImageOutput(
	out: unknown,
): Promise<{ data: ArrayBuffer; mime: string } | null> {
	let data: ArrayBuffer | null = null;
	if (out instanceof ReadableStream) {
		data = await new Response(out).arrayBuffer();
	} else if (out instanceof ArrayBuffer) {
		data = out;
	} else if (ArrayBuffer.isView(out)) {
		data = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
	} else if (Array.isArray(out) && out.length > 0 && typeof out[0] === "number") {
		data = new Uint8Array(out as number[]).buffer as ArrayBuffer;
	} else if (out && typeof out === "object") {
		const rec = out as { image?: unknown; result?: { image?: unknown } };
		const image = typeof rec.image === "string" ? rec.image : rec.result?.image;
		if (typeof image === "string" && image.length > 0) {
			if (/^https:\/\//i.test(image)) {
				data = await fetchRemoteImage(image);
			} else {
				try {
					data = base64ToArrayBuffer(image.replace(/^data:[^,]*,/, ""));
				} catch {
					data = null;
				}
			}
		}
	}
	if (!data || data.byteLength === 0) return null;
	const mime = sniffMime(data);
	return mime ? { data, mime } : null;
}

async function fetchRemoteImage(url: string): Promise<ArrayBuffer | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(PRUNA_FETCH_TIMEOUT_MS) });
		if (!res.ok) return null;
		const len = Number(res.headers.get("Content-Length") ?? 0);
		if (Number.isFinite(len) && len > IMAGES_INPUT_MAX_BYTES) return null;
		const buf = await res.arrayBuffer();
		return buf.byteLength <= IMAGES_INPUT_MAX_BYTES ? buf : null;
	} catch (error) {
		warn("remote_image_fetch_failed", error);
		return null;
	}
}

/** SSE -> text deltas. Buffers partial lines across chunks and decodes UTF-8
 * in streaming mode. */
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
 * FLUX.2 reference-edit request: multipart form, primary reference as BINARY
 * `input_image_0` (< 512×512) + optional extra references `input_image_1..3`.
 */
export function buildFluxEditForm(
	reference: { bytes: ArrayBuffer; mime: string },
	prompt: string,
	dims: { width: number; height: number },
	extraReferences: Array<{ bytes: ArrayBuffer; mime: string }> = [],
): FormData {
	const form = new FormData();
	form.append("prompt", prompt);
	form.append("input_image_0", new Blob([reference.bytes], { type: reference.mime }), "reference");
	extraReferences.slice(0, 3).forEach((extra, idx) => {
		form.append(`input_image_${idx + 1}`, new Blob([extra.bytes], { type: extra.mime }), `ref_${idx + 1}`);
	});
	form.append("width", String(dims.width));
	form.append("height", String(dims.height));
	return form;
}

export interface WorkersAIModelMap {
	moondream: string;
	detr?: string;
	vlm: string;
	vlmSecondary?: string;
	t2i: string;
	llm: string;
	router?: string;
	edit?: string;
	editPrimary?: string;
}

export class WorkersAIProvider implements AIProvider {
	private readonly run: RunnableAi["run"];

	constructor(
		ai: Ai,
		private readonly models: WorkersAIModelMap,
	) {
		const runnable = ai as unknown as RunnableAi;
		this.run = (model, input) => runnable.run(model, input);
	}

	/** Vision ask: tries primary VLM + secondary VLM (with thinking disabled on
	 * reasoning models) across multimodal messages and flat prompt inputs. */
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
					max_tokens: Math.max(maxTokens, 1000),
					...(model.includes("gemma-4") ? { chat_template_kwargs: { enable_thinking: false } } : {}),
				},
				{ prompt, image: dataUrl, max_tokens: Math.max(maxTokens, 1000) },
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
		if (image.byteLength > MAX_MODEL_INPUT_BYTES) {
			throw new ProviderError("Image too large for model input");
		}
		return `data:${mime};base64,${arrayBufferToBase64(image)}`;
	}

	async detect(image: ArrayBuffer, mime: string): Promise<DetectedBox[]> {
		const dataUrl = this.toDataUrl(image, mime);
		const boxes: DetectedBox[] = [];

		if (this.models.moondream) {
			const names = await this.moondreamNames(dataUrl);
			for (const name of names.slice(0, 12)) {
				boxes.push(...(await this.moondreamDetectBoxes(dataUrl, name)));
			}
		}

		if (boxes.length === 0 && this.models.detr) {
			boxes.push(...(await this.detrDetect(image)));
		}

		return boxes.filter((b) => b.w > 0.01 && b.h > 0.01).sort((a, b) => b.score - a.score);
	}

	private async detrDetect(image: ArrayBuffer): Promise<DetectedBox[]> {
		if (!this.models.detr) return [];
		try {
			const dims = imageDimensions(image);
			if (!dims) return [];
			const out = (await this.run(this.models.detr, {
				image: Array.from(new Uint8Array(image)),
			})) as Array<{
				score?: number;
				label?: string;
				box?: { xmin?: number; ymin?: number; xmax?: number; ymax?: number };
			}>;
			if (!Array.isArray(out)) return [];
			const boxes: DetectedBox[] = [];
			for (const item of out) {
				if (!item?.box || typeof item.label !== "string" || typeof item.score !== "number") continue;
				const x0 = Math.min(1, Math.max(0, (item.box.xmin ?? 0) / dims.width));
				const y0 = Math.min(1, Math.max(0, (item.box.ymin ?? 0) / dims.height));
				const x1 = Math.min(1, Math.max(0, (item.box.xmax ?? 0) / dims.width));
				const y1 = Math.min(1, Math.max(0, (item.box.ymax ?? 0) / dims.height));
				if (x1 > x0 && y1 > y0) {
					boxes.push({ label: item.label.toLowerCase(), x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: item.score });
				}
			}
			return boxes;
		} catch (error) {
			warn("detr_detect_failed", error);
			return [];
		}
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

	/** task=query -> JSON array of visible object names (supports plain JSON and SSE). */
	private async moondreamNames(dataUrl: string): Promise<string[]> {
		try {
			const out = await this.run(this.models.moondream, {
				task: "query",
				image: dataUrl,
				reasoning: false,
				question:
					'List every visible object in this image as a short JSON array of names, e.g. ["man","dog","couch"].',
			});
			let answer = "";
			if (out instanceof ReadableStream) {
				const buf = await new Response(out).text();
				for (const frame of WorkersAIProvider.sseJson(buf)) {
					const chunk = frame as { answer?: string };
					if (chunk.answer) answer = chunk.answer;
				}
				if (!answer && buf.trim().startsWith("{")) {
					const parsedObj = JSON.parse(buf) as { answer?: string };
					answer = parsedObj.answer ?? "";
				}
			} else if (out && typeof out === "object") {
				answer = String((out as { answer?: unknown }).answer ?? "");
			} else if (typeof out === "string") {
				answer = out;
			}
			const arrText = extractJsonSubstring(answer, "[");
			if (!arrText) return [];
			const parsed = JSON.parse(arrText) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed
				.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
				.map((n) => n.trim().toLowerCase().slice(0, 32));
		} catch (error) {
			warn("moondream_query_failed", error);
			return [];
		}
	}

	/** task=detect -> boxes for one named object using `target` param & JSON output. */
	private async moondreamDetectBoxes(dataUrl: string, name: string): Promise<DetectedBox[]> {
		try {
			const out = await this.run(this.models.moondream, {
				task: "detect",
				image: dataUrl,
				target: name,
			});
			let objects: unknown = null;
			if (out instanceof ReadableStream) {
				const buf = await new Response(out).text();
				const frames = WorkersAIProvider.sseJson(buf);
				if (frames.length > 0) {
					for (const frame of frames) {
						const chunk = frame as { objects?: unknown };
						if (chunk.objects) objects = chunk.objects;
					}
				} else if (buf.trim().startsWith("{")) {
					objects = (JSON.parse(buf) as { objects?: unknown }).objects ?? null;
				}
			} else if (out && typeof out === "object") {
				objects = (out as { objects?: unknown }).objects ?? null;
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
		try {
			const text =
				(await this.vlmAsk(
					'Locate the head, eyes, and mouth in this photo of a person. Reply ONLY with JSON: {"head":[x,y,w,h],"eyes":[x,y,w,h],"mouth":[x,y,w,h]} where each value is the box as percentages (0-100) of the image size in order left,top,width,height.',
					crop,
					mime,
					200,
				)) ?? "";
			const json = extractJsonSubstring(text, "{");
			if (!json) return [];
			const parsed = JSON.parse(json) as Record<string, unknown>;
			const toBox = (key: string): DetectedBox | null => {
				const v = parsed[key];
				if (!Array.isArray(v) || v.length !== 4 || v.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
					return null;
				}
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
			const raw =
				(await this.vlmAsk(
					'Is there a person in this photo? If yes, reply ONLY with JSON {"present":true,"box":[left,top,width,height]} where the box is percentages (0-100) of the image covering the whole person. If no person, reply {"present":false}.',
					image,
					mime,
					200,
				)) ?? "";
			const json = extractJsonSubstring(raw, "{");
			if (!json) return null;
			const parsed = JSON.parse(json) as { present?: boolean; box?: unknown };
			if (!parsed.present || !Array.isArray(parsed.box) || parsed.box.length !== 4) return null;
			if (parsed.box.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
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
			const json = extractJsonSubstring(text, "[");
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
		question?: string,
	): Promise<RegionCaption> {
		const prompt = question
			? `Look closely at this photo and answer the user's question concisely and accurately: "${question}". Finish with a new last line: LABEL: <1-3 word subject name>.`
			: `Look at the main subject of this image. In one or two sentences, describe exactly what you see (object type, materials, colors, notable parts) and where it is (${position}). If the expected "${hint}" is not actually visible, say what is visible instead. Then on a new last line write exactly: LABEL: <one or two word name for what is shown>.`;
		const text = (await this.vlmAsk(prompt, crop, mime, 260)) ?? "";
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
		let decoded: { data: ArrayBuffer; mime: string } | null = null;
		if (this.models.t2i.includes("flux-2")) {
			const form = new FormData();
			form.append("prompt", prompt);
			form.append("width", String(width));
			form.append("height", String(height));
			const req = new Request("https://multipart.local", { method: "POST", body: form });
			decoded = await decodeImageOutput(
				await this.run(this.models.t2i, {
					multipart: {
						body: req.body,
						contentType: req.headers.get("content-type") || "multipart/form-data",
					},
				}),
			);
		} else {
			decoded = await decodeImageOutput(await this.run(this.models.t2i, { prompt, steps: 4 }));
		}
		if (!decoded) throw new ProviderError("Text-to-image returned no image", true);
		return { ...decoded, width, height };
	}

	async editWithReference(
		reference: { bytes: ArrayBuffer; mime: string },
		prompt: string,
		dims: { width: number; height: number },
		extraReferences: Array<{ bytes: ArrayBuffer; mime: string }> = [],
	): Promise<GeneratedImage & { model: string }> {
		const model = this.models.edit;
		if (!model) throw new ProviderError("No reference-edit model configured");
		const form = buildFluxEditForm(reference, prompt, dims, extraReferences);
		const request = new Request("https://multipart.local", { method: "POST", body: form });
		const out = await this.run(model, {
			multipart: {
				body: request.body,
				contentType: request.headers.get("content-type") || "multipart/form-data",
			},
		});
		const decoded = await decodeImageOutput(out);
		if (!decoded) throw new ProviderError("Edit model returned no image", true);
		return { ...decoded, ...dims, model };
	}

	async editWithPrimary(
		sources: string[],
		prompt: string,
		aspectRatio: string,
	): Promise<{ data: ArrayBuffer; mime: string; model: string } | null> {
		const model = this.models.editPrimary;
		if (!model || sources.length === 0) return null;
		try {
			const out = await this.run(model, {
				prompt,
				images: sources.slice(0, 5),
				aspect_ratio: aspectRatio,
			});
			const decoded = await decodeImageOutput(out);
			if (!decoded) {
				warn("pruna_edit_empty_output", "no image in response");
				return null;
			}
			return { ...decoded, model };
		} catch (error) {
			warn("pruna_edit_failed", error, { model });
			return null;
		}
	}

	async classifyIntent(
		text: string,
		context: { hasTarget: boolean; segmentLabels: string[] },
	): Promise<IntentClassification | null> {
		const model = this.models.router ?? this.models.llm;
		if (!model) return null;
		try {
			const schema = {
				type: "object",
				properties: {
					intent: {
						type: "string",
						enum: [
							"edit_region",
							"remove_object",
							"outpaint",
							"enhance",
							"remove_bg",
							"reimagine",
							"generate",
							"describe",
							"answer",
						],
					},
					targetObject: { type: ["string", "null"] },
					aspect: { type: ["string", "null"] },
					clarifiedPrompt: { type: ["string", "null"] },
				},
				required: ["intent"],
			};
			const sys =
				"Classify the photo-editor user message into one intent. " +
				`Context: hasTarget=${context.hasTarget}, detectedRegions=${JSON.stringify(context.segmentLabels)}. ` +
				"Rules: 'answer' for questions/advice/chit-chat; 'describe' to ask what is in the photo; " +
				"'generate' only to create a brand-new image from scratch; 'enhance' for sharpen/upscale/4k quality; " +
				"'remove_bg' to cut out subject / make background transparent; " +
				"'outpaint' to expand/extend borders/aspect ratio; " +
				"'remove_object' to erase/delete a specific object; " +
				"'edit_region' when modifying one specific named object; 'reimagine' for whole-photo style/lighting/scene changes.";
			const out = (await this.run(model, {
				messages: [
					{ role: "system", content: sys },
					{ role: "user", content: text },
				],
				response_format: { type: "json_schema", json_schema: schema },
				max_tokens: 200,
				...(model.includes("gemma-4") ? { chat_template_kwargs: { enable_thinking: false } } : {}),
			})) as { response?: unknown; choices?: Array<{ message?: { content?: string } }> };
			const raw =
				typeof out.response === "object" && out.response !== null
					? JSON.stringify(out.response)
					: typeof out.response === "string"
						? out.response
						: out.choices?.[0]?.message?.content ?? "";
			const jsonText = extractJsonSubstring(raw, "{") ?? raw;
			const parsed = JSON.parse(jsonText) as IntentClassification;
			return parsed?.intent ? parsed : null;
		} catch (error) {
			warn("intent_classify_failed", error);
			return null;
		}
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
			max_tokens: 600,
			...(this.models.llm.includes("gemma-4") ? { chat_template_kwargs: { enable_thinking: false } } : {}),
		})) as { response?: string; choices?: Array<{ message?: { content?: string } }> };
		const out = result.response?.trim() || result.choices?.[0]?.message?.content?.trim() || "";
		return out || text;
	}

	async streamChat(messages: Array<{ role: string; content: string }>): Promise<ReadableStream<string>> {
		const result = await this.run(this.models.llm, {
			messages,
			max_tokens: 3000,
			stream: true,
			...(this.models.llm.includes("gemma-4") ? { chat_template_kwargs: { enable_thinking: false } } : {}),
		});
		if (!(result instanceof ReadableStream)) {
			throw new ProviderError("Chat model did not return a stream", true);
		}
		return (result as ReadableStream<Uint8Array>).pipeThrough(sseDeltaStream());
	}
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
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
