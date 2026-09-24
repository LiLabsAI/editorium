import { decodePng, encodePng } from "../png";
import {
	type AIProvider,
	type DetectedBox,
	type GeneratedImage,
	type RegionCaption,
	ProviderError,
} from "./types";

/**
 * Deterministic offline provider for tests and CI (AI_MOCK=true). Every image
 * it returns is a real PNG — the pipeline stores only sniffed raster formats,
 * so mock output goes through exactly the same path as model output.
 * Images are rendered at 1/8 of the requested size to keep tests fast; the
 * aspect ratio is preserved.
 */

const SCALE = 8;

async function png(width: number, height: number, seed: string): Promise<GeneratedImage> {
	const w = Math.max(8, Math.round(width / SCALE));
	const h = Math.max(8, Math.round(height / SCALE));
	const hue = hashHue(seed);
	const [r, g, b] = hslToRgb(hue, 0.55, 0.6);
	const pixels = new Uint8Array(w * h * 3);
	for (let y = 0; y < h; y++) {
		const shade = 0.7 + (0.3 * y) / h;
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 3;
			pixels[i] = Math.round(r * shade);
			pixels[i + 1] = Math.round(g * shade);
			pixels[i + 2] = Math.round(b * shade);
		}
	}
	return { data: await encodePng(w, h, 3, pixels), mime: "image/png", width: w, height: h };
}

async function noise(width: number, height: number): Promise<GeneratedImage> {
	const w = Math.max(8, Math.round(width / SCALE));
	const h = Math.max(8, Math.round(height / SCALE));
	const pixels = new Uint8Array(w * h * 3);
	let seed = 1234567;
	for (let i = 0; i < pixels.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		pixels[i] = seed & 0xff;
	}
	return { data: await encodePng(w, h, 3, pixels), mime: "image/png", width: w, height: h };
}

/** Canned scene: person + booth + tree + water + grass + sky region. */
const SCENE_BOXES: DetectedBox[] = [
	{ label: "person", x: 0.36, y: 0.38, w: 0.26, h: 0.6, score: 0.97 },
	{ label: "phone booth", x: 0.55, y: 0.14, w: 0.33, h: 0.72, score: 0.94 },
	{ label: "tree", x: 0.03, y: 0.3, w: 0.2, h: 0.36, score: 0.81 },
];

const FACE_BOXES: DetectedBox[] = [
	{ label: "head", x: 0.3, y: 0.02, w: 0.4, h: 0.34, score: 0.95 },
	{ label: "eyes", x: 0.34, y: 0.12, w: 0.32, h: 0.08, score: 0.9 },
	{ label: "mouth", x: 0.4, y: 0.26, w: 0.2, h: 0.06, score: 0.88 },
];

export class MockProvider implements AIProvider {
	async detect(): Promise<DetectedBox[]> {
		return structuredClone(SCENE_BOXES);
	}

	async detectFaceDetails(): Promise<DetectedBox[]> {
		return structuredClone(FACE_BOXES);
	}

	async locatePerson(): Promise<DetectedBox | null> {
		return null;
	}

	async sceneInventory(): Promise<Array<{ label: string; band: "top" | "middle" | "bottom" }>> {
		return [
			{ label: "sky", band: "top" },
			{ label: "grass", band: "bottom" },
		];
	}

	async captionRegion(
		_crop: ArrayBuffer,
		_mime: string,
		hint: string,
		position: string,
	): Promise<RegionCaption> {
		const label = hint || "object";
		return { label, caption: `A ${label} ${position}.` };
	}

	async textToImage(prompt: string, opts: { aspect?: string }): Promise<GeneratedImage> {
		const [w, h] = aspectSize(opts.aspect ?? "1:1");
		return png(w, h, prompt);
	}

	/** Mock reference edit: a hue-shifted copy of the (PNG) reference at
	 * `dims`, so results stay faithful to the input like a working model.
	 * `__mock_ignore_input__` simulates a model that ignores its input;
	 * `__mock_fail__` simulates a model error. */
	async editWithReference(
		reference: { bytes: ArrayBuffer; mime: string },
		prompt: string,
		dims: { width: number; height: number },
	): Promise<GeneratedImage & { model: string }> {
		if (prompt.includes("__mock_fail__")) throw new ProviderError("mock failure");
		if (prompt.includes("__mock_ignore_input__")) {
			return { ...(await noise(dims.width, dims.height)), model: "mock:edit" };
		}
		const src = await decodePng(reference.bytes);
		const w = Math.max(8, Math.round(dims.width / SCALE));
		const h = Math.max(8, Math.round(dims.height / SCALE));
		const out = new Uint8Array(w * h * 4);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const s = (Math.floor((y * src.height) / h) * src.width + Math.floor((x * src.width) / w)) * 4;
				const o = (y * w + x) * 4;
				out[o] = Math.min(255, src.data[s]! + 20);
				out[o + 1] = src.data[s + 1]!;
				out[o + 2] = Math.max(0, src.data[s + 2]! - 20);
				out[o + 3] = 255;
			}
		}
		return { data: await encodePng(w, h, 4, out), mime: "image/png", width: w, height: h, model: "mock:edit" };
	}

	async rewritePrompt(text: string, operation: string): Promise<string> {
		const cleaned = text.replace(/\s+/g, " ").trim();
		return operation === "enhance"
			? `${cleaned}; high-resolution photograph, crisp detail`
			: `${cleaned}; single coherent scene, natural lighting`;
	}

	async streamChat(messages: Array<{ role: string; content: string }>): Promise<ReadableStream<string>> {
		const last = messages[messages.length - 1]?.content ?? "";
		const words = mockReply(last).split(" ");
		return new ReadableStream<string>({
			pull(controller) {
				const word = words.shift();
				if (word === undefined) controller.close();
				else controller.enqueue(`${word} `);
			},
		});
	}
}

export function mockReply(userText: string): string {
	const t = userText.toLowerCase();
	if (/(4k|quality|enhance|sharper|resolution|camera)/.test(t)) {
		return "I'll enhance this into a crisp, high-quality photograph.";
	}
	if (/(add|create|generate|make me|draw)/.test(t)) {
		return "Generating a new image from your description.";
	}
	return "I can generate images, enhance them, or edit a region you select in the editor.";
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

function hashHue(text: string): number {
	let h = 0;
	for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
	return h;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export { ProviderError };
