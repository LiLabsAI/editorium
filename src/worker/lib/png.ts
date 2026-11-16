/**
 * Minimal PNG codec (pure TS): encode 8-bit gray/RGB/RGBA and decode 8-bit
 * gray, gray+alpha, RGB, RGBA and palette PNGs to RGBA. Used for masks,
 * fidelity thumbnails, and the offline test pixel pipeline.
 */

export interface Rgba {
	width: number;
	height: number;
	/** Row-major RGBA, 4 bytes per pixel. */
	data: Uint8Array;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const MAX_DECODE_PIXELS = 25_000_000;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
	// Stream directly without copying into a Blob (saves peak memory in 128 MB isolates).
	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	}).pipeThrough(stream);
	return new Uint8Array(await new Response(readable).arrayBuffer());
}

/** Encode 8-bit pixels (`channels` bytes per pixel) as PNG. */
export async function encodePng(
	width: number,
	height: number,
	channels: 1 | 3 | 4,
	pixels: Uint8Array,
): Promise<ArrayBuffer> {
	const rowBytes = width * channels;
	const raw = new Uint8Array((rowBytes + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (rowBytes + 1)] = 0; // filter type None
		raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
	}
	const idat = await pipe(raw, new CompressionStream("deflate"));
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	ihdr[8] = 8;
	ihdr[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
	const parts = [
		new Uint8Array(PNG_SIG),
		chunk("IHDR", ihdr),
		chunk("IDAT", idat),
		chunk("IEND", new Uint8Array(0)),
	];
	const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		png.set(part, offset);
		offset += part.length;
	}
	return png.buffer as ArrayBuffer;
}

export function encodeRgba(image: Rgba): Promise<ArrayBuffer> {
	return encodePng(image.width, image.height, 4, image.data);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decode an 8-bit, non-interlaced PNG to RGBA. Throws on anything else. */
export async function decodePng(buffer: ArrayBuffer): Promise<Rgba> {
	const bytes = new Uint8Array(buffer);
	const view = new DataView(buffer);
	if (bytes.length < 33 || !PNG_SIG.every((b, i) => bytes[i] === b)) {
		throw new Error("not a PNG");
	}
	let offset = 8;
	let width = 0;
	let height = 0;
	let colorType = -1;
	let palette: Uint8Array | null = null;
	let transparency: Uint8Array | null = null;
	const idat: Uint8Array[] = [];
	while (offset + 12 <= bytes.length) {
		const length = view.getUint32(offset);
		if (length > bytes.length - offset - 12) throw new Error("truncated PNG chunk");
		const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
		const data = bytes.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			if (length < 13) throw new Error("invalid IHDR");
			width = view.getUint32(offset + 8);
			height = view.getUint32(offset + 12);
			if (width === 0 || height === 0 || width * height > MAX_DECODE_PIXELS) {
				throw new Error("unsupported PNG dimensions");
			}
			if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported PNG (bit depth/interlace)");
			colorType = data[9]!;
		} else if (type === "PLTE") palette = data;
		else if (type === "tRNS") transparency = data;
		else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		offset += 12 + length;
	}
	const channels = CHANNELS[colorType];
	if (!channels || width === 0 || height === 0) throw new Error("unsupported PNG color type");
	const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
	let at = 0;
	for (const d of idat) {
		joined.set(d, at);
		at += d.length;
	}
	const raw = await pipe(joined, new DecompressionStream("deflate"));
	const stride = width * channels;
	if (raw.length < (stride + 1) * height) throw new Error("truncated PNG image data");
	const px = new Uint8Array(stride * height);
	let p = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[p++]!;
		const row = y * stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? px[row + x - channels]! : 0;
			const b = y > 0 ? px[row - stride + x]! : 0;
			const c = x >= channels && y > 0 ? px[row - stride + x - channels]! : 0;
			let v = raw[p++]!;
			if (filter === 1) v += a;
			else if (filter === 2) v += b;
			else if (filter === 3) v += (a + b) >> 1;
			else if (filter === 4) {
				const pa = Math.abs(b - c);
				const pb = Math.abs(a - c);
				const pc = Math.abs(a + b - 2 * c);
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			px[row + x] = v & 0xff;
		}
	}
	const trnsGray = colorType === 0 && transparency && transparency.length >= 2 ? transparency[1]! : null;
	const trnsRgb =
		colorType === 2 && transparency && transparency.length >= 6
			? [transparency[1]!, transparency[3]!, transparency[5]!]
			: null;

	const out = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const o = i * 4;
		const s = i * channels;
		if (colorType === 3) {
			const k = px[i]!;
			out[o] = palette?.[k * 3] ?? 0;
			out[o + 1] = palette?.[k * 3 + 1] ?? 0;
			out[o + 2] = palette?.[k * 3 + 2] ?? 0;
			out[o + 3] = transparency && k < transparency.length ? transparency[k]! : 255;
		} else if (channels <= 2) {
			const g = px[s]!;
			out[o] = out[o + 1] = out[o + 2] = g;
			out[o + 3] = channels === 2 ? px[s + 1]! : trnsGray !== null && g === trnsGray ? 0 : 255;
		} else {
			const r = px[s]!;
			const g = px[s + 1]!;
			const b = px[s + 2]!;
			out[o] = r;
			out[o + 1] = g;
			out[o + 2] = b;
			out[o + 3] =
				channels === 4
					? px[s + 3]!
					: trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2]
						? 0
						: 255;
		}
	}
	return { width, height, data: out };
}
