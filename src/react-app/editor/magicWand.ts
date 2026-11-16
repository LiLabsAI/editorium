import { computeEdgeAwareWand, type WandRequest, type WandResponse } from "./magicWand.worker";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (res: WandResponse) => void>();

function ensureWorker(): Worker | null {
	if (typeof Worker === "undefined") return null;
	if (!worker) {
		worker = new Worker(new URL("./magicWand.worker.ts", import.meta.url), { type: "module" });
		worker.addEventListener("message", (ev: MessageEvent<WandResponse>) => {
			const cb = pending.get(ev.data.id);
			if (cb) {
				pending.delete(ev.data.id);
				cb(ev.data);
			}
		});
	}
	return worker;
}

export async function runMagicWand(
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
	seedX: number,
	seedY: number,
	tolerance: number,
): Promise<WandResponse> {
	const id = nextId++;
	const w = ensureWorker();
	const copy = new Uint8ClampedArray(rgba);
	const req: WandRequest = { id, width, height, rgba: copy, seedX, seedY, tolerance };
	if (!w) return computeEdgeAwareWand(req);
	return new Promise<WandResponse>((resolve) => {
		pending.set(id, resolve);
		w.postMessage(req, [copy.buffer]);
	});
}
