import { and, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import { Hono } from "hono";

import {
	albums,
	chatMessages,
	chatThreads,
	imagePalettes,
	imageVersions,
	images,
	jobs,
	palettes,
	projects,
	references,
	segmentPrompts,
	segments,
	shareLinks,
	imageAnnotations,
	editInstructions,
} from "../../../database/schema";
import { ensureProject, getUser, requireUser } from "../lib/auth";
import { createDb } from "../lib/db";
import { createJob, enqueueJob } from "../lib/jobs";
import { getProvider } from "../lib/providers";
import { deriveVariants } from "../lib/operations";
import {
	extForMime,
	getObject,
	imageDimensions,
	mediaKeys,
	putObject,
	sniffMime,
	validateImageMime,
} from "../lib/r2";

export const api = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Auth (demo-grade session bootstrap; swap for a real flow in production)
// ---------------------------------------------------------------------------

api.post("/auth/demo", async (c) => {
	const db = createDb(c.env.DB);
	const { makeSessionToken, sessionCookie } = await import("../lib/auth");
	const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
	const name = (body.name ?? "Md Ahad Ali").slice(0, 60);
	const [existing] = await db.select().from(projects).orderBy(desc(projects.createdAt)).limit(1);
	let userId: string;
	if (existing) {
		const { users } = await import("../../../database/schema");
		const [owner] = await db.select().from(users).where(eq(users.id, existing.ownerId)).limit(1);
		userId = owner?.id ?? crypto.randomUUID();
		if (!owner) {
			await db.insert(users).values({ id: userId, name });
		}
	} else {
		userId = crypto.randomUUID();
		const { users } = await import("../../../database/schema");
		await db.insert(users).values({ id: userId, name });
	}
	const token = await makeSessionToken(userId, c.env.AUTH_SECRET);
	c.header("Set-Cookie", sessionCookie(token));
	return c.json({ ok: true, userId });
});

api.get("/me", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ user: null }, 200);
	const project = await ensureProject(c, user);
	return c.json({
		user: { id: user.id, name: user.name, plan: user.plan, credits: user.creditBalance },
		project: { id: project.id, name: project.name },
	});
});

// ---------------------------------------------------------------------------
// Projects / albums (dashboard, Screen A)
// ---------------------------------------------------------------------------

api.get("/albums", async (c) => {
	const user = await requireUser(c).catch(() => null);
	if (!user) return c.json({ error: "unauthorized" }, 401);
	const project = await ensureProject(c, user);
	const db = createDb(c.env.DB);
	const sort = c.req.query("sort") ?? "newest";
	const q = c.req.query("q");
	const rows = await db
		.select({
			id: albums.id,
			title: albums.title,
			createdAt: albums.createdAt,
			updatedAt: albums.updatedAt,
			coverImageId: albums.coverImageId,
			imageCount: sql<number>`(SELECT COUNT(*) FROM images WHERE images.album_id = ${albums.id})`,
		})
		.from(albums)
		.where(
			q
				? and(eq(albums.projectId, project.id), like(albums.title, `%${q}%`))
				: eq(albums.projectId, project.id),
		);
	const sorted = [...rows].sort((a, b) =>
		sort === "oldest"
			? a.createdAt.getTime() - b.createdAt.getTime()
			: sort === "name"
				? a.title.localeCompare(b.title)
				: b.createdAt.getTime() - a.createdAt.getTime(),
	);
	return c.json({
		project: { id: project.id, name: project.name },
		albums: sorted,
	});
});

api.post("/albums", async (c) => {
	const user = await requireUser(c);
	const project = await ensureProject(c, user);
	const db = createDb(c.env.DB);
	const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
	const [album] = await db
		.insert(albums)
		.values({
			id: crypto.randomUUID(),
			projectId: project.id,
			title: body.title?.trim() || "Untitled album",
		})
		.returning();
	return c.json({ album }, 201);
});

api.get("/albums/:id", async (c) => {
	const user = await requireUser(c);
	const project = await ensureProject(c, user);
	const db = createDb(c.env.DB);
	const [album] = await db
		.select()
		.from(albums)
		.where(and(eq(albums.id, c.req.param("id")), eq(albums.projectId, project.id)))
		.limit(1);
	if (!album) return c.json({ error: "not_found" }, 404);
	return c.json({ album });
});

api.patch("/albums/:id", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const body = await c.req.json<{ title?: string }>();
	const project = await ensureProject(c, user);
	const [updated] = await db
		.update(albums)
		.set({ title: body.title?.slice(0, 120), updatedAt: new Date() })
		.where(and(eq(albums.id, c.req.param("id")), eq(albums.projectId, project.id)))
		.returning();
	if (!updated) return c.json({ error: "not_found" }, 404);
	return c.json({ album: updated });
});

api.delete("/albums/:id", async (c) => {
	const user = await requireUser(c);
	const project = await ensureProject(c, user);
	const db = createDb(c.env.DB);
	await db
		.delete(albums)
		.where(and(eq(albums.id, c.req.param("id")), eq(albums.projectId, project.id)));
	return c.json({ ok: true });
});

api.get("/references", async (c) => {
	const user = await requireUser(c);
	const project = await ensureProject(c, user);
	const db = createDb(c.env.DB);
	const rows = await db
		.select()
		.from(references)
		.where(eq(references.projectId, project.id));
	return c.json({ references: rows });
});

// ---------------------------------------------------------------------------
// Images (upload pipeline, Screen B cards + editor)
// ---------------------------------------------------------------------------

async function ownedImage(c: { req: { param: (k: string) => string } }, env: Env, userId: string) {
	const db = createDb(env.DB);
	const [row] = await db
		.select({ image: images, album: albums })
		.from(images)
		.innerJoin(albums, eq(albums.id, images.albumId))
		.innerJoin(projects, eq(projects.id, albums.projectId))
		.where(eq(images.id, c.req.param("id")))
		.limit(1);
	if (!row || row.album.projectId !== (await projectOf(env, userId))?.id) return null;
	return row;
}

async function projectOf(env: Env, userId: string) {
	const db = createDb(env.DB);
	const [project] = await db
		.select()
		.from(projects)
		.where(eq(projects.ownerId, userId))
		.limit(1);
	return project ?? null;
}

api.get("/albums/:id/images", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const filter = c.req.query("filter") ?? "all";
	const conditions = [eq(albums.id, c.req.param("id")), eq(albums.projectId, (await ensureProject(c, user)).id)];
	const rows = await db
		.select({ image: images, albumId: albums.id })
		.from(images)
		.innerJoin(albums, eq(albums.id, images.albumId))
		.where(and(...conditions))
		.orderBy(images.positionIdx, images.createdAt);
	const filtered = rows.filter((r) =>
		filter === "all" ? true : filter === "uploads" ? r.image.kind === "upload" : r.image.kind !== "upload",
	);
	return c.json({ images: filtered.map((r) => r.image) });
});

api.get("/images/:id", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const versions = await db
		.select()
		.from(imageVersions)
		.where(eq(imageVersions.imageId, row.image.id))
		.orderBy(imageVersions.createdAt);
	return c.json({ image: row.image, versions });
});

api.get("/images/:id/file", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const variant = c.req.query("variant") ?? "web";
	const versionParam = c.req.query("v");
	const keys = mediaKeys(user.id, row.album.id, row.image.id);
	const db = createDb(c.env.DB);
	let key: string;
	if (versionParam) {
		// Version-scoped serving (plan 18): web/thumb fall back to the version
		// full object when derivatives are missing.
		const [version] = await db
			.select()
			.from(imageVersions)
			.where(and(eq(imageVersions.id, versionParam), eq(imageVersions.imageId, row.image.id)))
			.limit(1);
		if (!version) return c.json({ error: "not_found" }, 404);
		key =
			variant === "original"
				? version.r2KeyFull
				: variant === "thumb"
					? (version.r2KeyThumb ?? version.r2KeyFull)
					: (version.r2KeyWeb ?? version.r2KeyFull);
	} else {
		key =
			variant === "original"
				? row.image.currentVersionId
					? (await currentVersionKey(c.env, row.image.id)) ?? row.image.r2KeyOriginal
					: row.image.r2KeyOriginal
				: variant === "thumb"
					? (row.image.r2KeyThumb ?? keys.thumb)
					: (row.image.r2KeyWeb ?? keys.web);
	}
	const res = await getObject(c.env.MEDIA, key);
	return res ?? c.json({ error: "not_found" }, 404);
});

async function currentVersionKey(env: Env, imageId: string): Promise<string | null> {
	const db = createDb(env.DB);
	const [image] = await db.select().from(images).where(eq(images.id, imageId)).limit(1);
	if (!image?.currentVersionId) return null;
	const [version] = await db
		.select()
		.from(imageVersions)
		.where(eq(imageVersions.id, image.currentVersionId))
		.limit(1);
	return version?.r2KeyFull ?? null;
}

/**
 * Register an uploaded object. Two paths:
 *  - multipart POST (dev + small files): body streams through the Worker to R2
 *  - PUT to a presigned URL, then POST /images with the r2 key (production)
 */
api.post("/albums/:id/upload", async (c) => {
	const user = await requireUser(c);
	const project = await ensureProject(c, user);
	const db = createDb(c.env.DB);
	const [album] = await db
		.select()
		.from(albums)
		.where(and(eq(albums.id, c.req.param("id")), eq(albums.projectId, project.id)))
		.limit(1);
	if (!album) return c.json({ error: "not_found" }, 404);

	const form = await c.req.parseBody();
	const file = form["file"];
	if (!(file instanceof File)) return c.json({ error: "file_required" }, 400);
	const declared = file.type || "application/octet-stream";
	const bytes = await file.arrayBuffer();

	const sniffed = sniffMime(bytes, declared);
	if (!sniffed) return c.json({ error: "not_an_image" }, 415);
	const sizeError = validateImageMime(sniffed, bytes.byteLength);
	if (sizeError) return c.json({ error: sizeError }, 413);

	const imageId = crypto.randomUUID();
	const keys = mediaKeys(user.id, album.id, imageId);
	const ext = extForMime(sniffed);
	const r2Key = keys.original(ext);
	await putObject(c.env.MEDIA, r2Key, bytes, sniffed);

	const dims = imageDimensions(bytes) ?? { width: 0, height: 0 };
	const [image] = await db
		.insert(images)
		.values({
			id: imageId,
			albumId: album.id,
			kind: "upload",
			r2KeyOriginal: r2Key,
			mime: sniffed,
			widthPx: dims.width,
			heightPx: dims.height,
			sizeBytes: bytes.byteLength,
			filenameLabel: file.name || `${imageId.slice(0, 8).toUpperCase()}`,
			segmentStatus: "none",
		})
		.returning();

	const rootVersionId = crypto.randomUUID();
	await db.insert(imageVersions).values({
		id: rootVersionId,
		imageId,
		label: "Original",
		r2KeyFull: r2Key,
		operation: "upload",
	});
	await db.update(images).set({ currentVersionId: rootVersionId }).where(eq(images.id, imageId));
	const scoped = await deriveVariants(c.env, {
		userId: user.id,
		albumId: album.id,
		imageId,
		r2KeyOriginal: r2Key,
		mime: sniffed,
		versionId: rootVersionId,
	});
	if (scoped) {
		await db
			.update(imageVersions)
			.set({ r2KeyWeb: scoped.web, r2KeyThumb: scoped.thumb })
			.where(eq(imageVersions.id, rootVersionId));
	}
	if (!album.coverImageId) {
		await db.update(albums).set({ coverImageId: imageId }).where(eq(albums.id, album.id));
	}

	// Auto-detection removed (user decision): regions are user-drawn now.
	return c.json({ image, segmentJobId: null }, 201);
});

api.patch("/images/:id", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const body = await c.req.json<{
		filenameLabel?: string;
		bookmarked?: boolean;
		positionIdx?: number;
	}>();
	const [updated] = await db
		.update(images)
		.set({
			filenameLabel: body.filenameLabel?.slice(0, 80),
			bookmarkedAt: body.bookmarked === undefined ? undefined : body.bookmarked ? new Date() : null,
			positionIdx: body.positionIdx,
		})
		.where(eq(images.id, row.image.id))
		.returning();
	return c.json({ image: updated });
});

api.delete("/images/:id", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	await db.delete(images).where(eq(images.id, row.image.id));
	return c.json({ ok: true });
});

// Versions (plan 11)
api.get("/images/:id/versions", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const versions = await db
		.select()
		.from(imageVersions)
		.where(eq(imageVersions.imageId, row.image.id))
		.orderBy(imageVersions.createdAt);
	return c.json({ versions, currentId: row.image.currentVersionId });
});

api.post("/images/:id/versions/:versionId/activate", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const [version] = await db
		.select()
		.from(imageVersions)
		.where(and(eq(imageVersions.id, c.req.param("versionId")), eq(imageVersions.imageId, row.image.id)))
		.limit(1);
	if (!version) return c.json({ error: "not_found" }, 404);
	// Ensure the activated version has its own web/thumb derivatives so the
	// canvas truly switches pixels (plan 18).
	if (!version.r2KeyWeb || !version.r2KeyThumb) {
		await deriveVariantsFromVersion(c.env, user.id, row.album.id, row.image.id, version);
	}
	await db
		.update(images)
		.set({ currentVersionId: version.id })
		.where(eq(images.id, row.image.id));
	return c.json({ ok: true, currentId: version.id });
});

/** Derive web/thumb variants from a specific version's full object and store
 * them under version-scoped keys, keeping immutable caching correct (plan 18). */
async function deriveVariantsFromVersion(
	env: Env,
	userId: string,
	albumId: string,
	imageId: string,
	version: typeof imageVersions.$inferSelect,
): Promise<void> {
	const db = createDb(env.DB);
	const { putObject, mediaKeys } = await import("../lib/r2");
	const { transformWithImagesBytes } = await import("../lib/operations");
	const obj = await env.MEDIA.get(version.r2KeyFull);
	if (!obj) return;
	const bytes = await obj.arrayBuffer();
	const keys = mediaKeys(userId, albumId, imageId);
	const vKeys = {
		web: `u/${userId}/a/${albumId}/i/${imageId}/v/${version.id}/web.webp`,
		thumb: `u/${userId}/a/${albumId}/i/${imageId}/v/${version.id}/thumb.webp`,
	};
	let web: ArrayBuffer | null = null;
	let thumb: ArrayBuffer | null = null;
	try {
		web = await transformWithImagesBytes(env, bytes, 1600);
		thumb = await transformWithImagesBytes(env, bytes, 512);
	} catch {
		web = null;
		thumb = null;
	}
	const contentType = web ? "image/webp" : "application/octet-stream";
	await putObject(env.MEDIA, vKeys.web, web ?? bytes, contentType);
	await putObject(env.MEDIA, vKeys.thumb, thumb ?? bytes, contentType);
	await db
		.update(imageVersions)
		.set({ r2KeyWeb: vKeys.web, r2KeyThumb: vKeys.thumb })
		.where(eq(imageVersions.id, version.id));
	void keys;
}

// Client-side filter preset → branched photo (B&W, golden hour: deterministic
// pixel transforms, composition-perfect, no AI model needed).
api.post("/images/:id/filter-branch", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const form = await c.req.parseBody();
	const file = form["file"];
	const label = String(form["label"] ?? "Filtered");
	if (!(file instanceof File)) return c.json({ error: "file_required" }, 400);
	const bytes = await file.arrayBuffer();
	if (bytes.byteLength === 0 || bytes.byteLength > 15 * 1024 * 1024) {
		return c.json({ error: "invalid_file" }, 400);
	}
	if (!(await rateLimit(c.env, user.id, row.image.id, 20))) {
		return c.json({ error: "rate_limited" }, 429);
	}
	const db = createDb(c.env.DB);
	const imageId = crypto.randomUUID();
	const versionId = crypto.randomUUID();
	const keys = mediaKeys(user.id, row.album.id, imageId);
	const r2Key = keys.original("png");
	await c.env.MEDIA.put(r2Key, bytes, {
		httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" },
	});
	const { images: imagesTable } = await import("../../../database/schema");
	await db.insert(imagesTable).values({
		id: imageId,
		albumId: row.album.id,
		kind: "edited",
		r2KeyOriginal: r2Key,
		mime: "image/png",
		widthPx: row.image.widthPx,
		heightPx: row.image.heightPx,
		sizeBytes: bytes.byteLength,
		sourceImageId: row.image.id,
		filenameLabel: label.slice(0, 60),
		segmentStatus: "none",
	});
	await db.insert(imageVersions).values({
		id: versionId,
		imageId,
		label,
		r2KeyFull: r2Key,
		operation: "filter",
	});
	await db.update(imagesTable).set({ currentVersionId: versionId }).where(eq(imagesTable.id, imageId));
	return c.json({ imageId, versionId }, 201);
});

// Direct whole-photo instruction edit (rebuild step 0 core loop).
api.post("/images/:id/edit", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const body = await c.req.json<{ prompt: string }>();
	if (!body.prompt?.trim()) return c.json({ error: "prompt_required" }, 400);
	if (!(await rateLimit(c.env, user.id, row.image.id, 12))) {
		return c.json({ error: "rate_limited" }, 429);
	}
	const db = createDb(c.env.DB);
	const jobId = await createJob(db, {
		type: "inpaint",
		userId: user.id,
		imageId: row.image.id,
		payload: { prompt: body.prompt },
	});
	const { chargeCredits } = await import("../lib/jobs");
	const charge = await chargeCredits(db, user.id, 2, "inpaint", jobId);
	if (!charge.ok) {
		await db.delete(jobs).where(eq(jobs.id, jobId));
		return c.json({ error: "insufficient_credits", balance: charge.balance }, 402);
	}
	await enqueueJob(c.env.AI_JOBS, jobId, "inpaint", {
		jobId,
		type: "inpaint",
		userId: user.id,
		imageId: row.image.id,
		prompt: body.prompt.slice(0, 500),
	});
	return c.json({ jobId }, 202);
});

// Region edit + enhance (plan 16) — metered, queued, job-polled.
api.post("/images/:id/edit-region", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const body = await c.req.json<{ segmentId: string; prompt?: string; mode?: string }>();
	if (!body.segmentId) return c.json({ error: "segment_required" }, 400);
	const segment = await ownedSegment(c.env, user.id, body.segmentId);
	if (!segment || segment.imageId !== row.image.id) return c.json({ error: "not_found" }, 404);
	if (segment.lockedAt) return c.json({ error: "segment_locked" }, 409);
	if (!(await rateLimit(c.env, user.id, row.image.id, 12))) {
		return c.json({ error: "rate_limited" }, 429);
	}
	const db = createDb(c.env.DB);
	const jobId = await createJob(db, {
		type: "inpaint",
		userId: user.id,
		imageId: row.image.id,
		segmentId: segment.id,
		payload: { prompt: body.prompt, mode: body.mode ?? "balanced" },
	});
	const { chargeCredits } = await import("../lib/jobs");
	const charge = await chargeCredits(db, user.id, 2, "inpaint", jobId);
	if (!charge.ok) {
		await db.delete(jobs).where(eq(jobs.id, jobId));
		return c.json({ error: "insufficient_credits", balance: charge.balance }, 402);
	}
	await enqueueJob(c.env.AI_JOBS, jobId, "inpaint", {
		jobId,
		type: "inpaint",
		userId: user.id,
		imageId: row.image.id,
		segmentId: segment.id,
		prompt: body.prompt ?? segment.caption ?? `redraw the ${segment.label}`,
		mode: (body.mode ?? "balanced") as "literal" | "balanced" | "creative",
	});
	return c.json({ jobId }, 202);
});

api.post("/images/:id/enhance", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const body = await c.req.json<{ strength?: number }>().catch(() => ({}) as { strength?: number });
	if (!(await rateLimit(c.env, user.id, row.image.id, 12))) {
		return c.json({ error: "rate_limited" }, 429);
	}
	const db = createDb(c.env.DB);
	const jobId = await createJob(db, { type: "enhance", userId: user.id, imageId: row.image.id });
	const { chargeCredits } = await import("../lib/jobs");
	const charge = await chargeCredits(db, user.id, 3, "enhance", jobId);
	if (!charge.ok) {
		await db.delete(jobs).where(eq(jobs.id, jobId));
		return c.json({ error: "insufficient_credits", balance: charge.balance }, 402);
	}
	await enqueueJob(c.env.AI_JOBS, jobId, "enhance", {
		jobId,
		type: "enhance",
		userId: user.id,
		imageId: row.image.id,
		strength: body.strength ?? 0.8,
	});
	return c.json({ jobId }, 202);
});

// Palettes (plan 12)
api.post("/images/:id/palette", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const body = await c.req.json<{ colors: string[]; segmentId?: string }>();
	if (!Array.isArray(body.colors) || body.colors.length === 0 || body.colors.length > 8) {
		return c.json({ error: "invalid_colors" }, 400);
	}
	const db = createDb(c.env.DB);
	const [palette] = await db
		.insert(palettes)
		.values({
			id: crypto.randomUUID(),
			ownerId: user.id,
			colorsJson: JSON.stringify(body.colors.slice(0, 8)),
			source: "extracted",
		})
		.returning();
	await db.insert(imagePalettes).values({
		imageId: row.image.id,
		paletteId: palette!.id,
		scope: body.segmentId ? "segment" : "image",
		segmentId: body.segmentId,
	});
	return c.json({ palette }, 201);
});

api.get("/images/:id/palettes", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const rows = await db
		.select({ palette: palettes, link: imagePalettes })
		.from(imagePalettes)
		.innerJoin(palettes, eq(palettes.id, imagePalettes.paletteId))
		.where(eq(imagePalettes.imageId, row.image.id));
	return c.json({ palettes: rows });
});

// Segments (plans 9-10)
api.get("/images/:id/segments", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const rows = await db
		.select()
		.from(segments)
		.where(and(eq(segments.imageId, row.image.id), isNull(segments.deletedAt)))
		.orderBy(segments.orderIdx);
	// Honest labeling (plan 17): the client shows a Demo badge when the
	// recognizer cannot actually see the image.
	const recognizer = (c.env.AI_MOCK ?? "true").toLowerCase() === "true" ? "demo" : "live";
	return c.json({ segments: rows, status: row.image.segmentStatus, recognizer });
});

api.post("/images/:id/resegment", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const jobId = await createJob(db, { type: "segment", userId: user.id, imageId: row.image.id });
	await enqueueJob(c.env.AI_JOBS, jobId, "segment", { jobId, type: "segment", userId: user.id, imageId: row.image.id });
	await db.update(images).set({ segmentStatus: "pending" }).where(eq(images.id, row.image.id));
	return c.json({ jobId }, 202);
});


// Custom segment from a lasso polygon (plan 20): the drawn region becomes a
// first-class segment — selectable, promptable, regenerable.
api.post("/images/:id/segments", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const body = await c.req.json<{
		label?: string;
		polygon: Array<{ x: number; y: number }>;
	}>();
	if (!Array.isArray(body.polygon) || body.polygon.length < 3) {
		return c.json({ error: "polygon_required" }, 400);
	}
	const db = createDb(c.env.DB);
	const xs = body.polygon.map((p) => p.x);
	const ys = body.polygon.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	const w = Math.max(...xs) - x;
	const h = Math.max(...ys) - y;
	if (w < 0.01 || h < 0.01) return c.json({ error: "polygon_too_small" }, 400);
	const [segment] = await db
		.insert(segments)
		.values({
			id: crypto.randomUUID(),
			imageId: row.image.id,
			label: (body.label ?? "custom region").slice(0, 40),
			caption: "A hand-drawn region marked by you for targeted editing.",
			bboxX: x,
			bboxY: y,
			bboxW: w,
			bboxH: h,
			polygonJson: JSON.stringify(body.polygon),
			orderIdx: 1000 + Math.floor(Math.random() * 1000),
		})
		.returning();
	// Synthesize + persist the polygon mask for region edits.
	try {
		const { buildPolygonMask } = await import("../lib/mask");
		const dims = { width: row.image.widthPx || 1024, height: row.image.heightPx || 1280 };
		const mask = await buildPolygonMask(body.polygon, dims.width, dims.height);
		const { mediaKeys, putObject } = await import("../lib/r2");
		const keys = mediaKeys(user.id, row.album.id, row.image.id);
		await putObject(c.env.MEDIA, keys.segmentMask(segment.id), mask, "image/png");
		await db
			.update(segments)
			.set({ maskR2Key: keys.segmentMask(segment.id) })
			.where(eq(segments.id, segment.id));
	} catch {
		// edits fall back to box masks when mask synthesis fails
	}
	return c.json({ segment }, 201);
});

api.patch("/segments/:id", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const body = await c.req.json<{
		label?: string;
		bbox?: { x: number; y: number; w: number; h: number };
		locked?: boolean;
		hidden?: boolean;
	}>();
	const segment = await ownedSegment(c.env, user.id, c.req.param("id"));
	if (!segment) return c.json({ error: "not_found" }, 404);
	const [updated] = await db
		.update(segments)
		.set({
			label: body.label?.slice(0, 40),
			bboxX: body.bbox?.x,
			bboxY: body.bbox?.y,
			bboxW: body.bbox?.w,
			bboxH: body.bbox?.h,
			lockedAt: body.locked === undefined ? undefined : body.locked ? new Date() : null,
			hiddenAt: body.hidden === undefined ? undefined : body.hidden ? new Date() : null,
		})
		.where(eq(segments.id, segment.id))
		.returning();
	return c.json({ segment: updated });
});

api.delete("/segments/:id", async (c) => {
	const user = await requireUser(c);
	const segment = await ownedSegment(c.env, user.id, c.req.param("id"));
	if (!segment) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	await db
		.update(segments)
		.set({ deletedAt: new Date() })
		.where(eq(segments.id, segment.id));
	return c.json({ ok: true });
});

api.get("/segments/:id/prompts", async (c) => {
	const user = await requireUser(c);
	const segment = await ownedSegment(c.env, user.id, c.req.param("id"));
	if (!segment) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const rows = await db
		.select()
		.from(segmentPrompts)
		.where(eq(segmentPrompts.segmentId, segment.id))
		.orderBy(desc(segmentPrompts.createdAt));
	return c.json({ prompts: rows, caption: segment.caption });
});

api.post("/segments/:id/prompts", async (c) => {
	const user = await requireUser(c);
	const segment = await ownedSegment(c.env, user.id, c.req.param("id"));
	if (!segment) return c.json({ error: "not_found" }, 404);
	const body = await c.req.json<{ text: string }>();
	if (!body.text?.trim()) return c.json({ error: "text_required" }, 400);
	const db = createDb(c.env.DB);
	await db
		.update(segmentPrompts)
		.set({ isActive: false })
		.where(eq(segmentPrompts.segmentId, segment.id));
	const [prompt] = await db
		.insert(segmentPrompts)
		.values({ id: crypto.randomUUID(), segmentId: segment.id, text: body.text.slice(0, 1000) })
		.returning();
	await db.update(segments).set({ hasPrompt: true }).where(eq(segments.id, segment.id));
	return c.json({ prompt }, 201);
});

async function ownedSegment(env: Env, userId: string, segmentId: string) {
	const db = createDb(env.DB);
	const [row] = await db
		.select({ segment: segments, ownerId: projects.ownerId })
		.from(segments)
		.innerJoin(images, eq(images.id, segments.imageId))
		.innerJoin(albums, eq(albums.id, images.albumId))
		.innerJoin(projects, eq(projects.id, albums.projectId))
		.where(eq(segments.id, segmentId))
		.limit(1);
	if (!row || row.ownerId !== userId) return null;
	return row.segment;
}

// Chat (plans 5-6)
api.get("/albums/:id/threads", async (c) => {
	const user = await requireUser(c);
	const project = await ensureProject(c, user);
	const db = createDb(c.env.DB);
	const [album] = await db
		.select()
		.from(albums)
		.where(and(eq(albums.id, c.req.param("id")), eq(albums.projectId, project.id)))
		.limit(1);
	if (!album) return c.json({ error: "not_found" }, 404);
	const rows = await db
		.select()
		.from(chatThreads)
		.where(eq(chatThreads.albumId, album.id))
		.orderBy(desc(chatThreads.createdAt));
	return c.json({ threads: rows });
});

api.post("/albums/:id/threads", async (c) => {
	const user = await requireUser(c);
	const project = await ensureProject(c, user);
	const db = createDb(c.env.DB);
	const [album] = await db
		.select()
		.from(albums)
		.where(and(eq(albums.id, c.req.param("id")), eq(albums.projectId, project.id)))
		.limit(1);
	if (!album) return c.json({ error: "not_found" }, 404);
	const body = await c.req.json<{ new?: boolean }>().catch(() => ({}) as { new?: boolean });
	if (!body.new) {
		const [existing] = await db
			.select()
			.from(chatThreads)
			.where(eq(chatThreads.albumId, album.id))
			.orderBy(desc(chatThreads.createdAt))
			.limit(1);
		if (existing) return c.json({ thread: existing, reused: true });
	}
	const [thread] = await db
		.insert(chatThreads)
		.values({ id: crypto.randomUUID(), albumId: album.id })
		.returning();
	return c.json({ thread }, 201);
});

api.post("/threads/:id/messages", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const [thread] = await db
		.select({ thread: chatThreads, ownerId: projects.ownerId })
		.from(chatThreads)
		.innerJoin(albums, eq(albums.id, chatThreads.albumId))
		.innerJoin(projects, eq(projects.id, albums.projectId))
		.where(eq(chatThreads.id, c.req.param("id")))
		.limit(1);
	if (!thread || thread.ownerId !== user.id) return c.json({ error: "not_found" }, 404);
	const body = await c.req.json<{
		text: string;
		attachedImageId?: string;
		segmentId?: string;
		mentionImageIds?: string[];
		paletteIds?: string[];
	}>();
	if (!body.text?.trim()) return c.json({ error: "text_required" }, 400);
	if (!(await rateLimit(c.env, user.id, thread.thread.id, 12))) {
		return c.json({ error: "rate_limited" }, 429);
	}
	const { streamAgentResponse } = await import("../agent");
	const stream = streamAgentResponse(c.env, {
		threadId: thread.thread.id,
		albumId: thread.thread.albumId,
		user,
		text: body.text.slice(0, 2000),
		attachedImageId: body.attachedImageId,
		segmentId: body.segmentId,
		mentionImageIds: body.mentionImageIds,
		paletteIds: body.paletteIds,
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

api.get("/threads/:id/messages", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const [thread] = await db
		.select({ thread: chatThreads, ownerId: projects.ownerId })
		.from(chatThreads)
		.innerJoin(albums, eq(albums.id, chatThreads.albumId))
		.innerJoin(projects, eq(projects.id, albums.projectId))
		.where(eq(chatThreads.id, c.req.param("id")))
		.limit(1);
	if (!thread || thread.ownerId !== user.id) return c.json({ error: "not_found" }, 404);
	const rows = await db
		.select()
		.from(chatMessages)
		.where(eq(chatMessages.threadId, thread.thread.id))
		.orderBy(chatMessages.createdAt);
	return c.json({ messages: rows });
});

// Jobs
api.get("/jobs/:id", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const [job] = await db.select().from(jobs).where(eq(jobs.id, c.req.param("id"))).limit(1);
	if (!job || job.userId !== user.id) return c.json({ error: "not_found" }, 404);
	return c.json({ job });
});

/** Duplicate an image into the same album: copies rows + R2 objects (plan 20). */
api.post("/images/:id/duplicate", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const newId = crypto.randomUUID();
	const srcKeys = mediaKeys(user.id, row.album.id, row.image.id);
	const dstKeys = mediaKeys(user.id, row.album.id, newId);
	const ext = row.image.mime.split("/")[1] ?? "png";
	const copies: Array<[string | null, string]> = [
		[row.image.r2KeyOriginal, dstKeys.original(ext)],
		[row.image.r2KeyWeb, dstKeys.web],
		[row.image.r2KeyThumb, dstKeys.thumb],
	];
	for (const [src, dst] of copies) {
		if (!src) continue;
		const obj = await c.env.MEDIA.get(src);
		if (obj) {
			await c.env.MEDIA.put(dst, obj.body, {
				httpMetadata: {
					contentType: obj.httpMetadata?.contentType,
					cacheControl: obj.httpMetadata?.cacheControl,
				},
			});
		}
	}
	const [copy] = await db
		.insert(images)
		.values({
			id: newId,
			albumId: row.image.albumId,
			kind: "upload",
			r2KeyOriginal: dstKeys.original(ext),
			r2KeyWeb: row.image.r2KeyWeb ? dstKeys.web : null,
			r2KeyThumb: row.image.r2KeyThumb ? dstKeys.thumb : null,
			mime: row.image.mime,
			widthPx: row.image.widthPx,
			heightPx: row.image.heightPx,
			sizeBytes: row.image.sizeBytes,
			filenameLabel: `${row.image.filenameLabel} copy`.slice(0, 80),
			segmentStatus: "none",
			positionIdx: row.image.positionIdx + 1,
		})
		.returning();
	if (row.image.currentVersionId) {
		const [ver] = await db
			.select()
			.from(imageVersions)
			.where(eq(imageVersions.id, row.image.currentVersionId))
			.limit(1);
		if (ver) {
			const obj = await c.env.MEDIA.get(ver.r2KeyFull);
			if (obj) {
				const vId = crypto.randomUUID();
				const dstFull = dstKeys.version(vId, ver.r2KeyFull.split(".").pop() ?? "png");
				await c.env.MEDIA.put(dstFull, obj.body, {
					httpMetadata: {
						contentType: obj.httpMetadata?.contentType,
						cacheControl: obj.httpMetadata?.cacheControl,
					},
				});
				await db.insert(imageVersions).values({
					id: vId,
					imageId: newId,
					label: ver.label,
					r2KeyFull: dstFull,
				});
				await db.update(images).set({ currentVersionId: vId }).where(eq(images.id, newId));
			}
		}
	}
	void srcKeys;
	return c.json({ image: copy }, 201);
});

// Branch family (plan 24): the source chain plus all branches off it.
api.get("/images/:id/branch", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const albumImages = await db
		.select()
		.from(images)
		.where(eq(images.albumId, row.album.id))
		.orderBy(images.createdAt);
	const map = new Map(albumImages.map((img) => [img.id, img]));
	// Walk up to the root of this image's lineage.
	let root = row.image;
	for (let i = 0; i < 20; i++) {
		const parent = root.sourceImageId ? map.get(root.sourceImageId) : null;
		if (!parent) break;
		root = parent;
	}
	// Family = the whole lineage tree rooted at `root` (bounded walk).
	const family: typeof albumImages = [];
	const queue: string[] = [root.id];
	const seen = new Set<string>();
	while (queue.length > 0 && family.length < 100) {
		const id = queue.shift()!;
		if (seen.has(id)) continue;
		seen.add(id);
		const img = map.get(id);
		if (!img) continue;
		family.push(img);
		for (const candidate of albumImages) {
			if (candidate.sourceImageId === id) queue.push(candidate.id);
		}
	}
	return c.json({ images: family, rootId: root.id });
});

// Pinned edit instructions (annotate-then-apply, Reve-style)
api.get("/images/:id/instructions", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const rows = await db
		.select()
		.from(editInstructions)
		.where(and(eq(editInstructions.imageId, row.image.id), eq(editInstructions.status, "pending")))
		.orderBy(editInstructions.createdAt);
	return c.json({ instructions: rows });
});

api.post("/images/:id/instructions", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const body = await c.req.json<{
		text: string;
		bbox: { x: number; y: number; w: number; h: number };
	}>();
	if (!body.text?.trim()) return c.json({ error: "text_required" }, 400);
	const db = createDb(c.env.DB);
	const [instruction] = await db
		.insert(editInstructions)
		.values({
			id: crypto.randomUUID(),
			imageId: row.image.id,
			text: body.text.slice(0, 300),
			bboxX: Math.min(1, Math.max(0, body.bbox.x)),
			bboxY: Math.min(1, Math.max(0, body.bbox.y)),
			bboxW: Math.min(1, Math.max(0.005, body.bbox.w)),
			bboxH: Math.min(1, Math.max(0.005, body.bbox.h)),
		})
		.returning();
	return c.json({ instruction }, 201);
});

api.delete("/instructions/:id", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const [row] = await db
		.select({ ownerId: projects.ownerId })
		.from(editInstructions)
		.innerJoin(images, eq(images.id, editInstructions.imageId))
		.innerJoin(albums, eq(albums.id, images.albumId))
		.innerJoin(projects, eq(projects.id, albums.projectId))
		.where(eq(editInstructions.id, c.req.param("id")))
		.limit(1);
	if (!row || row.ownerId !== user.id) return c.json({ error: "not_found" }, 404);
	await db.delete(editInstructions).where(eq(editInstructions.id, c.req.param("id")));
	return c.json({ ok: true });
});

/** Apply every pending instruction on the image in ONE generation pass,
 * producing a branched photo auto-titled from the instructions. */
api.post("/images/:id/apply-instructions", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const pending = await db
		.select()
		.from(editInstructions)
		.where(and(eq(editInstructions.imageId, row.image.id), eq(editInstructions.status, "pending")))
		.orderBy(editInstructions.createdAt);
	if (pending.length === 0) return c.json({ error: "no_instructions" }, 400);
	if (!(await rateLimit(c.env, user.id, row.image.id, 12))) {
		return c.json({ error: "rate_limited" }, 429);
	}
	const instructions = pending.map((p) => ({ text: p.text, bbox: { x: p.bboxX, y: p.bboxY, w: p.bboxW, h: p.bboxH } }));
	const label = autoTitleFromInstructions(pending.map((p) => p.text));
	const jobId = await createJob(db, {
		type: "batch_edit",
		userId: user.id,
		imageId: row.image.id,
		payload: { instructions, label },
	});
	const { chargeCredits } = await import("../lib/jobs");
	const charge = await chargeCredits(db, user.id, 2, "batch_edit", jobId);
	if (!charge.ok) {
		await db.delete(jobs).where(eq(jobs.id, jobId));
		return c.json({ error: "insufficient_credits", balance: charge.balance }, 402);
	}
	await enqueueJob(c.env.AI_JOBS, jobId, "batch_edit", {
		jobId,
		type: "batch_edit",
		userId: user.id,
		imageId: row.image.id,
		instructions,
		label,
	});
	return c.json({ jobId, label }, 202);
});

/** "change sunglass to eyeglass" -> "Eyeglass & business coat" style titles. */
function autoTitleFromInstructions(texts: string[]): string {
	const targets = texts.map((t) => {
		const m = /(?:change|make|turn|replace|reupholster|convert)[\w\s]*?\bto\s+(.{2,40})/i.exec(t);
		return (m ? m[1] : t).trim().replace(/[.!?]+$/, "");
	});
	const joined = targets.join(" & ");
	const titled = joined.charAt(0).toUpperCase() + joined.slice(1);
	return titled.slice(0, 60) || "Edited photo";
}

// Share (plan 13)
api.post("/images/:id/share", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const body = await c.req.json<{ allowDownload?: boolean; expiresInHours?: number }>().catch(
		() => ({}) as { allowDownload?: boolean; expiresInHours?: number },
	);
	const db = createDb(c.env.DB);
	const token = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
	const [link] = await db
		.insert(shareLinks)
		.values({
			id: crypto.randomUUID(),
			token,
			userId: user.id,
			imageId: row.image.id,
			allowDownload: body.allowDownload ?? true,
			expiresAt: body.expiresInHours
				? new Date(Date.now() + body.expiresInHours * 3600_000)
				: null,
		})
		.returning();
	return c.json({ share: link, url: `/s/${token}` }, 201);
});

api.delete("/share/:id", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	await db
		.update(shareLinks)
		.set({ revokedAt: new Date() })
		.where(and(eq(shareLinks.id, c.req.param("id")), eq(shareLinks.userId, user.id)));
	return c.json({ ok: true });
});

// Public share resolution (no auth)
api.get("/public/share/:token", async (c) => {
	const db = createDb(c.env.DB);
	const [link] = await db
		.select()
		.from(shareLinks)
		.where(eq(shareLinks.token, c.req.param("token")))
		.limit(1);
	if (!link || link.revokedAt || (link.expiresAt && link.expiresAt.getTime() < Date.now())) {
		return c.json({ error: "not_found" }, 404);
	}
	return c.json({ share: { allowDownload: link.allowDownload, imageId: link.imageId } });
});

api.get("/public/images/:id/file", async (c) => {
	const db = createDb(c.env.DB);
	const [link] = await db
		.select()
		.from(shareLinks)
		.where(eq(shareLinks.imageId, c.req.param("id")))
		.orderBy(desc(shareLinks.createdAt))
		.limit(1);
	if (!link || link.revokedAt || (link.expiresAt && link.expiresAt.getTime() < Date.now())) {
		return c.json({ error: "not_found" }, 404);
	}
	const [image] = await db.select().from(images).where(eq(images.id, c.req.param("id"))).limit(1);
	if (!image) return c.json({ error: "not_found" }, 404);
	const key = image.currentVersionId
		? (
				(
					await db
						.select()
						.from(imageVersions)
						.where(eq(imageVersions.id, image.currentVersionId))
						.limit(1)
				)[0]?.r2KeyFull ?? image.r2KeyOriginal
			)
		: image.r2KeyOriginal;
	const res = await getObject(c.env.MEDIA, key);
	return res ?? c.json({ error: "not_found" }, 404);
});

// Canvas text annotations (plan 20)
api.get("/images/:id/annotations", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const rows = await db
		.select()
		.from(imageAnnotations)
		.where(eq(imageAnnotations.imageId, row.image.id))
		.orderBy(imageAnnotations.createdAt);
	return c.json({ annotations: rows });
});

api.post("/images/:id/annotations", async (c) => {
	const user = await requireUser(c);
	const row = await ownedImage(c, c.env, user.id);
	if (!row) return c.json({ error: "not_found" }, 404);
	const body = await c.req.json<{
		text: string;
		normX?: number;
		normY?: number;
		fontSize?: number;
		color?: string;
	}>();
	if (!body.text?.trim()) return c.json({ error: "text_required" }, 400);
	const db = createDb(c.env.DB);
	const [annotation] = await db
		.insert(imageAnnotations)
		.values({
			id: crypto.randomUUID(),
			imageId: row.image.id,
			text: body.text.slice(0, 300),
			normX: Math.min(1, Math.max(0, body.normX ?? 0.5)),
			normY: Math.min(1, Math.max(0, body.normY ?? 0.5)),
			fontSize: body.fontSize ?? 0.04,
			color: body.color ?? "#ffffff",
		})
		.returning();
	return c.json({ annotation }, 201);
});

api.delete("/annotations/:id", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const [row] = await db
		.select({ ownerId: projects.ownerId })
		.from(imageAnnotations)
		.innerJoin(images, eq(images.id, imageAnnotations.imageId))
		.innerJoin(albums, eq(albums.id, images.albumId))
		.innerJoin(projects, eq(projects.id, albums.projectId))
		.where(eq(imageAnnotations.id, c.req.param("id")))
		.limit(1);
	if (!row || row.ownerId !== user.id) return c.json({ error: "not_found" }, 404);
	await db.delete(imageAnnotations).where(eq(imageAnnotations.id, c.req.param("id")));
	return c.json({ ok: true });
});

// Prompt rewriting (plan 12)
api.post("/prompts/rewrite", async (c) => {
	await requireUser(c);
	const body = await c.req.json<{ text: string; operation?: string; context?: string }>();
	if (!body.text?.trim()) return c.json({ error: "text_required" }, 400);
	const provider = getProvider(c.env);
	const rewritten = await provider.rewritePrompt(
		body.text,
		body.operation ?? "edit",
		body.context ?? "",
	);
	return c.json({ rewritten });
});

// Usage (plan 13)
api.get("/usage", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const rows = await db
		.select({ reason: sql`reason`, total: sql<number>`COUNT(*)`, credits: sql<number>`SUM(delta)` })
		.from(sql`credit_events`)
		.where(sql`user_id = ${user.id}`)
		.groupBy(sql`reason`);
	return c.json({ balance: user.creditBalance, events: rows });
});

// Simple per-user sliding-window rate limit for AI-heavy routes (plan 13).
export async function rateLimit(
	env: Env,
	userId: string,
	_windowKey: string,
	maxPerMinute: number,
): Promise<boolean> {
	const db = createDb(env.DB);
	const since = new Date(Date.now() - 60_000);
	const result = await db
		.select({ count: sql<number>`COUNT(*)` })
		.from(jobs)
		.where(
			and(
				eq(jobs.userId, userId),
				sql`${jobs.createdAt} > ${since.getTime()}`,
				or(eq(jobs.type, "generate"), eq(jobs.type, "enhance"), eq(jobs.type, "inpaint")),
			),
		);
	return (result[0]?.count ?? 0) < maxPerMinute;
}


/** Trigger the segmentation workflow with a typed payload cast. */
export async function createSegmentWorkflow(
	env: Env,
	jobId: string,
	userId: string,
): Promise<string | null> {
	if (!env.SEGMENT_WORKFLOW) return null;
	const binding = env.SEGMENT_WORKFLOW as unknown as {
		create(opts: { payload: { jobId: string; userId: string } }): Promise<{ id: string }>;
	};
	const instance = await binding.create({ payload: { jobId, userId } });
	return instance.id;
}

api.get("/segments/:id/crop", async (c) => {
	const user = await requireUser(c);
	const segment = await ownedSegment(c.env, user.id, c.req.param("id"));
	if (!segment) return c.json({ error: "not_found" }, 404);
	const db = createDb(c.env.DB);
	const [row] = await db
		.select({ image: images, albumId: albums.id })
		.from(images)
		.innerJoin(albums, eq(albums.id, images.albumId))
		.where(eq(images.id, segment.imageId))
		.limit(1);
	if (!row) return c.json({ error: "not_found" }, 404);
	const keys = mediaKeys(user.id, row.albumId, row.image.id);
	const res =
		(await getObject(c.env.MEDIA, keys.segmentCrop(segment.id))) ??
		(await getObject(c.env.MEDIA, keys.thumb));
	return res ?? c.json({ error: "not_found" }, 404);
});

// TEMPORARY probe: bisect the edit chain (klein multipart / SDXL / SD-inpaint). Remove after.

// TEMPORARY probe: Pruna P-Image shapes. Remove after verification.
api.post("/ai-debug/pruna", async (c) => {
	await requireUser(c);
	const body = await c.req.json<{ imageB64: string }>().catch(() => null);
	if (!body?.imageB64) return c.json({ error: "imageB64 required" }, 400);
	const b64 = body.imageB64.replace(/^data:[^,]+,/, "");
	const ai = c.env.AI as unknown as { run: (m: string, input: unknown) => Promise<unknown> };
	const results: Record<string, unknown> = {};

	// SDXL-lightning multipart img2img B&W test — full result returned for
	// visual verification (composition preservation check).
	try {
		const form = new FormData();
		form.append("prompt", "convert this photo to dramatic black and white film");
		form.append("image", b64);
		form.append("strength", "0.55");
		form.append("num_steps", "6");
		form.append("guidance", "3");
		form.append("width", "1024");
		form.append("height", "1024");
		const probeReq = new Request("https://x.local", { method: "POST", body: form });
		const out = await ai.run("@cf/bytedance/stable-diffusion-xl-lightning", {
			multipart: { body: probeReq.body, contentType: probeReq.headers.get("content-type") || "multipart/form-data" },
		});
		let b64Out: string;
		if (out instanceof ReadableStream) {
			const buf = await new Response(out).arrayBuffer();
			const bytes = new Uint8Array(buf);
			let bin = "";
			for (let i = 0; i < bytes.length; i += 0x8000) {
				bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			}
			b64Out = btoa(bin);
		} else if (out && typeof out === "object" && "image" in (out as object)) {
			b64Out = (out as { image: string }).image;
		} else {
			b64Out = "UNEXPECTED: " + JSON.stringify(out).slice(0, 200);
		}
		results.sdxlBw = b64Out.slice(0, 60) + "…len=" + b64Out.length;
		results.imageB64Out = b64Out;
	} catch (e) {
		results.sdxlBw = "ERR: " + (e instanceof Error ? e.message.slice(0, 220) : String(e));
	}
	return c.json({ results, imageB64Out: results.imageB64Out ?? null });
});
