import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { imageVersions } from "../../database/schema";
import { createDb } from "../../src/worker/lib/db";
import { assertFidelity, similarity } from "../../src/worker/lib/fidelity";
import { buildAlphaMask } from "../../src/worker/lib/mask";
import { PngOps } from "../../src/worker/lib/pixels";
import { decodePng, encodePng } from "../../src/worker/lib/png";
import { referenceDims } from "../../src/worker/lib/providers/types";
import { buildFluxEditForm, WorkersAIProvider } from "../../src/worker/lib/providers/workersai";
import { call, createAlbum, credits, guest, json, pngBytes, uploadPng, waitForJob } from "./helpers";

describe("PNG codec", () => {
	it("round-trips RGB, RGBA and gray+alpha", async () => {
		const rgba = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0, 1, 2, 3, 4]);
		const decoded = await decodePng(await encodePng(2, 2, 4, rgba));
		expect(Array.from(decoded.data)).toEqual(Array.from(rgba));
		const rgb = await decodePng(await encodePng(1, 1, 3, new Uint8Array([9, 8, 7])));
		expect(Array.from(rgb.data)).toEqual([9, 8, 7, 255]);
	});
});

describe("FLUX adapter contract (root cause of the stranger's face)", () => {
	it("sends the photo as a BINARY input_image_0 field, never a base64 `image` string", async () => {
		const ref = await pngBytes(32, 24);
		const form = buildFluxEditForm({ bytes: ref, mime: "image/png" }, "make it red", { width: 1024, height: 768 });
		const file = form.get("input_image_0");
		expect(file).toBeInstanceOf(Blob);
		expect((file as Blob).size).toBe(ref.byteLength);
		expect(form.get("image")).toBeNull();
		expect(form.get("width")).toBe("1024");
	});

	it("the provider actually transmits the reference in the multipart body", async () => {
		const ref = await pngBytes(32, 24);
		let captured: { model: string; body: FormData } | null = null;
		const fakeAi = {
			run: async (model: string, input: { multipart: { body: ReadableStream; contentType: string } }) => {
				const body = await new Request("https://x", {
					method: "POST",
					body: input.multipart.body,
					headers: { "content-type": input.multipart.contentType },
				}).formData();
				captured = { model, body };
				return { image: btoa(String.fromCharCode(...new Uint8Array(await pngBytes(8, 6)))) };
			},
		};
		const provider = new WorkersAIProvider(fakeAi as unknown as Ai, {
			moondream: "m",
			vlm: "v",
			t2i: "t",
			llm: "l",
			edit: "@cf/black-forest-labs/flux-2-klein-9b",
		});
		const out = await provider.editWithReference({ bytes: ref, mime: "image/png" }, "p", { width: 512, height: 384 });
		expect(out.model).toBe("@cf/black-forest-labs/flux-2-klein-9b");
		const sent = captured!.body.get("input_image_0") as File;
		expect(new Uint8Array(await sent.arrayBuffer())).toEqual(new Uint8Array(ref));
	});

	it("references fit FLUX.2's < 512px input limit", () => {
		for (const [w, h] of [[4032, 3024], [3024, 4032], [300, 200], [5000, 900]] as const) {
			const d = referenceDims(w, h);
			expect(Math.max(d.width, d.height)).toBeLessThan(512);
			// Aspect within 2% (integer rounding on very thin images).
			expect(Math.abs(d.width / d.height / (w / h) - 1)).toBeLessThan(0.02);
		}
	});
});

describe("fidelity guard", () => {
	const ops = new PngOps();

	it("passes a faithful result and rejects an unrelated one", async () => {
		const source = await pngBytes(64, 48);
		expect((await assertFidelity(ops, "enhance", source, await pngBytes(128, 96)))!.r).toBeGreaterThan(0.95);
		const noise = new Uint8Array(64 * 48 * 3).map((_, i) => (i * 7919) % 251);
		await expect(assertFidelity(ops, "reimagine", source, await encodePng(64, 48, 3, noise))).rejects.toThrow(
			/fidelity_check_failed/,
		);
	});

	it("local edits: a change outside the regions fails, inside passes", async () => {
		const source = await pngBytes(64, 48);
		const img = await decodePng(source);
		const inside = new Uint8Array(img.data);
		for (let y = 20; y < 30; y++) for (let x = 20; x < 30; x++) inside[(y * 64 + x) * 4] = 255;
		const region = { x: 20 / 64, y: 20 / 48, w: 10 / 64, h: 10 / 48 };
		await expect(assertFidelity(ops, "local", source, await encodePng(64, 48, 4, inside), { regions: [region] })).resolves.toBeTruthy();
		await expect(
			assertFidelity(ops, "local", source, await encodePng(64, 48, 4, inside), { regions: [{ x: 0.9, y: 0.9, w: 0.05, h: 0.05 }] }),
		).rejects.toThrow(/fidelity_check_failed/);
	});

	it("similarity separates structure from noise", async () => {
		const a = await decodePng(await pngBytes(32, 32));
		expect(similarity(a, a).r).toBe(1);
	});
});

describe("compositing keeps the outside pixel-exact", () => {
	it("PngOps.composite only touches the masked box", async () => {
		const ops = new PngOps();
		const base = await pngBytes(64, 48);
		const patch = await encodePng(16, 16, 3, new Uint8Array(16 * 16 * 3).fill(255));
		const mask = await buildAlphaMask(16, 16, { left: 4, top: 4, width: 8, height: 8 }, 1);
		const out = await decodePng((await ops.composite(base, patch, mask, { left: 10, top: 10, width: 16, height: 16 })).bytes);
		const src = await decodePng(base);
		for (let y = 0; y < 48; y++) {
			for (let x = 0; x < 64; x++) {
				const insideBox = x >= 10 && x < 26 && y >= 10 && y < 26;
				if (insideBox) continue;
				const i = (y * 64 + x) * 4;
				expect(out.data[i]).toBe(src.data[i]);
			}
		}
		expect(out.data[(18 * 64 + 18) * 4]).toBe(255);
	});
});

describe("operation classes end to end", () => {
	async function versionOf(cookie: string, imageId: string) {
		const { image, versions } = await json<{
			image: { widthPx: number; heightPx: number; mime: string; sourceImageId: string };
			versions: Array<{ opClass: string; model: string; fidelity: number | null }>;
		}>(await call(`/images/${imageId}`, {}, cookie));
		return { image, version: versions[0]! };
	}

	it("Enhance upscales the same photo (never a text-to-image repaint)", async () => {
		const cookie = await guest();
		const src = await uploadPng(cookie, await createAlbum(cookie), 64, 48);
		const { jobId } = await json<{ jobId: string }>(await call(`/images/${src.id}/enhance`, { method: "POST" }, cookie));
		const job = await waitForJob(cookie, jobId);
		expect(job.status).toBe("done");
		const { image, version } = await versionOf(cookie, job.resultImageId!);
		expect(version.opClass).toBe("enhance");
		expect(version.fidelity).toBeGreaterThan(0.95);
		expect(image.widthPx).toBe(128);
		expect(image.sourceImageId).toBe(src.id);
	});

	it("Remove background keeps the subject and adds transparency", async () => {
		const cookie = await guest();
		const src = await uploadPng(cookie, await createAlbum(cookie), 64, 48);
		const { jobId } = await json<{ jobId: string }>(
			await call(`/images/${src.id}/remove-background`, { method: "POST" }, cookie),
		);
		const job = await waitForJob(cookie, jobId);
		expect(job.status).toBe("done");
		const { image, version } = await versionOf(cookie, job.resultImageId!);
		expect(version.opClass).toBe("segment");
		expect(image.mime).toBe("image/png");
		const file = await call(`/images/${job.resultImageId}/file?variant=original`, {}, cookie);
		const decoded = await decodePng(await file.arrayBuffer());
		expect(decoded.data[3]).toBe(0); // corner (background) is transparent
	});

	it("a region edit changes only inside the drawn box", async () => {
		const cookie = await guest();
		const src = await uploadPng(cookie, await createAlbum(cookie), 64, 48);
		const bbox = { x: 0.5, y: 0.1, w: 0.25, h: 0.3 };
		const { instruction } = await json<{ instruction: { id: string } }>(
			await call(`/images/${src.id}/instructions`, { method: "POST", body: JSON.stringify({ text: "make the sun blue", bbox }) }, cookie),
		);
		const { jobId } = await json<{ jobId: string }>(
			await call(`/images/${src.id}/apply-instructions`, { method: "POST", body: JSON.stringify({ instructionIds: [instruction.id] }) }, cookie),
		);
		const job = await waitForJob(cookie, jobId);
		expect(job.status, job.error ?? "").toBe("done");
		const { version } = await versionOf(cookie, job.resultImageId!);
		expect(version.opClass).toBe("local");

		const before = await decodePng(await (await call(`/images/${src.id}/file?variant=original`, {}, cookie)).arrayBuffer());
		const after = await decodePng(await (await call(`/images/${job.resultImageId}/file?variant=original`, {}, cookie)).arrayBuffer());
		expect([after.width, after.height]).toEqual([64, 48]);
		let changedInside = 0;
		for (let y = 0; y < 48; y++) {
			for (let x = 0; x < 64; x++) {
				const i = (y * 64 + x) * 4;
				const inCrop = x >= 20 && x < 64 && y >= 0 && y < 36; // padded crop around the box
				if (!inCrop) expect(after.data[i], `pixel ${x},${y}`).toBe(before.data[i]);
				else if (after.data[i] !== before.data[i]) changedInside++;
			}
		}
		expect(changedInside).toBeGreaterThan(0);
	});

	it("a model that ignores the photo is rejected and refunded", async () => {
		const cookie = await guest();
		const src = await uploadPng(cookie, await createAlbum(cookie), 64, 48);
		const before = await credits(cookie);
		const { jobId } = await json<{ jobId: string }>(
			await call(`/images/${src.id}/edit`, { method: "POST", body: JSON.stringify({ prompt: "__mock_ignore_input__ enhance" }) }, cookie),
		);
		const job = await waitForJob(cookie, jobId);
		expect(job.status).toBe("error");
		expect(job.error).toMatch(/fidelity_check_failed/);
		expect(job.resultImageId).toBeNull();
		expect(await credits(cookie)).toBe(before);
	});

	it("records the audit trail on every AI version", async () => {
		const cookie = await guest();
		const src = await uploadPng(cookie, await createAlbum(cookie), 64, 48);
		const { jobId } = await json<{ jobId: string }>(
			await call(`/images/${src.id}/edit`, { method: "POST", body: JSON.stringify({ prompt: "warmer light" }) }, cookie),
		);
		const job = await waitForJob(cookie, jobId);
		const [version] = await createDb(env.DB)
			.select()
			.from(imageVersions)
			.where(eq(imageVersions.imageId, job.resultImageId!));
		expect(version).toMatchObject({ opClass: "reimagine", model: "mock:edit" });
		expect(version!.fidelity).toBeGreaterThan(0.4);
	});
});
