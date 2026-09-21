import {
	type AIProvider,
	type DetectedBox,
	type GeneratedImage,
	type RegionCaption,
	ProviderError,
} from "./types";

/**
 * Deterministic offline provider. Produces SVG "images" and canned scene
 * structure so the entire product works in local dev, tests, and CI without
 * Workers AI usage. Shape of the output mirrors the real pipeline: a person
 * with head/eyes/mouth children, plus scene objects.
 */

function svg(w: number, h: number, body: string, label: string): GeneratedImage {
	const doc =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
		body +
		`<text x="${w / 2}" y="${h - 24}" font-family="sans-serif" font-size="${Math.round(
			w / 30,
		)}" fill="rgba(255,255,255,0.85)" text-anchor="middle">${label}</text></svg>`;
	return {
		data: new TextEncoder().encode(doc).buffer as ArrayBuffer,
		mime: "image/svg+xml",
		width: w,
		height: h,
	};
}

const SCENE_BG =
	`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
	`<stop offset="0" stop-color="#7fa7d9"/><stop offset="0.55" stop-color="#9db8c9"/>` +
	`<stop offset="0.62" stop-color="#5f8f7d"/><stop offset="1" stop-color="#3e6b52"/>` +
	`</linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>`;

function personBody(cx: number, cy: number, scale: number): string {
	const s = scale;
	return (
		`<circle cx="${cx}" cy="${cy - 60 * s}" r="${28 * s}" fill="#c9a58b"/>` +
		`<rect x="${cx - 55 * s}" y="${cy - 30 * s}" width="${110 * s}" height="${150 * s}" rx="${30 * s}" fill="#20242c"/>` +
		`<rect x="${cx - 22 * s}" y="${cy - 26 * s}" width="${44 * s}" height="${120 * s}" rx="${18 * s}" fill="#e8e6e0"/>`
	);
}

function phoneBoothBody(x: number, y: number, w: number, h: number, color: string): string {
	return (
		`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w * 0.12}" fill="${color}"/>` +
		`<rect x="${x + w * 0.28}" y="${y + h * 0.25}" width="${w * 0.44}" height="${h * 0.7}" rx="${w * 0.08}" fill="#ffffff" opacity="0.75"/>` +
		`<rect x="${x + w * 0.1}" y="${y + h * 0.06}" width="${w * 0.8}" height="${h * 0.12}" rx="${w * 0.05}" fill="#ffffff" opacity="0.85"/>`
	);
}

/** Canned scene: person + booth + tree + water + grass + sky region. */
const SCENE_BOXES: DetectedBox[] = [
	{ label: "person", x: 0.36, y: 0.38, w: 0.26, h: 0.6, score: 0.97 },
	{ label: "phone booth", x: 0.55, y: 0.14, w: 0.33, h: 0.72, score: 0.94 },
	{ label: "tree", x: 0.03, y: 0.3, w: 0.2, h: 0.36, score: 0.81 },
	{ label: "water", x: 0.0, y: 0.34, w: 1.0, h: 0.16, score: 0.72 },
	{ label: "grass", x: 0.0, y: 0.62, w: 1.0, h: 0.38, score: 0.7 },
	{ label: "sky", x: 0.0, y: 0.0, w: 1.0, h: 0.34, score: 0.66 },
];

const FACE_BOXES: DetectedBox[] = [
	{ label: "head", x: 0.3, y: 0.02, w: 0.4, h: 0.34, score: 0.95 },
	{ label: "eyes", x: 0.34, y: 0.12, w: 0.32, h: 0.08, score: 0.9 },
	{ label: "mouth", x: 0.4, y: 0.26, w: 0.2, h: 0.06, score: 0.88 },
];

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

export class MockProvider implements AIProvider {
	async detect(): Promise<DetectedBox[]> {
		return structuredClone(SCENE_BOXES);
	}

	async detectFaceDetails(
		crop: ArrayBuffer,
		mime: string,
	): Promise<DetectedBox[]> {
		void crop;
		void mime;
		return structuredClone(FACE_BOXES);
	}

	async locatePerson(
		image: ArrayBuffer,
		mime: string,
	): Promise<DetectedBox | null> {
		void image;
		void mime;
		// Demo mode always "finds" the canned person.
		return { label: "person", x: 0.36, y: 0.38, w: 0.26, h: 0.6, score: 0.9 };
	}

	async sceneInventory(
		image: ArrayBuffer,
		mime: string,
	): Promise<Array<{ label: string; band: "top" | "middle" | "bottom" }>> {
		void image;
		void mime;
		return [
			{ label: "sky", band: "top" },
			{ label: "water", band: "middle" },
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
		const descriptions: Record<string, string> = {
			person:
				"A man with dark hair and a short beard wearing dark sunglasses, a black leather jacket over a white t-shirt, standing upright and facing the camera.",
			"phone booth":
				"A tall vintage telephone booth painted in soft pink, with a white sign panel near the top and glass panes along the door, standing in the mid-ground.",
			tree: "A small, leafy tree with a rounded canopy, slightly out of focus, anchoring the near edge of the scene.",
			water: "A calm stretch of blue water stretching across the background horizon, catching the daylight.",
			grass: "An open lawn of mixed green and dry grass covering the foreground ground plane.",
			sky: "A bright daytime sky with scattered soft clouds filling the upper part of the frame.",
			head: "The man's head seen frontally, with dark wavy hair and sunglasses resting on his face.",
			eyes: "Dark sunglasses with wide lenses covering the eye line.",
			mouth: "A closed, neutral mouth above a short trimmed beard.",
		};
		return {
			label,
			caption:
				descriptions[label] ??
				`A ${label} ${position}, rendered in natural daylight with soft shadows.`,
		};
	}

	async textToImage(
		prompt: string,
		opts: { aspect?: string },
	): Promise<GeneratedImage> {
		const [w, h] = aspectSize(opts.aspect ?? "1:1");
		const hue = hashHue(prompt);
		const label = prompt.slice(0, 60).replace(/[<>&]/g, "");
		return svg(
			w,
			h,
			SCENE_BG +
				`<circle cx="${w * 0.25}" cy="${h * 0.35}" r="${w * 0.09}" fill="hsl(${hue},60%,70%)"/>` +
				phoneBoothBody(w * 0.55, h * 0.2, w * 0.28, h * 0.62, `hsl(${(hue + 300) % 360},55%,72%)`) +
				personBody(w * 0.38, h * 0.72, w / 1024),
			`Generated: ${label}`,
		);
	}

	async imageToImage(
		image: ArrayBuffer,
		mime: string,
		prompt: string,
		strength: number,
	): Promise<GeneratedImage> {
		if (mime === "image/svg+xml") {
			const doc = new TextDecoder().decode(image);
			const tinted = doc.replace(
				/(stop-color=")(#[0-9a-fA-F]{6})(")/g,
				(_m, a, hex) => a + shiftHue(hex, strength * 0.25) + '"',
			);
			return {
				data: new TextEncoder().encode(tinted).buffer as ArrayBuffer,
				mime: "image/svg+xml",
				width: svgWidth(doc) ?? 1024,
				height: svgHeight(doc) ?? 1280,
			};
		}
		// Raster sources in mock mode: synthesize a flat SVG stand-in.
		return svg(1024, 1024, SCENE_BG, `Edited: ${prompt.slice(0, 50)}`);
	}

	async inpaint(
		image: ArrayBuffer,
		mime: string,
		_mask: ArrayBuffer | null,
		box: { x: number; y: number; w: number; h: number },
		prompt: string,
		dims?: { width: number; height: number },
	): Promise<GeneratedImage> {
		// Composite over the ORIGINAL image so only the region changes: raster
		// sources are embedded as a data URI, SVG sources inline their content.
		const w = dims?.width || 1024;
		const h = dims?.height || 1280;
		const hue = hashHue(prompt);
		const label = prompt.slice(0, 44).replace(/[<>&]/g, "");
		const bx = box.x * w;
		const by = box.y * h;
		const bw = box.w * w;
		const bh = box.h * h;
		const defs =
			`<defs><clipPath id="edbox"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="10"/></clipPath></defs>`;
		const patch =
			`<g clip-path="url(#edbox)">` +
			`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="hsl(${hue},70%,65%)" opacity="0.9"/>` +
			`<text x="${bx + bw / 2}" y="${by + bh / 2}" font-family="sans-serif" font-size="${Math.max(14, Math.round(w / 40))}" fill="rgba(255,255,255,0.95)" text-anchor="middle">${label}</text>` +
			`</g>`;
		let inner: string;
		if (mime === "image/svg+xml") {
			const doc = new TextDecoder().decode(image);
			inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(doc)?.[1] ?? "";
			// Avoid nested <defs> id collisions from the source document.
			inner = inner.replace(/<defs>[\s\S]*?<\/defs>/g, "");
		} else {
			const b64 = arrayBufferToBase64(image);
			inner = `<image href="data:${mime};base64,${b64}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none"/>`;
		}
		const doc =
			`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
			defs +
			inner +
			patch +
			`</svg>`;
		return {
			data: new TextEncoder().encode(doc).buffer as ArrayBuffer,
			mime: "image/svg+xml",
			width: w,
			height: h,
		};
	}

	async upscale(
		image: ArrayBuffer,
		mime: string,
		factor: number,
	): Promise<GeneratedImage> {
		if (mime === "image/svg+xml") {
			const doc = new TextDecoder().decode(image);
			const w = Math.round((svgWidth(doc) ?? 1024) * factor);
			const h = Math.round((svgHeight(doc) ?? 1280) * factor);
			const scaled = doc.replace(
				/width="(\d+)" height="(\d+)"/,
				`width="${w}" height="${h}"`,
			);
			return {
				data: new TextEncoder().encode(scaled).buffer as ArrayBuffer,
				mime: "image/svg+xml",
				width: w,
				height: h,
			};
		}
		return svg(2048, 2560, SCENE_BG, `Enhanced ${factor}x`);
	}

	async rewritePrompt(
		text: string,
		operation: string,
		_context: string,
	): Promise<string> {
		void _context;
		const cleaned = text.replace(/\s+/g, " ").trim();
		if (operation === "enhance") {
			return `${cleaned}; high-resolution photograph, crisp detail, professional camera lens, natural depth of field`;
		}
		return `${cleaned}; single coherent scene, natural lighting, sharp focus`;
	}

	async streamChat(
		messages: Array<{ role: string; content: string }>,
	): Promise<ReadableStream<string>> {
		const last = messages[messages.length - 1]?.content ?? "";
		const reply = mockReply(last);
		return new ReadableStream({
			start(controller) {
				const words = reply.split(" ");
				let i = 0;
				const push = () => {
					if (i >= words.length) {
						controller.close();
						return;
					}
					controller.enqueue(words[i++] + " ");
					setTimeout(push, 15);
				};
				push();
			},
		});
	}

	async moderateImage(): Promise<string | null> {
		return null;
	}
}

export function mockReply(userText: string): string {
	const t = userText.toLowerCase();
	if (/(4k|quality|enhance|sharper|resolution|camera)/.test(t)) {
		return (
			"I'll enhance this into a crisp, high-quality photograph with the depth and clarity of a professional camera."
		);
	}
	if (/(add|create|generate|make me|draw)/.test(t)) {
		return "Generating a new image from your description.";
	}
	return (
		"I can generate images, enhance them to high resolution, or edit a recognized region you select in the editor. " +
		"Tell me what you'd like to change, or pick a layer from the element tree."
	);
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

function hashHue(text: string): number {
	let h = 0;
	for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
	return h;
}

function shiftHue(hex: string, amount: number): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
	return `#${clamp(r + amount * 255).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b + amount * 120).toString(16).padStart(2, "0")}`;
}

function svgWidth(doc: string): number | null {
	const m = /width="(\d+)"/.exec(doc);
	return m ? Number(m[1]) : null;
}

function svgHeight(doc: string): number | null {
	const m = /height="(\d+)"/.exec(doc);
	return m ? Number(m[1]) : null;
}

export { ProviderError };
