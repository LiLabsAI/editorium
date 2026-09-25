import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { call, createAlbum, guest, json, uploadPng } from "./helpers";

describe("Worker API", () => {
	it("returns the API identity and health payloads", async () => {
		const root = await exports.default.fetch("http://example.com/api/");
		expect(root.status).toBe(200);
		expect(await root.json()).toEqual({ name: "editorium" });

		const health = await exports.default.fetch("http://example.com/api/health");
		expect(await health.json()).toEqual({ status: "ok", database: "ok" });
	});

	it("creates a session, project, album and registers an image", async () => {
		const cookie = await guest();
		const { project } = await json<{ project: { id: string } }>(await call("/albums", {}, cookie));
		expect(project.id).toBeTruthy();

		const albumId = await createAlbum(cookie, "Test Album");
		const image = await uploadPng(cookie, albumId, 4, 3);
		expect(image.widthPx).toBe(4);

		const { images } = await json<{ images: Array<{ id: string; segmentStatus: string }> }>(
			await call(`/albums/${albumId}/images`, {}, cookie),
		);
		expect(images).toHaveLength(1);
		expect(images[0]!.segmentStatus).toBe("none");
	});

	it("rejects anonymous access to protected routes", async () => {
		const res = await exports.default.fetch(new Request("http://example.com/api/albums"));
		expect(res.status).toBe(401);
	});
});
