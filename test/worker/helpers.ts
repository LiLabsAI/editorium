import { exports } from "cloudflare:workers";
import { expect } from "vitest";

import { encodePng } from "../../src/worker/lib/mask";

export const BASE = "https://editorium.test";

export function call(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
	const headers = new Headers(init.headers);
	if (cookie) headers.set("Cookie", cookie);
	if (typeof init.body === "string" && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}
	return exports.default.fetch(new Request(`${BASE}/api${path}`, { ...init, headers }));
}

export async function json<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

/** A fresh private guest session (distinct IP so the auth limiter never trips). */
let ipCounter = 0;
export async function guest(): Promise<string> {
	ipCounter += 1;
	const res = await call("/auth/guest", {
		method: "POST",
		headers: { "CF-Connecting-IP": `203.0.113.${ipCounter % 250}` },
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0]!;
}

/** A structured test photo: sky/ground gradient, a "sun" and a "house", so
 * the fidelity guard has real content to compare (flat images carry none). */
export async function pngBytes(width = 64, height = 48): Promise<ArrayBuffer> {
	const pixels = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 3;
			const sky = y < height * 0.55;
			let rgb = sky ? [110 + (y * 80) / height, 160, 230] : [70, 150 - (y * 60) / height, 60];
			if ((x - width * 0.75) ** 2 + (y - height * 0.22) ** 2 < (width * 0.08) ** 2) rgb = [235, 70, 50];
			if (x > width * 0.2 && x < width * 0.55 && y > height * 0.42 && y < height * 0.8) rgb = [40, 80, 190];
			pixels.set(rgb.map((v) => Math.round(v)), i);
		}
	}
	return encodePng(width, height, 3, pixels);
}

export async function createAlbum(cookie: string, title = "Album"): Promise<string> {
	const res = await call("/albums", { method: "POST", body: JSON.stringify({ title }) }, cookie);
	expect(res.status).toBe(201);
	return (await json<{ album: { id: string } }>(res)).album.id;
}

export async function upload(
	cookie: string,
	albumId: string,
	bytes: ArrayBuffer | string,
	name = "photo.png",
	type = "image/png",
): Promise<Response> {
	const form = new FormData();
	form.append("file", new File([bytes], name, { type }));
	return call(`/albums/${albumId}/upload`, { method: "POST", body: form }, cookie);
}

export async function uploadPng(cookie: string, albumId: string, w = 64, h = 48) {
	const res = await upload(cookie, albumId, await pngBytes(w, h));
	expect(res.status).toBe(201);
	return (await json<{ image: { id: string; widthPx: number; heightPx: number } }>(res)).image;
}

export async function credits(cookie: string): Promise<number> {
	return (await json<{ user: { credits: number } }>(await call("/me", {}, cookie))).user.credits;
}

/** Poll a job until it settles (the queue consumer runs in the test runtime). */
export async function waitForJob(cookie: string, jobId: string, timeoutMs = 15_000) {
	const start = Date.now();
	for (;;) {
		const { job } = await json<{
			job: { status: string; resultImageId: string | null; error: string | null; creditsCharged: number };
		}>(await call(`/jobs/${jobId}`, {}, cookie));
		if (job.status === "done" || job.status === "error") return job;
		if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} stuck in ${job.status}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** Parse an SSE body into {event, data} frames. */
export function sseFrames(body: string): Array<{ event: string; data: Record<string, unknown> }> {
	return body
		.split("\n\n")
		.map((f) => f.trim())
		.filter((f) => f.startsWith("data:"))
		.map((f) => JSON.parse(f.slice(5)) as { event: string; data: Record<string, unknown> });
}
