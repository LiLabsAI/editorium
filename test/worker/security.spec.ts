import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { users } from "../../database/schema";
import { createDb } from "../../src/worker/lib/db";
import {
	call,
	createAlbum,
	guest,
	json,
	pngBytes,
	sseFrames,
	upload,
	uploadPng,
} from "./helpers";

describe("auth (C1): every browser gets its own private account", () => {
	it("two guests are different users and cannot see each other's albums", async () => {
		const owner = await guest();
		await createAlbum(owner, "Private album");
		const stranger = await guest();

		const a = await json<{ user: { id: string } }>(await call("/me", {}, owner));
		const b = await json<{ user: { id: string } }>(await call("/me", {}, stranger));
		expect(a.user.id).not.toBe(b.user.id);

		const seen = await json<{ albums: Array<{ title: string }> }>(await call("/albums", {}, stranger));
		expect(seen.albums.map((x) => x.title)).not.toContain("Private album");
	});

	it("the old demo login that handed out the owner's session is gone", async () => {
		const res = await call("/auth/demo", { method: "POST", body: "{}" });
		expect(res.status).toBe(404);
	});

	it("guest creation is idempotent for an existing session", async () => {
		const cookie = await guest();
		const again = await call("/auth/guest", { method: "POST" }, cookie);
		expect(again.status).toBe(200);
		expect((await json<{ created: boolean }>(again)).created).toBe(false);
	});

	it("the owner account is reclaimable only with the claim key", async () => {
		await createDb(env.DB)
			.insert(users)
			.values({ id: "owner-user-for-tests", name: "Owner" })
			.onConflictDoNothing();
		const wrong = await call("/auth/claim", {
			method: "POST",
			body: JSON.stringify({ key: "nope" }),
			headers: { "CF-Connecting-IP": "198.51.100.1" },
		});
		expect(wrong.status).toBe(403);

		const right = await call("/auth/claim", {
			method: "POST",
			body: JSON.stringify({ key: "test-owner-claim-key" }),
			headers: { "CF-Connecting-IP": "198.51.100.2" },
		});
		expect(right.status).toBe(200);
		const cookie = right.headers.get("Set-Cookie")!;
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure"); // https origin
		const me = await json<{ user: { id: string } }>(await call("/me", {}, cookie.split(";")[0]));
		expect(me.user.id).toBe("owner-user-for-tests");
	});

	it("a forged or tampered session cookie is rejected", async () => {
		const cookie = await guest();
		const tampered = cookie.slice(0, -2) + (cookie.endsWith("A") ? "BB" : "AA");
		expect((await call("/albums", {}, tampered)).status).toBe(401);
	});
});

describe("errors (H1): statuses instead of 500s", () => {
	it("anonymous requests to protected routes get 401", async () => {
		for (const path of ["/albums", "/images/x", "/jobs/x", "/usage"]) {
			const res = await call(path);
			expect(res.status, path).toBe(401);
			expect(await res.json()).toEqual({ error: "unauthorized" });
		}
	});

	it("malformed JSON and invalid bodies get 400", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const image = await uploadPng(cookie, albumId);
		const bad = await call(`/images/${image.id}/edit`, { method: "POST", body: "not json" }, cookie);
		expect(bad.status).toBe(400);
		const invalid = await call(
			`/images/${image.id}/instructions`,
			{ method: "POST", body: JSON.stringify({ text: "x", bbox: { x: "NaN" } }) },
			cookie,
		);
		expect(invalid.status).toBe(400);
	});

	it("unknown API routes are JSON 404s and responses carry security headers", async () => {
		const res = await call("/nope");
		expect(res.status).toBe(404);
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
	});
});

describe("uploads (C3, M1, M2)", () => {
	it("rejects SVG (script-capable) uploads", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;
		const res = await upload(cookie, albumId, svg, "x.svg", "image/svg+xml");
		expect(res.status).toBe(415);
	});

	it("tiny or bogus files are a clean 415, not a crash", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		for (const body of ["", "ab", "<svg/>", "not an image at all"]) {
			const res = await upload(cookie, albumId, body, "x.png");
			expect(res.status, JSON.stringify(body)).toBe(415);
		}
	});

	it("stores real dimensions and serves media with hardening headers", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const image = await uploadPng(cookie, albumId, 64, 48);
		expect(image.widthPx).toBe(64);
		expect(image.heightPx).toBe(48);
		const file = await call(`/images/${image.id}/file?variant=original`, {}, cookie);
		expect(file.status).toBe(200);
		expect(file.headers.get("Content-Type")).toBe("image/png");
		expect(file.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(file.headers.get("Content-Security-Policy")).toContain("sandbox");
	});

	it("legacy non-raster objects are forced to download, never rendered", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const image = await uploadPng(cookie, albumId);
		const { getObject } = await import("../../src/worker/lib/r2");
		await env.MEDIA.put("legacy/evil.svg", "<svg><script>alert(1)</script></svg>", {
			httpMetadata: { contentType: "image/svg+xml" },
		});
		const res = (await getObject(env.MEDIA, "legacy/evil.svg"))!;
		expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(res.headers.get("Content-Disposition")).toBe("attachment");
		void image;
	});
});

describe("ownership (H5)", () => {
	it("another user's image is a 404 on every image route", async () => {
		const a = await guest();
		const image = await uploadPng(a, await createAlbum(a));
		const b = await guest();
		for (const path of [`/images/${image.id}`, `/images/${image.id}/file`, `/images/${image.id}/branch`]) {
			expect((await call(path, {}, b)).status, path).toBe(404);
		}
		expect(
			(await call(`/images/${image.id}/edit`, { method: "POST", body: JSON.stringify({ prompt: "x" }) }, b)).status,
		).toBe(404);
	});

	it("chat cannot target a photo outside the thread's album", async () => {
		const victim = await guest();
		const secret = await uploadPng(victim, await createAlbum(victim));
		const attacker = await guest();
		const albumId = await createAlbum(attacker);
		const { thread } = await json<{ thread: { id: string } }>(
			await call(`/albums/${albumId}/threads`, { method: "POST", body: "{}" }, attacker),
		);
		const res = await call(
			`/threads/${thread.id}/messages`,
			{ method: "POST", body: JSON.stringify({ text: "describe this photo", attachedImageId: secret.id }) },
			attacker,
		);
		const frames = sseFrames(await res.text());
		// Attacker's album is empty: the victim's photo is never resolved, so
		// no job targets it and no caption of it is produced.
		expect(frames.some((f) => f.event === "tool" && f.data.imageId === secret.id)).toBe(false);
		const { messages } = await json<{ messages: Array<{ attachedImageId: string | null }> }>(
			await call(`/threads/${thread.id}/messages`, {}, attacker),
		);
		expect(messages.every((m) => m.attachedImageId !== secret.id)).toBe(true);
	});
});

describe("sharing (H7)", () => {
	it("share links work by token only, and honour allowDownload", async () => {
		const cookie = await guest();
		const image = await uploadPng(cookie, await createAlbum(cookie));
		const { url } = await json<{ url: string }>(
			await call(`/images/${image.id}/share`, { method: "POST", body: JSON.stringify({ allowDownload: false }) }, cookie),
		);
		const token = url.split("/").pop()!;

		const meta = await call(`/public/share/${token}`);
		expect(meta.status).toBe(200);
		expect((await call(`/public/share/${token}/file?variant=web`)).status).toBe(200);
		expect((await call(`/public/share/${token}/file?variant=original`)).status).toBe(403);
		// The old id-based public endpoint is gone: an image id grants nothing.
		expect((await call(`/public/images/${image.id}/file`)).status).toBe(404);
	});

	it("revoked links stop working", async () => {
		const cookie = await guest();
		const image = await uploadPng(cookie, await createAlbum(cookie));
		const { url, share } = await json<{ url: string; share: { id: string } }>(
			await call(`/images/${image.id}/share`, { method: "POST", body: "{}" }, cookie),
		);
		await call(`/share/${share.id}`, { method: "DELETE" }, cookie);
		expect((await call(`/public/share/${url.split("/").pop()}/file`)).status).toBe(404);
	});
});

describe("R2 cleanup (M9)", () => {
	it("deleting an image removes its objects and repoints the album cover", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const first = await uploadPng(cookie, albumId);
		const second = await uploadPng(cookie, albumId);
		const me = await json<{ user: { id: string } }>(await call("/me", {}, cookie));
		const prefix = `u/${me.user.id}/a/${albumId}/i/${first.id}/`;
		expect((await env.MEDIA.list({ prefix })).objects.length).toBeGreaterThan(0);

		expect((await call(`/images/${first.id}`, { method: "DELETE" }, cookie)).status).toBe(200);
		await new Promise((r) => setTimeout(r, 50));
		expect((await env.MEDIA.list({ prefix })).objects.length).toBe(0);
		const { album } = await json<{ album: { coverImageId: string | null } }>(await call(`/albums/${albumId}`, {}, cookie));
		expect(album.coverImageId).toBe(second.id);
	});
});

void pngBytes;

describe("variants keep the photo's shape (H6/M1)", () => {
	it("the web variant of a small landscape photo is neither upscaled nor squashed", async () => {
		const cookie = await guest();
		const image = await uploadPng(cookie, await createAlbum(cookie), 120, 80);
		const web = await call(`/images/${image.id}/file?variant=web`, {}, cookie);
		const { imageDimensions } = await import("../../src/worker/lib/r2");
		expect(imageDimensions(await web.arrayBuffer())).toEqual({ width: 120, height: 80 });
	});
});
