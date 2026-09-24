import { describe, expect, it } from "vitest";

import { buildPolygonMask, encodePng } from "../../src/worker/lib/mask";
import { closestAspect, editDims } from "../../src/worker/lib/providers/types";
import { decodeImageOutput, normalizeMoondreamBox, sseDeltaStream } from "../../src/worker/lib/providers/workersai";
import { imageDimensions, sniffMime } from "../../src/worker/lib/r2";

function bytes(...parts: Array<number[] | string>): ArrayBuffer {
	const out: number[] = [];
	for (const p of parts) {
		if (typeof p === "string") for (const ch of p) out.push(ch.charCodeAt(0));
		else out.push(...p);
	}
	return new Uint8Array(out).buffer;
}

describe("imageDimensions (M1)", () => {
	it("parses PNG", async () => {
		expect(imageDimensions(await encodePng(7, 5, 1, new Uint8Array(35)))).toEqual({ width: 7, height: 5 });
	});
	it("parses GIF", () => {
		expect(imageDimensions(bytes("GIF89a", [0x40, 0x01, 0xf0, 0x00], [0, 0, 0, 0]))).toEqual({ width: 320, height: 240 });
	});
	it("parses WebP VP8X", () => {
		const header = bytes("RIFF", [0, 0, 0, 0], "WEBPVP8X", [10, 0, 0, 0], [0, 0, 0, 0], [0x3f, 0x01, 0x00], [0xef, 0x00, 0x00]);
		expect(imageDimensions(header)).toEqual({ width: 320, height: 240 });
	});
	it("parses progressive JPEG (SOF2) past APP segments", () => {
		const jpeg = bytes([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x04, 0, 0], [0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0xf0, 0x01, 0x40, 0x03]);
		expect(imageDimensions(jpeg)).toEqual({ width: 320, height: 240 });
	});
	it("never throws on truncated input", () => {
		for (const b of [bytes(), bytes([0xff, 0xd8]), bytes("RIFF"), bytes([0x89, 0x50])]) {
			expect(imageDimensions(b)).toBeNull();
		}
	});
});

describe("sniffMime (C3, M2)", () => {
	it("recognizes raster formats only", async () => {
		expect(sniffMime(await encodePng(1, 1, 1, new Uint8Array(1)))).toBe("image/png");
		expect(sniffMime(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		expect(sniffMime(bytes("<svg xmlns='x'></svg>"))).toBeNull();
		expect(sniffMime(bytes())).toBeNull();
	});
});

describe("editDims / closestAspect (H6)", () => {
	it("preserves aspect instead of squashing to a square", () => {
		expect(editDims(4032, 3024)).toEqual({ width: 1024, height: 768 });
		expect(editDims(3024, 4032)).toEqual({ width: 768, height: 1024 });
		expect(editDims(0, 0)).toEqual({ width: 1024, height: 1024 });
		const { width, height } = editDims(5000, 900);
		expect(width).toBe(1024);
		expect(height).toBeGreaterThanOrEqual(256);
	});
	it("maps to Pruna's accepted ratios", () => {
		expect(closestAspect(4032, 3024)).toBe("4:3");
		expect(closestAspect(1080, 1920)).toBe("9:16");
		expect(closestAspect(3000, 4000)).toBe("3:4");
		expect(closestAspect(0, 0)).toBe("1:1");
	});
});

describe("model output decoding", () => {
	it("reads Pruna's { result: { image: data-URL } } and sniffs the type", async () => {
		const png = await encodePng(2, 2, 1, new Uint8Array(4));
		let binary = "";
		for (const b of new Uint8Array(png)) binary += String.fromCharCode(b);
		const out = await decodeImageOutput({ state: "Completed", result: { image: `data:image/jpeg;base64,${btoa(binary)}` } });
		expect(out?.mime).toBe("image/png");
	});
	it("returns null for non-images", async () => {
		expect(await decodeImageOutput({ image: btoa("hello") })).toBeNull();
	});
});

describe("sseDeltaStream (M6)", () => {
	it("reassembles frames split across chunks and multi-byte characters", async () => {
		const text = 'data: {"response":"héllo "}\n\ndata: {"choices":[{"delta":{"content":"wörld"}}]}\n\ndata: [DONE]\n\n';
		const encoded = new TextEncoder().encode(text);
		const chunks = [encoded.slice(0, 14), encoded.slice(14, 15), encoded.slice(15, 40), encoded.slice(40)];
		const source = new ReadableStream<Uint8Array>({
			start(c) {
				for (const chunk of chunks) c.enqueue(chunk);
				c.close();
			},
		});
		let out = "";
		const reader = source.pipeThrough(sseDeltaStream()).getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			out += value;
		}
		expect(out).toBe("héllo wörld");
	});
});

describe("normalizeMoondreamBox (M7)", () => {
	it("reads normalized corner boxes as corners", () => {
		const box = normalizeMoondreamBox({ x_min: 0.1, y_min: 0.2, x_max: 0.5, y_max: 0.6 }, "dog")!;
		expect(box.x).toBeCloseTo(0.1);
		expect(box.y).toBeCloseTo(0.2);
		expect(box.w).toBeCloseTo(0.4);
		expect(box.h).toBeCloseTo(0.4);
		expect(normalizeMoondreamBox([0.5, 0.5, 0.2, 0.2], "bad")).toBeNull();
	});
});

describe("buildPolygonMask (M3)", () => {
	it("handles a max-size polygon quickly", async () => {
		const polygon = Array.from({ length: 200 }, (_, i) => {
			const a = (i / 200) * Math.PI * 2;
			return { x: 0.5 + 0.4 * Math.cos(a), y: 0.5 + 0.4 * Math.sin(a) };
		});
		const start = Date.now();
		const png = await buildPolygonMask(polygon, 4000, 3000);
		expect(Date.now() - start).toBeLessThan(1000);
		expect(imageDimensions(png)).toEqual({ width: 512, height: 384 });
	});
});
