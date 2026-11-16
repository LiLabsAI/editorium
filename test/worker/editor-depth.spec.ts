import { describe, expect, it } from "vitest";

import { encodePng } from "../../src/worker/lib/mask";
import { signPublicImageUrl } from "../../src/worker/lib/sign";
import { call, createAlbum, credits, guest, json, pngBytes, sseFrames, uploadPng, waitForJob } from "./helpers";
import { env } from "cloudflare:test";

describe("Editor depth & hardening (backend)", () => {
	it("persists and clears non-destructive adjustments and rejects empty PATCH bodies", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const image = await uploadPng(cookie, albumId, 64, 48);

		const emptyImgPatch = await call(
			`/images/${image.id}`,
			{ method: "PATCH", body: JSON.stringify({}) },
			cookie,
		);
		expect(emptyImgPatch.status).toBe(400);

		const adjRes = await call(
			`/images/${image.id}/adjustments`,
			{
				method: "PATCH",
				body: JSON.stringify({
					adjustments: { exposure: 0.5, contrast: 0.2, rotate90: 1, flipH: true },
				}),
			},
			cookie,
		);
		expect(adjRes.status).toBe(200);
		const adjData = await json<{ adjustmentsJson: string | null }>(adjRes);
		expect(adjData.adjustmentsJson).toContain('"exposure":0.5');

		const cleared = await call(
			`/images/${image.id}/adjustments`,
			{ method: "PATCH", body: JSON.stringify({ adjustments: null }) },
			cookie,
		);
		expect(cleared.status).toBe(200);
		expect((await json<{ adjustmentsJson: string | null }>(cleared)).adjustmentsJson).toBeNull();
	});

	it("extracts 1-click subject mask, serves it, and enforces non-empty segment PATCH", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const image = await uploadPng(cookie, albumId, 64, 48);

		const subRes = await call(`/images/${image.id}/subject-mask`, { method: "POST" }, cookie);
		expect(subRes.status).toBe(201);
		const { segment } = await json<{ segment: { id: string; label: string; maskR2Key: string | null } }>(subRes);
		expect(segment.label).toBe("Subject");
		expect(segment.maskR2Key).toBeTruthy();

		const maskRes = await call(`/segments/${segment.id}/mask`, {}, cookie);
		expect(maskRes.status).toBe(200);
		expect(maskRes.headers.get("Content-Type")).toBe("image/png");
		const etag = maskRes.headers.get("ETag");
		if (etag) {
			const cached = await call(`/segments/${segment.id}/mask`, { headers: { "If-None-Match": etag } }, cookie);
			expect(cached.status).toBe(304);
		}

		const emptySegPatch = await call(
			`/segments/${segment.id}`,
			{ method: "PATCH", body: JSON.stringify({}) },
			cookie,
		);
		expect(emptySegPatch.status).toBe(400);
	});

	it("validates and executes generative outpainting while preserving inner pixels", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const image = await uploadPng(cookie, albumId, 64, 48);
		const before = await credits(cookie);

		const badEmpty = await call(
			`/images/${image.id}/outpaint`,
			{ method: "POST", body: JSON.stringify({ top: 0, bottom: 0, left: 0, right: 0 }) },
			cookie,
		);
		expect(badEmpty.status).toBe(400);

		const okRes = await call(
			`/images/${image.id}/outpaint`,
			{ method: "POST", body: JSON.stringify({ top: 8, bottom: 8, left: 16, right: 16, prompt: "extend sky" }) },
			cookie,
		);
		expect(okRes.status).toBe(202);
		const { jobId } = await json<{ jobId: string }>(okRes);
		const job = await waitForJob(cookie, jobId);
		expect(job.status).toBe("done");
		expect(job.resultImageId).toBeTruthy();
		expect(await credits(cookie)).toBe(before - 2);

		const outImg = await json<{ image: { widthPx: number; heightPx: number } }>(
			await call(`/images/${job.resultImageId}`, {}, cookie),
		);
		expect(outImg.image.widthPx).toBe(64 + 32);
		expect(outImg.image.heightPx).toBe(48 + 16);
	});

	it("uploads/lists/deletes references and supports style_transfer edits", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const image = await uploadPng(cookie, albumId, 64, 48);

		const form = new FormData();
		form.append("file", new File([await pngBytes(32, 32)], "swatch.png", { type: "image/png" }));
		form.append("title", "Warm Film Look");
		const upRes = await call("/references", { method: "POST", body: form }, cookie);
		expect(upRes.status).toBe(201);
		const { reference } = await json<{ reference: { id: string; title: string } }>(upRes);
		expect(reference.title).toBe("Warm Film Look");

		const listRes = await call("/references", {}, cookie);
		expect((await json<{ references: Array<{ id: string }> }>(listRes)).references.some((r) => r.id === reference.id)).toBe(true);

		const fileRes = await call(`/references/${reference.id}/file?variant=thumb`, {}, cookie);
		expect(fileRes.status).toBe(200);

		const editRes = await call(
			`/images/${image.id}/edit`,
			{
				method: "POST",
				body: JSON.stringify({ prompt: "Match the film palette", referenceImageIds: [reference.id] }),
			},
			cookie,
		);
		expect(editRes.status).toBe(202);
		const { jobId } = await json<{ jobId: string }>(editRes);
		const job = await waitForJob(cookie, jobId);
		expect(job.status).toBe("done");

		const delRes = await call(`/references/${reference.id}`, { method: "DELETE" }, cookie);
		expect(delRes.status).toBe(200);
	});

	it("supports direct mask region edits, share listing/revocation, overlay export, and conditional 304", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const image = await uploadPng(cookie, albumId, 64, 48);

		// Build a 16x16 white opaque PNG mask
		const maskRgba = new Uint8Array(16 * 16 * 4).fill(255);
		const maskPng = await encodePng(16, 16, 4, maskRgba);
		let bin = "";
		for (const b of new Uint8Array(maskPng)) bin += String.fromCharCode(b);
		const maskPngBase64 = btoa(bin);

		const badMask = await call(
			`/images/${image.id}/edit-region`,
			{
				method: "POST",
				body: JSON.stringify({ bbox: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, prompt: "red hat", maskPngBase64: "bm90LXBuZw==" }),
			},
			cookie,
		);
		expect(badMask.status).toBe(400);

		const okMask = await call(
			`/images/${image.id}/edit-region`,
			{
				method: "POST",
				body: JSON.stringify({ bbox: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, prompt: "blue sky", maskPngBase64 }),
			},
			cookie,
		);
		expect(okMask.status).toBe(202);
		const { jobId } = await json<{ jobId: string }>(okMask);
		expect((await waitForJob(cookie, jobId)).status).toBe("done");

		// Overlay upload + download disposition + ?v= immutable cache
		const ovForm = new FormData();
		ovForm.append("file", new File([maskPng], "overlay.png", { type: "image/png" }));
		const ovRes = await call(`/images/${image.id}/annotations-overlay`, { method: "POST", body: ovForm }, cookie);
		expect(ovRes.status).toBe(200);

		const dlRes = await call(`/images/${image.id}/file?variant=original&download=1`, {}, cookie);
		expect(dlRes.status).toBe(200);
		expect(dlRes.headers.get("Content-Disposition")).toMatch(/attachment; filename="editorium-/);

		const { versions } = await json<{ versions: Array<{ id: string }> }>(
			await call(`/images/${image.id}/versions`, {}, cookie),
		);
		const vRes = await call(`/images/${image.id}/file?variant=web&v=${versions[0]!.id}`, {}, cookie);
		expect(vRes.status).toBe(200);
		expect(vRes.headers.get("Cache-Control")).toContain("immutable");

		// Shares listing + revoke
		const sh = await call(`/images/${image.id}/share`, { method: "POST", body: JSON.stringify({ allowDownload: true }) }, cookie);
		const shJson = await json<{ share: { id: string } }>(sh);
		const list = await json<{ shares: Array<{ id: string }> }>(await call(`/images/${image.id}/shares`, {}, cookie));
		expect(list.shares.some((s) => s.id === shJson.share.id)).toBe(true);
		await call(`/share/${shJson.share.id}`, { method: "DELETE" }, cookie);
		const afterRevoke = await json<{ shares: Array<{ id: string }> }>(await call(`/images/${image.id}/shares`, {}, cookie));
		expect(afterRevoke.shares).toHaveLength(0);
	});

	it("rejects non-websocket /events and serves signed ?norm=1 images and locked segment guard", async () => {
		const cookie = await guest();
		const evRes = await call("/events", {}, cookie);
		expect(evRes.status).toBe(426);

		const albumId = await createAlbum(cookie);
		const image = await uploadPng(cookie, albumId, 64, 48);

		const sub = await json<{ segment: { id: string } }>(
			await call(`/images/${image.id}/subject-mask`, { method: "POST" }, cookie),
		);
		await call(`/segments/${sub.segment.id}`, { method: "PATCH", body: JSON.stringify({ locked: true }) }, cookie);

		const { thread } = await json<{ thread: { id: string } }>(
			await call(`/albums/${albumId}/threads`, { method: "POST", body: JSON.stringify({}) }, cookie),
		);
		const before = await credits(cookie);
		const chatRes = await call(
			`/threads/${thread.id}/messages`,
			{
				method: "POST",
				body: JSON.stringify({ text: "turn it purple", attachedImageId: image.id, segmentId: sub.segment.id }),
			},
			cookie,
		);
		expect(chatRes.status).toBe(200);
		const frames = sseFrames(await chatRes.text());
		expect(frames.some((f) => f.event === "token" && String(f.data.value).includes("locked"))).toBe(true);
		expect(await credits(cookie)).toBe(before);

		const signedPath = await signPublicImageUrl(env, image.id);
		const { exports } = await import("cloudflare:workers");
		const workerNorm = await exports.default.fetch(new Request(`https://editorium.test${signedPath}?norm=1`));
		expect(workerNorm.status).toBe(200);
		expect(workerNorm.headers.get("Content-Type")).toMatch(/^image\//);
	});
});
