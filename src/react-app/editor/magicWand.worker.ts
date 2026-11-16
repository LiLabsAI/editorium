/**
 * Edge-aware Magic Wand region-growing worker: grows outward from a seed point,
 * slowing at strong Sobel luminance edges and color differences, returning an
 * antialiased alpha mask buffer + tight normalized bounding box.
 */

export interface WandRequest {
	id: number;
	width: number;
	height: number;
	rgba: Uint8ClampedArray;
	seedX: number;
	seedY: number;
	tolerance: number;
}

export interface WandResponse {
	id: number;
	maskAlpha: Uint8ClampedArray;
	bbox: { x: number; y: number; w: number; h: number } | null;
}

export function computeEdgeAwareWand(req: WandRequest): WandResponse {
	const { width, height, rgba, seedX, seedY, tolerance } = req;
	const n = width * height;
	const maskAlpha = new Uint8ClampedArray(n);
	if (width <= 0 || height <= 0) return { id: req.id, maskAlpha, bbox: null };

	const sx = Math.max(0, Math.min(width - 1, Math.round(seedX * (width - 1))));
	const sy = Math.max(0, Math.min(height - 1, Math.round(seedY * (height - 1))));
	const seedIdx = (sy * width + sx) * 4;
	const sr = rgba[seedIdx]!;
	const sg = rgba[seedIdx + 1]!;
	const sb = rgba[seedIdx + 2]!;

	// Compute luminance + Sobel edge strength map to act as a natural object boundary barrier.
	const luma = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const o = i * 4;
		luma[i] = 0.2126 * rgba[o]! + 0.7152 * rgba[o + 1]! + 0.0722 * rgba[o + 2]!;
	}
	const edge = new Float32Array(n);
	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			const idx = y * width + x;
			const gx =
				-luma[idx - width - 1]! +
				luma[idx - width + 1]! -
				2 * luma[idx - 1]! +
				2 * luma[idx + 1]! -
				luma[idx + width - 1]! +
				luma[idx + width + 1]!;
			const gy =
				-luma[idx - width - 1]! -
				2 * luma[idx - width]! -
				luma[idx - width + 1]! +
				luma[idx + width - 1]! +
				2 * luma[idx + width]! +
				luma[idx + width + 1]!;
			edge[idx] = Math.hypot(gx, gy) * 0.25;
		}
	}

	const visited = new Uint8Array(n);
	const queue = new Int32Array(n);
	let head = 0;
	let tail = 0;

	const maxDist = Math.max(8, tolerance * 1.9);
	const edgePenalty = 0.65;

	const start = sy * width + sx;
	visited[start] = 1;
	queue[tail++] = start;

	let minX = sx;
	let maxX = sx;
	let minY = sy;
	let maxY = sy;

	while (head < tail) {
		const curr = queue[head++]!;
		const cx = curr % width;
		const cy = (curr - cx) / width;
		const co = curr * 4;
		const dist = Math.hypot(rgba[co]! - sr, rgba[co + 1]! - sg, rgba[co + 2]! - sb);
		const softness = Math.max(0, Math.min(1, 1 - Math.max(0, dist - maxDist * 0.7) / (maxDist * 0.3 + 1)));
		maskAlpha[curr] = Math.round(255 * softness);

		if (cx < minX) minX = cx;
		if (cx > maxX) maxX = cx;
		if (cy < minY) minY = cy;
		if (cy > maxY) maxY = cy;

		const neighbors = [
			cx > 0 ? curr - 1 : -1,
			cx + 1 < width ? curr + 1 : -1,
			cy > 0 ? curr - width : -1,
			cy + 1 < height ? curr + width : -1,
		];
		for (const next of neighbors) {
			if (next < 0 || visited[next]) continue;
			visited[next] = 1;
			const no = next * 4;
			const colorDiff = Math.hypot(rgba[no]! - sr, rgba[no + 1]! - sg, rgba[no + 2]! - sb);
			const edgeBarrier = Math.abs(edge[next]! - edge[curr]!) * edgePenalty;
			if (colorDiff + edgeBarrier <= maxDist) {
				queue[tail++] = next;
			}
		}
	}

	if (maxX <= minX || maxY <= minY) return { id: req.id, maskAlpha, bbox: null };
	return {
		id: req.id,
		maskAlpha,
		bbox: {
			x: minX / width,
			y: minY / height,
			w: Math.max(0.015, (maxX - minX + 1) / width),
			h: Math.max(0.015, (maxY - minY + 1) / height),
		},
	};
}

const isDedicatedWorker =
	typeof window === "undefined" &&
	typeof self !== "undefined" &&
	typeof (self as unknown as { postMessage?: unknown }).postMessage === "function";

if (isDedicatedWorker) {
	const workerScope = self as unknown as {
		addEventListener: (type: "message", listener: (ev: MessageEvent<WandRequest>) => void) => void;
		postMessage: (msg: WandResponse, transfer: Transferable[]) => void;
	};
	workerScope.addEventListener("message", (event) => {
		const res = computeEdgeAwareWand(event.data);
		workerScope.postMessage(res, [res.maskAlpha.buffer]);
	});
}
