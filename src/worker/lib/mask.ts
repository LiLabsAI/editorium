/**
 * Server-side mask synthesis (plan 16): a feathered grayscale PNG for a
 * normalized bbox, used to constrain region edits. Pure TS — PNG chunks are
 * assembled by hand and the IDAT is zlib-compressed via CompressionStream
 * ('deflate' = RFC1950 zlib wrapper, exactly what PNG expects).
 */

export interface Bbox {
	x: number;
	y: number;
	w: number;
	h: number;
}

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

async function zlibCompress(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new CompressionStream("deflate");
	const writer = stream.writable.getWriter();
	writer.write(bytes);
	writer.close();
	const chunks: Uint8Array[] = [];
	const reader = stream.readable.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

export interface MaskOptions {
	/** Cap the longer side to keep masks small (aspect preserved). */
	maxSize?: number;
	/** Feather width as a fraction of the box's shorter side (0..0.5). */
	feather?: number;
}

/** Build a grayscale PNG (color type 0): white inside the feathered box,
 * black outside. 255 = editable region. */
export async function buildBoxMask(
	box: Bbox,
	imageWidth: number,
	imageHeight: number,
	opts: MaskOptions = {},
): Promise<ArrayBuffer> {
	const maxSize = opts.maxSize ?? 1024;
	const scale = Math.min(1, maxSize / Math.max(imageWidth, imageHeight));
	const width = Math.max(1, Math.round(imageWidth * scale));
	const height = Math.max(1, Math.round(imageHeight * scale));
	const featherFrac = Math.min(0.5, Math.max(opts.feather ?? 0.08, 0.01));

	const bx = box.x * width;
	const by = box.y * height;
	const bw = Math.max(1, box.w * width);
	const bh = Math.max(1, box.h * height);
	const feather = Math.max(1, Math.min(bw, bh) * featherFrac);

	// Scanlines: filter byte 0 + one gray byte per pixel.
	const stride = width + 1;
	const raw = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const rowStart = y * stride;
		raw[rowStart] = 0; // filter type None
		const dy =
			y < by ? by - y : y > by + bh ? y - (by + bh) : 0;
		for (let x = 0; x < width; x++) {
			const dx = x < bx ? bx - x : x > bx + bw ? x - (bx + bw) : 0;
			// Signed distance to the box edge: positive inside, negative outside;
			// feather ramps from 0 at the outer edge to 1 feather-px inward.
			const edgeDist =
				dx === 0 && dy === 0
					? Math.min(x - bx, bx + bw - x, y - by, by + bh - y)
					: -Math.hypot(dx, dy);
			const v = Math.min(1, Math.max(0, (edgeDist + feather) / feather));
			raw[rowStart + 1 + x] = Math.round(v * 255);
		}
	}

	const idat = await zlibCompress(raw);
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // color type: grayscale
	const png = new Uint8Array(8 + 12 + 13 + 12 + idat.length + 12);
	png.set(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 0);
	let offset = 8;
	for (const chunkBytes of [chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]) {
		png.set(chunkBytes, offset);
		offset += chunkBytes.length;
	}
	return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
}

/** Point-in-polygon test (ray casting) on mask-resolution coordinates. */
function pointInPolygon(px: number, py: number, poly: Array<[number, number]>): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i]!;
		const [xj, yj] = poly[j]!;
		const intersects =
			yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
		if (intersects) inside = !inside;
	}
	return inside;
}

/** Feathered grayscale mask for an arbitrary normalized polygon (plan 20). */
export async function buildPolygonMask(
	polygon: Array<{ x: number; y: number }>,
	imageWidth: number,
	imageHeight: number,
	opts: MaskOptions = {},
): Promise<ArrayBuffer> {
	const maxSize = opts.maxSize ?? 1024;
	const scale = Math.min(1, maxSize / Math.max(imageWidth, imageHeight));
	const width = Math.max(1, Math.round(imageWidth * scale));
	const height = Math.max(1, Math.round(imageHeight * scale));
	const feather = Math.max(2, Math.round(Math.min(width, height) * (opts.feather ?? 0.03)));
	const poly: Array<[number, number]> = polygon.map((p) => [p.x * width, p.y * height]);

	// Distance-ish feather: a pixel is editable if inside the polygon, or
	// within `feather` px of any polygon edge (cheap bbox-of-edge check).
	const stride = width + 1;
	const raw = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const rowStart = y * stride;
		raw[rowStart] = 0;
		for (let x = 0; x < width; x++) {
			let value = 0;
			if (pointInPolygon(x, y, poly)) {
				value = 255;
			} else {
				// near-edge band: sample neighbors at the feather radius
				for (let r = 1; r <= feather && value === 0; r++) {
					if (pointInPolygon(x + r, y, poly) || pointInPolygon(x - r, y, poly) ||
						pointInPolygon(x, y + r, poly) || pointInPolygon(x, y - r, poly)) {
						value = Math.round(255 * (1 - r / (feather + 1)));
						break;
					}
				}
			}
			raw[rowStart + 1 + x] = value;
		}
	}

	const idat = await zlibCompress(raw);
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	ihdr[8] = 8;
	ihdr[9] = 0;
	const png = new Uint8Array(8 + 12 + 13 + 12 + idat.length + 12);
	png.set(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 0);
	let offset = 8;
	for (const chunkBytes of [chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]) {
		png.set(chunkBytes, offset);
		offset += chunkBytes.length;
	}
	return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
}

/** Raw (uncompressed) grayscale mask bytes at explicit dimensions — used to
 * feed the inpainting model directly, which wants an 8-bit array rather than
 * a PNG. White (255) = editable. */
export function buildBoxMaskRaw(
	box: Bbox,
	width: number,
	height: number,
	featherFrac = 0.08,
): Uint8Array {
	const bx = box.x * width;
	const by = box.y * height;
	const bw = Math.max(1, box.w * width);
	const bh = Math.max(1, box.h * height);
	const feather = Math.max(1, Math.min(bw, bh) * Math.min(0.5, Math.max(featherFrac, 0.01)));
	const raw = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		const dy = y < by ? by - y : y > by + bh ? y - (by + bh) : 0;
		for (let x = 0; x < width; x++) {
			const dx = x < bx ? bx - x : x > bx + bw ? x - (bx + bw) : 0;
			const edgeDist =
				dx === 0 && dy === 0
					? Math.min(x - bx, bx + bw - x, y - by, by + bh - y)
					: -Math.hypot(dx, dy);
			const v = Math.min(1, Math.max(0, (edgeDist + feather) / feather));
			raw[y * width + x] = Math.round(v * 255);
		}
	}
	return raw;
}
