import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import {
	albums,
	chatMessages,
	chatThreads,
	creditEvents,
	editInstructions,
	imageAnnotations,
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
	type ImageRow,
	type ImageVersion,
} from "../../../database/schema";
import { streamAgentResponse } from "../agent";
import { notifyUserEvent } from "../events";
import { ensureProject, getUser, requireUser } from "../lib/auth";
import {
	MAX_BATCH_INSTRUCTIONS,
	MAX_CHAT_CHARS,
	MAX_MASK_PX,
	MAX_POLYGON_POINTS,
	MAX_PROMPT_CHARS,
	MAX_UPLOAD_BYTES,
	WORKING_MAX_PX,
} from "../lib/config";
import { createDb } from "../lib/db";
import { bboxSchema, fail, hasAnyValue, readJson, unit } from "../lib/http";
import { chargeCredits, createJob, CREDIT_COSTS, enqueueJob, finishJob, refundJob, type JobType } from "../lib/jobs";
import { recordAiRequest, requireAiQuota, requireMediaQuota } from "../lib/limits";
import { buildPolygonMask } from "../lib/mask";
import {
	compositeOverlay,
	createImageFromBytes,
	deleteImageMedia,
	deriveVariants,
	loadImageBytes,
	loadWorkingImage,
	logWarn,
} from "../lib/operations";
import { pixelOps } from "../lib/pixels";
import { getProvider, isMock } from "../lib/providers";
import {
	albumPrefix,
	deletePrefix,
	extForMime,
	getObject,
	legacyAlbumPrefix,
	mediaKeys,
	putObject,
	referenceKeys,
	sniffMime,
} from "../lib/r2";
import { verifyPublicImageUrl } from "../lib/sign";
import { ensureFamilyThread, familyHistory, friendlyError, recordAction, type Box, type OpClass } from "../lib/history";
import type { AiJobMessage } from "../queue";
import { auth } from "./auth";

type Ctx = Context<{ Bindings: Env }>;

export const api = new Hono<{ Bindings: Env }>();

api.route("/auth", auth);
api.notFound((c) => c.json({ error: "not_found" }, 404));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const idSchema = z.string().min(1).max(64);

/** One query: the image, its album, and proof the caller owns it. */
async function ownedImage(env: Env, userId: string, imageId: string) {
	const db = createDb(env.DB);
	const [row] = await db
		.select({ image: images, album: albums })
		.from(images)
		.innerJoin(albums, eq(albums.id, images.albumId))
		.innerJoin(projects, eq(projects.id, albums.projectId))
		.where(and(eq(images.id, imageId), eq(projects.ownerId, userId)))
		.limit(1);
	return row ?? null;
}

async function requireImage(c: Ctx, userId: string) {
	const row = await ownedImage(c.env, userId, c.req.param("id") ?? "");
	if (!row) fail(404, "not_found");
	return row;
}

async function requireAlbum(c: Ctx, userId: string, albumId: string) {
	const db = createDb(c.env.DB);
	const [row] = await db
		.select({ album: albums })
		.from(albums)
		.innerJoin(projects, eq(projects.id, albums.projectId))
		.where(and(eq(albums.id, albumId), eq(projects.ownerId, userId)))
		.limit(1);
	if (!row) fail(404, "not_found");
	return row.album;
}

async function ownedSegment(env: Env, userId: string, segmentId: string) {
	const db = createDb(env.DB);
	const [row] = await db
		.select({ segment: segments, albumId: albums.id })
		.from(segments)
		.innerJoin(images, eq(images.id, segments.imageId))
		.innerJoin(albums, eq(albums.id, images.albumId))
		.innerJoin(projects, eq(projects.id, albums.projectId))
		.where(and(eq(segments.id, segmentId), eq(projects.ownerId, userId), isNull(segments.deletedAt)))
		.limit(1);
	return row ?? null;
}

async function currentVersion(env: Env, image: ImageRow): Promise<ImageVersion | null> {
	if (!image.currentVersionId) return null;
	const db = createDb(env.DB);
	const [version] = await db
		.select()
		.from(imageVersions)
		.where(eq(imageVersions.id, image.currentVersionId))
		.limit(1);
	return version ?? null;
}

type Variant = "web" | "thumb" | "original";
const variantSchema = z.enum(["web", "thumb", "original"]).catch("web");

/** R2 key for a variant of a specific version (falls back to image-level). */
function variantKey(image: ImageRow, version: ImageVersion | null, variant: Variant): string {
	const full = version?.r2KeyFull ?? image.r2KeyOriginal;
	if (variant === "original") return full;
	if (variant === "thumb") return version?.r2KeyThumb ?? image.r2KeyThumb ?? full;
	return version?.r2KeyWeb ?? image.r2KeyWeb ?? full;
}

/** Run background work after the response (R2 cleanup). */
function background(c: Ctx, work: Promise<unknown>): void {
	const guarded = work.catch((error) => logWarn("background_task_failed", error));
	try {
		c.executionCtx.waitUntil(guarded);
	} catch {
		void guarded; // no ExecutionContext (unit tests): let it settle on its own
	}
}

const adjustmentsSchema = z
	.object({
		exposure: z.number().finite().min(-2).max(2).optional(),
		contrast: z.number().finite().min(-1).max(1).optional(),
		highlights: z.number().finite().min(-1).max(1).optional(),
		shadows: z.number().finite().min(-1).max(1).optional(),
		temperature: z.number().finite().min(-1).max(1).optional(),
		tint: z.number().finite().min(-1).max(1).optional(),
		vibrance: z.number().finite().min(-1).max(1).optional(),
		saturation: z.number().finite().min(-1).max(1).optional(),
		clarity: z.number().finite().min(-1).max(1).optional(),
		vignette: z.number().finite().min(0).max(1).optional(),
		straighten: z.number().finite().min(-45).max(45).optional(),
		rotate90: z.number().int().min(0).max(3).optional(),
		flipH: z.boolean().optional(),
		flipV: z.boolean().optional(),
		crop: bboxSchema.optional(),
	})
	.strict();

function decodeBase64Png(raw: string): ArrayBuffer {
	const cleaned = raw.replace(/^data:image\/png;base64,/, "").trim();
	if (!cleaned || cleaned.length > 3_000_000) fail(400, "invalid_mask");
	let bin: string;
	try {
		bin = atob(cleaned);
	} catch {
		fail(400, "invalid_mask");
	}
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const buf = bytes.buffer;
	if (sniffMime(buf) !== "image/png") fail(400, "mask_must_be_png");
	return buf;
}

async function parseMultipart(c: Ctx) {
	try {
		return await c.req.parseBody();
	} catch {
		fail(400, "invalid_form");
	}
}

/** Create a job, charge it atomically, record it in the photo's history
 * (phase 5), enqueue it, and push an initial real-time event. Refuses (402) without credit. */
async function startJob(
	c: Ctx,
	userId: string,
	type: Exclude<JobType, "caption" | "thumb">,
	message: Omit<AiJobMessage, "jobId" | "type" | "userId">,
	payload?: Record<string, unknown>,
	history?: { image: ImageRow; text: string; opClass: OpClass; bboxes?: Box[] },
): Promise<string> {
	await requireAiQuota(c.env, userId);
	const db = createDb(c.env.DB);
	const jobId = await createJob(db, {
		type,
		userId,
		imageId: message.imageId,
		segmentId: message.segmentId,
		payload,
	});
	const charge = await chargeCredits(db, userId, CREDIT_COSTS[type], type, jobId);
	if (!charge.ok) {
		await db.delete(jobs).where(eq(jobs.id, jobId));
		fail(402, "insufficient_credits");
	}
	try {
		const recorded = history ? await recordAction(db, { ...history, jobId }) : null;
		const body: AiJobMessage = { ...message, jobId, type, userId, chatMessageId: recorded?.replyId };
		await enqueueJob(c.env.AI_JOBS, jobId, type, { ...body });
	} catch (err) {
		await refundJob(db, jobId);
		await finishJob(db, jobId, "error", err instanceof Error ? err.message : "Failed to queue job");
		throw err;
	}
	await notifyUserEvent(c.env, userId, {
		jobId,
		jobType: type,
		status: "queued",
		progress: 0,
		imageId: message.imageId ?? null,
	});
	return jobId;
}

function origin(c: Ctx): string {
	return new URL(c.req.url).origin;
}

// ---------------------------------------------------------------------------
// Realtime events (Durable Object WebSocket Hibernation API) & Session
// ---------------------------------------------------------------------------

api.get("/events", async (c) => {
	const user = await requireUser(c);
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
		return c.json({ error: "upgrade_required" }, 426);
	}
	const stub = c.env.USER_EVENTS.getByName(user.id);
	return stub.fetch(c.req.raw);
});

api.get("/me", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ user: null });
	const project = await ensureProject(c, user);
	return c.json({
		user: { id: user.id, name: user.name, plan: user.plan, credits: user.creditBalance },
		project: { id: project.id, name: project.name },
	});
});

// ---------------------------------------------------------------------------
// Albums (dashboard, Screen A)
// ---------------------------------------------------------------------------

api.get("/albums", async (c) => {
	const user = await requireUser(c);
	const project = await ensureProject(c, user);
	const db = createDb(c.env.DB);
	const sort = c.req.query("sort") ?? "newest";
	const q = (c.req.query("q") ?? "").trim().slice(0, 100).toLowerCase();
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
			// instr() is a literal substring match: user input can't smuggle
			// LIKE wildcards (%/_) the way the old query allowed.
			q
				? and(eq(albums.projectId, project.id), sql`instr(lower(${albums.title}), ${q}) > 0`)
				: eq(albums.projectId, project.id),
		)
		.orderBy(
			sort === "oldest" ? asc(albums.createdAt) : sort === "name" ? asc(albums.title) : desc(albums.createdAt),
		);
	return c.json({ project: { id: project.id, name: project.name }, albums: rows });
});

api.post("/albums", async (c) => {
	const user = await requireUser(c);
	const project = await ensureProject(c, user);
	const body = await readJson(c, z.object({ title: z.string().max(120).optional() }));
	const db = createDb(c.env.DB);
	const [album] = await db
		.insert(albums)
		.values({ id: crypto.randomUUID(), projectId: project.id, title: body.title?.trim() || "Untitled album" })
		.returning();
	return c.json({ album }, 201);
});

api.get("/albums/:id", async (c) => {
	const user = await requireUser(c);
	return c.json({ album: await requireAlbum(c, user.id, c.req.param("id")) });
});

api.patch("/albums/:id", async (c) => {
	const user = await requireUser(c);
	const album = await requireAlbum(c, user.id, c.req.param("id"));
	const body = await readJson(c, z.object({ title: z.string().trim().min(1).max(120) }));
	const db = createDb(c.env.DB);
	const [updated] = await db
		.update(albums)
		.set({ title: body.title, updatedAt: new Date() })
		.where(eq(albums.id, album.id))
		.returning();
	return c.json({ album: updated });
});

api.delete("/albums/:id", async (c) => {
	const user = await requireUser(c);
	const album = await requireAlbum(c, user.id, c.req.param("id"));
	const db = createDb(c.env.DB);
	await db.delete(albums).where(eq(albums.id, album.id));
	// Rows cascade; the R2 objects must be removed explicitly.
	background(
		c,
		Promise.all([
			deletePrefix(c.env.MEDIA, albumPrefix(user.id, album.id)),
			deletePrefix(c.env.MEDIA, legacyAlbumPrefix(user.id, album.id)),
		]),
	);
	return c.json({ ok: true });
});

api.get("/references", async (c) => {
	const user = await requireUser(c);
	const project = await ensureProject(c, user);
	const db = createDb(c.env.DB);
	const rows = await db
		.select()
		.from(references)
		.where(eq(references.projectId, project.id))
		.orderBy(desc(references.createdAt));
	return c.json({ references: rows });
});

api.post("/references", async (c) => {
	const user = await requireUser(c);
	const project = await ensureProject(c, user);
	if (uploadTooLarge(c)) fail(413, "file_too_large");
	await requireMediaQuota(c.env, user.id);
	const form = await parseMultipart(c);
	const file = form["file"];
	if (!(file instanceof File)) fail(400, "file_required");
	if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) fail(413, "file_too_large");
	const raw = await file.arrayBuffer();
	if (!sniffMime(raw)) fail(415, "not_an_image");

	const ops = pixelOps(c.env);
	const normalized = await ops.normalize(raw, 1600);
	const dims = await ops.dims(normalized.bytes);
	const thumbScale = Math.min(1, 256 / Math.max(1, dims.width, dims.height));
	const thumb = await ops.resize(
		normalized.bytes,
		Math.max(1, Math.round(dims.width * thumbScale)),
		Math.max(1, Math.round(dims.height * thumbScale)),
	);
	const refId = crypto.randomUUID();
	const keys = referenceKeys(user.id, refId);
	const fullKey = keys.full(extForMime(normalized.mime));
	await Promise.all([
		putObject(c.env.MEDIA, fullKey, normalized.bytes, normalized.mime),
		putObject(c.env.MEDIA, keys.thumb, thumb.bytes, thumb.mime),
	]);
	const rawTitle = typeof form["title"] === "string" ? form["title"].trim() : "";
	const fallbackTitle = (file.name || "Reference").replace(/\.[^.]+$/, "").trim() || "Reference";
	const db = createDb(c.env.DB);
	const [created] = await db
		.insert(references)
		.values({
			id: refId,
			projectId: project.id,
			title: (rawTitle || fallbackTitle).slice(0, 80),
			r2KeyFull: fullKey,
			r2KeyThumb: keys.thumb,
			mime: normalized.mime,
			widthPx: dims.width,
			heightPx: dims.height,
			kind: "image",
		})
		.returning();
	return c.json({ reference: created }, 201);
});

api.get("/references/:id/file", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const [row] = await db
		.select({ ref: references })
		.from(references)
		.innerJoin(projects, eq(projects.id, references.projectId))
		.where(and(eq(references.id, c.req.param("id")), eq(projects.ownerId, user.id)))
		.limit(1);
	if (!row) fail(404, "not_found");
	const key = c.req.query("variant") === "original" ? (row.ref.r2KeyFull ?? row.ref.r2KeyThumb) : row.ref.r2KeyThumb;
	const res = await getObject(c.env.MEDIA, key, {
		cacheControl: "private, max-age=86400",
		ifNoneMatch: c.req.header("If-None-Match"),
	});
	return res ?? c.json({ error: "not_found" }, 404);
});

api.delete("/references/:id", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const [row] = await db
		.select({ ref: references })
		.from(references)
		.innerJoin(projects, eq(projects.id, references.projectId))
		.where(and(eq(references.id, c.req.param("id")), eq(projects.ownerId, user.id)))
		.limit(1);
	if (!row) fail(404, "not_found");
	await db.delete(references).where(eq(references.id, row.ref.id));
	background(
		c,
		Promise.allSettled([
			row.ref.r2KeyFull ? c.env.MEDIA.delete(row.ref.r2KeyFull) : Promise.resolve(),
			c.env.MEDIA.delete(row.ref.r2KeyThumb),
		]),
	);
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Images (upload pipeline, Screen B cards + editor)
// ---------------------------------------------------------------------------

api.get("/albums/:id/images", async (c) => {
	const user = await requireUser(c);
	const album = await requireAlbum(c, user.id, c.req.param("id"));
	const filter = c.req.query("filter") ?? "all";
	const db = createDb(c.env.DB);
	const rows = await db
		.select()
		.from(images)
		.where(
			filter === "uploads"
				? and(eq(images.albumId, album.id), eq(images.kind, "upload"))
				: filter === "generated"
					? and(eq(images.albumId, album.id), ne(images.kind, "upload"))
					: eq(images.albumId, album.id),
		)
		.orderBy(images.positionIdx, images.createdAt);
	return c.json({ images: rows });
});

api.get("/images/:id", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const db = createDb(c.env.DB);
	const versions = await db
		.select()
		.from(imageVersions)
		.where(eq(imageVersions.imageId, row.image.id))
		.orderBy(imageVersions.createdAt);
	return c.json({ image: row.image, album: { id: row.album.id, title: row.album.title }, versions });
});

api.get("/images/:id/file", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const variant = variantSchema.parse(c.req.query("variant"));
	const versionId = c.req.query("v");
	const download = c.req.query("download") === "1";
	let version: ImageVersion | null;
	if (versionId) {
		const db = createDb(c.env.DB);
		[version = null] = await db
			.select()
			.from(imageVersions)
			.where(and(eq(imageVersions.id, versionId), eq(imageVersions.imageId, row.image.id)))
			.limit(1);
		if (!version) fail(404, "not_found");
	} else {
		version = await currentVersion(c.env, row.image);
	}
	const key = variantKey(row.image, version, variant);
	if (download && variant === "original" && row.image.overlayR2Key) {
		const obj = await c.env.MEDIA.get(key);
		if (!obj) fail(404, "not_found");
		const baseBytes = await obj.arrayBuffer();
		const composited = await compositeOverlay(c.env, baseBytes, row.image.overlayR2Key);
		const outBytes = composited ? composited.bytes : baseBytes;
		const outMime = composited ? composited.mime : (obj.httpMetadata?.contentType ?? row.image.mime);
		const ext = extForMime(outMime);
		return new Response(outBytes, {
			headers: {
				"Content-Type": outMime,
				"Content-Disposition": `attachment; filename="editorium-${row.image.id.slice(0, 8)}.${ext}"`,
				"Cache-Control": "no-cache",
			},
		});
	}
	const cacheControl = versionId ? "private, max-age=31536000, immutable" : "no-cache";
	const res = await getObject(c.env.MEDIA, key, {
		cacheControl,
		ifNoneMatch: c.req.header("If-None-Match"),
	});
	if (!res) return c.json({ error: "not_found" }, 404);
	if (download && res.status === 200) {
		const ext = extForMime(res.headers.get("Content-Type") ?? row.image.mime);
		res.headers.set("Content-Disposition", `attachment; filename="editorium-${row.image.id.slice(0, 8)}.${ext}"`);
	}
	return res;
});

const uploadTooLarge = (c: Ctx) =>
	Number(c.req.header("Content-Length") ?? 0) > MAX_UPLOAD_BYTES + 1024 * 1024;

api.post("/albums/:id/upload", async (c) => {
	const user = await requireUser(c);
	const album = await requireAlbum(c, user.id, c.req.param("id"));
	if (uploadTooLarge(c)) fail(413, "file_too_large");
	await requireMediaQuota(c.env, user.id);
	const form = await parseMultipart(c);
	const file = form["file"];
	if (!(file instanceof File)) fail(400, "file_required");
	if (file.size > MAX_UPLOAD_BYTES) fail(413, "file_too_large");
	const bytes = await file.arrayBuffer();
	if (!sniffMime(bytes)) fail(415, "not_an_image");

	const { image } = await createImageFromBytes(c.env, {
		userId: user.id,
		albumId: album.id,
		bytes,
		kind: "upload",
		label: "Original",
		filenameLabel: (file.name || crypto.randomUUID().slice(0, 8).toUpperCase()).slice(0, 80),
		operation: "upload",
	});
	const db = createDb(c.env.DB);
	await db
		.update(albums)
		.set({
			coverImageId: sql`COALESCE(${albums.coverImageId}, ${image.id})`,
			updatedAt: new Date(),
		})
		.where(eq(albums.id, album.id));
	return c.json({ image, segmentJobId: null }, 201);
});

api.patch("/images/:id", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const body = await readJson(
		c,
		z.object({
			filenameLabel: z.string().trim().min(1).max(80).optional(),
			bookmarked: z.boolean().optional(),
			positionIdx: z.number().int().min(0).max(1_000_000).optional(),
		}),
	);
	if (!hasAnyValue(body)) fail(400, "empty_patch");
	const db = createDb(c.env.DB);
	const [updated] = await db
		.update(images)
		.set({
			filenameLabel: body.filenameLabel,
			bookmarkedAt: body.bookmarked === undefined ? undefined : body.bookmarked ? new Date() : null,
			positionIdx: body.positionIdx,
		})
		.where(eq(images.id, row.image.id))
		.returning();
	return c.json({ image: updated });
});

api.patch("/images/:id/adjustments", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const body = await readJson(c, z.object({ adjustments: adjustmentsSchema.nullable() }));
	const serialized = body.adjustments ? JSON.stringify(body.adjustments) : null;
	const db = createDb(c.env.DB);
	const imgStmt = db.update(images).set({ adjustmentsJson: serialized }).where(eq(images.id, row.image.id));
	if (row.image.currentVersionId) {
		await db.batch([
			imgStmt,
			db
				.update(imageVersions)
				.set({ adjustmentsJson: serialized })
				.where(eq(imageVersions.id, row.image.currentVersionId)),
		]);
	} else {
		await imgStmt;
	}
	return c.json({ ok: true, adjustmentsJson: serialized });
});

api.delete("/images/:id", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const db = createDb(c.env.DB);
	await db.delete(images).where(eq(images.id, row.image.id));
	if (row.album.coverImageId === row.image.id) {
		// Point the cover at another photo instead of leaving a dangling id.
		const [next] = await db
			.select({ id: images.id })
			.from(images)
			.where(eq(images.albumId, row.album.id))
			.orderBy(images.createdAt)
			.limit(1);
		await db.update(albums).set({ coverImageId: next?.id ?? null }).where(eq(albums.id, row.album.id));
	}
	background(c, deleteImageMedia(c.env, user.id, row.album.id, row.image.id));
	return c.json({ ok: true });
});

// Versions (plan 11)
api.get("/images/:id/versions", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
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
	const row = await requireImage(c, user.id);
	const db = createDb(c.env.DB);
	const [version] = await db
		.select()
		.from(imageVersions)
		.where(and(eq(imageVersions.id, c.req.param("versionId")), eq(imageVersions.imageId, row.image.id)))
		.limit(1);
	if (!version) fail(404, "not_found");
	if (!version.r2KeyWeb || !version.r2KeyThumb) {
		const obj = await c.env.MEDIA.get(version.r2KeyFull);
		if (obj) {
			const variants = await deriveVariants(c.env, {
				userId: user.id,
				albumId: row.album.id,
				imageId: row.image.id,
				versionId: version.id,
				bytes: await obj.arrayBuffer(),
				mime: obj.httpMetadata?.contentType ?? row.image.mime,
			});
			await db
				.update(imageVersions)
				.set({ r2KeyWeb: variants.web, r2KeyThumb: variants.thumb })
				.where(eq(imageVersions.id, version.id));
		}
	}
	await db.update(images).set({ currentVersionId: version.id }).where(eq(images.id, row.image.id));
	return c.json({ ok: true, currentId: version.id });
});

// Deterministic client-side presets / baked WebGL adjustments → branched photo.
api.post("/images/:id/filter-branch", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	if (uploadTooLarge(c)) fail(413, "file_too_large");
	await requireMediaQuota(c.env, user.id);
	const form = await parseMultipart(c);
	const file = form["file"];
	const label = String(form["label"] ?? "Filtered").trim().slice(0, 60) || "Filtered";
	const rawAdj = typeof form["adjustmentsJson"] === "string" ? form["adjustmentsJson"] : null;
	if (!(file instanceof File)) fail(400, "file_required");
	if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) fail(413, "invalid_file");
	const bytes = await file.arrayBuffer();
	if (!sniffMime(bytes)) fail(415, "not_an_image");
	const { imageId, versionId } = await createImageFromBytes(c.env, {
		userId: user.id,
		albumId: row.album.id,
		bytes,
		kind: "edited",
		label,
		sourceImageId: row.image.id,
		rootImageId: row.image.rootImageId ?? row.image.id,
		operation: "filter",
		adjustmentsJson: rawAdj,
		audit: { opClass: "adjust", model: "client:canvas" },
	});
	// Instant operation: recorded already finished.
	await recordAction(createDb(c.env.DB), { image: row.image, text: label, opClass: "adjust", resultImageId: imageId });
	return c.json({ imageId, versionId }, 201);
});

// ---------------------------------------------------------------------------
// AI operations — all metered, rate limited, queued, real-time pushed
// ---------------------------------------------------------------------------

const promptSchema = z.string().trim().min(1).max(MAX_PROMPT_CHARS);

// Direct whole-photo instruction edit (supports optional up to 3 reference ids).
api.post("/images/:id/edit", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const { prompt, referenceImageIds } = await readJson(
		c,
		z.object({
			prompt: promptSchema,
			referenceImageIds: z.array(idSchema).max(3).optional(),
		}),
	);
	const jobId = await startJob(
		c,
		user.id,
		"inpaint",
		{ imageId: row.image.id, prompt, referenceImageIds, origin: origin(c) },
		{ prompt, referenceImageIds },
		{
			image: row.image,
			text: prompt,
			opClass: referenceImageIds?.length ? "style_transfer" : "reimagine",
		},
	);
	return c.json({ jobId }, 202);
});

api.post("/images/:id/edit-region", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const body = await readJson(
		c,
		z.object({
			segmentId: idSchema.optional(),
			bbox: bboxSchema.optional(),
			prompt: promptSchema.optional(),
			maskPngBase64: z.string().min(16).max(3_000_000).optional(),
			label: z.string().trim().min(1).max(60).optional(),
			referenceImageIds: z.array(idSchema).max(3).optional(),
		}),
	);
	if (body.segmentId) {
		const owned = await ownedSegment(c.env, user.id, body.segmentId);
		if (!owned || owned.segment.imageId !== row.image.id) fail(404, "not_found");
		if (owned.segment.lockedAt) fail(409, "segment_locked");
		const prompt = body.prompt ?? owned.segment.caption ?? `redraw the ${owned.segment.label}`;
		const jobId = await startJob(
			c,
			user.id,
			"inpaint",
			{
				imageId: row.image.id,
				segmentId: owned.segment.id,
				prompt,
				referenceImageIds: body.referenceImageIds,
			},
			{ prompt },
			{
				image: row.image,
				text: prompt,
				opClass: "local",
				bboxes: [{ x: owned.segment.bboxX, y: owned.segment.bboxY, w: owned.segment.bboxW, h: owned.segment.bboxH }],
			},
		);
		return c.json({ jobId }, 202);
	}
	if (!body.bbox || !body.prompt) fail(400, "segment_or_bbox_required");
	let maskR2Key: string | undefined;
	if (body.maskPngBase64) {
		const maskBytes = decodeBase64Png(body.maskPngBase64);
		maskR2Key = mediaKeys(user.id, row.album.id, row.image.id).instructionMask(crypto.randomUUID());
		await putObject(c.env.MEDIA, maskR2Key, maskBytes, "image/png");
	}
	const box = {
		x: body.bbox.x,
		y: body.bbox.y,
		w: Math.min(body.bbox.w, 1 - body.bbox.x),
		h: Math.min(body.bbox.h, 1 - body.bbox.y),
	};
	const jobId = await startJob(
		c,
		user.id,
		"inpaint",
		{
			imageId: row.image.id,
			regionBox: box,
			maskR2Key,
			prompt: body.prompt,
			label: body.label ?? "Edited region",
			referenceImageIds: body.referenceImageIds,
		},
		{ prompt: body.prompt, box, maskR2Key },
		{
			image: row.image,
			text: body.prompt,
			opClass: "local",
			bboxes: [box],
		},
	);
	return c.json({ jobId }, 202);
});

api.post("/images/:id/enhance", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const jobId = await startJob(c, user.id, "enhance", { imageId: row.image.id }, undefined, {
		image: row.image,
		text: "Enhance",
		opClass: "enhance",
	});
	return c.json({ jobId }, 202);
});

// Background removal: segmentation (subject pixels kept, never repainted).
api.post("/images/:id/remove-background", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const jobId = await startJob(c, user.id, "remove_bg", { imageId: row.image.id }, undefined, {
		image: row.image,
		text: "Remove background",
		opClass: "segment",
	});
	return c.json({ jobId }, 202);
});

// 1-click subject mask extraction (BiRefNet foreground cutout stored as an editable layer mask).
api.post("/images/:id/subject-mask", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	await requireAiQuota(c.env, user.id);
	const ops = pixelOps(c.env);
	const working = await loadWorkingImage(c.env, row.image, MAX_MASK_PX);
	await recordAiRequest(c.env, user.id, "subject_mask");
	const fg = await ops.removeBackground(working.bytes);
	const thumb = await ops.thumbnail(fg.bytes, 128);
	let x0 = thumb.width;
	let y0 = thumb.height;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < thumb.height; y++) {
		for (let x = 0; x < thumb.width; x++) {
			if ((thumb.data[(y * thumb.width + x) * 4 + 3] ?? 0) > 64) {
				if (x < x0) x0 = x;
				if (y < y0) y0 = y;
				if (x > x1) x1 = x;
				if (y > y1) y1 = y;
			}
		}
	}
	const box =
		x1 >= x0 && y1 >= y0
			? {
					x: x0 / thumb.width,
					y: y0 / thumb.height,
					w: Math.max(0.05, (x1 - x0 + 1) / thumb.width),
					h: Math.max(0.05, (y1 - y0 + 1) / thumb.height),
				}
			: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };

	const db = createDb(c.env.DB);
	const segId = crypto.randomUUID();
	const maskKey = mediaKeys(user.id, row.album.id, row.image.id).segmentMask(segId);
	await putObject(c.env.MEDIA, maskKey, fg.bytes, "image/png");
	const [maxOrder] = await db
		.select({ max: sql<number>`COALESCE(MAX(${segments.orderIdx}), 0)` })
		.from(segments)
		.where(eq(segments.imageId, row.image.id));
	const poly = [
		{ x: box.x, y: box.y },
		{ x: box.x + box.w, y: box.y },
		{ x: box.x + box.w, y: box.y + box.h },
		{ x: box.x, y: box.y + box.h },
	];
	const [segment] = await db
		.insert(segments)
		.values({
			id: segId,
			imageId: row.image.id,
			label: "Subject",
			caption: "One-click BiRefNet foreground subject mask.",
			bboxX: box.x,
			bboxY: box.y,
			bboxW: box.w,
			bboxH: box.h,
			polygonJson: JSON.stringify(poly),
			maskR2Key: maskKey,
			orderIdx: (maxOrder?.max ?? 0) + 1,
		})
		.returning();
	return c.json({ segment }, 201);
});

api.post("/images/:id/outpaint", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const padSide = z.number().int().min(0).max(2048);
	const body = await readJson(
		c,
		z.object({
			top: padSide.default(0),
			bottom: padSide.default(0),
			left: padSide.default(0),
			right: padSide.default(0),
			prompt: promptSchema.optional(),
		}),
	);
	if (body.top + body.bottom + body.left + body.right <= 0) fail(400, "empty_outpaint_padding");
	const newW = row.image.widthPx + body.left + body.right;
	const newH = row.image.heightPx + body.top + body.bottom;
	if (newW > WORKING_MAX_PX || newH > WORKING_MAX_PX) fail(400, "dimensions_exceed_limit");
	const pad = { top: body.top, bottom: body.bottom, left: body.left, right: body.right };
	const prompt = body.prompt ?? "";
	const jobId = await startJob(
		c,
		user.id,
		"outpaint",
		{ imageId: row.image.id, pad, prompt },
		{ pad, prompt },
		{ image: row.image, text: prompt || "Extend canvas", opClass: "outpaint" },
	);
	return c.json({ jobId }, 202);
});

api.post("/images/:id/resegment", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const db = createDb(c.env.DB);
	const prevStatus = row.image.segmentStatus;
	await db.update(images).set({ segmentStatus: "pending" }).where(eq(images.id, row.image.id));
	try {
		const jobId = await startJob(c, user.id, "segment", { imageId: row.image.id });
		return c.json({ jobId }, 202);
	} catch (err) {
		await db.update(images).set({ segmentStatus: prevStatus }).where(eq(images.id, row.image.id));
		throw err;
	}
});

// Prompt rewriting (plan 12) — an LLM call, so it is quota-gated too.
api.post("/prompts/rewrite", async (c) => {
	const user = await requireUser(c);
	const body = await readJson(
		c,
		z.object({
			text: z.string().trim().min(1).max(MAX_CHAT_CHARS),
			operation: z.enum(["edit", "generate", "enhance"]).default("edit"),
			context: z.string().max(500).default(""),
		}),
	);
	await requireAiQuota(c.env, user.id);
	await recordAiRequest(c.env, user.id, "rewrite");
	const rewritten = await getProvider(c.env).rewritePrompt(body.text, body.operation, body.context);
	return c.json({ rewritten });
});

// ---------------------------------------------------------------------------
// Palettes (plan 12)
// ---------------------------------------------------------------------------

api.post("/images/:id/palette", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const body = await readJson(
		c,
		z.object({ colors: z.array(hexColor).min(1).max(8), segmentId: idSchema.optional() }),
	);
	if (body.segmentId) {
		const owned = await ownedSegment(c.env, user.id, body.segmentId);
		if (!owned || owned.segment.imageId !== row.image.id) fail(404, "not_found");
	}
	const db = createDb(c.env.DB);
	const paletteId = crypto.randomUUID();
	const [created] = await db.batch([
		db
			.insert(palettes)
			.values({ id: paletteId, ownerId: user.id, colorsJson: JSON.stringify(body.colors), source: "extracted" })
			.returning(),
		db.insert(imagePalettes).values({
			imageId: row.image.id,
			paletteId,
			scope: body.segmentId ? "segment" : "image",
			segmentId: body.segmentId,
		}),
	]);
	return c.json({ palette: created[0] }, 201);
});

api.get("/images/:id/palettes", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const db = createDb(c.env.DB);
	const rows = await db
		.select({ palette: palettes, link: imagePalettes })
		.from(imagePalettes)
		.innerJoin(palettes, eq(palettes.id, imagePalettes.paletteId))
		.where(eq(imagePalettes.imageId, row.image.id));
	return c.json({ palettes: rows });
});

// ---------------------------------------------------------------------------
// Segments (plans 9-10, 20)
// ---------------------------------------------------------------------------

api.get("/images/:id/segments", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const db = createDb(c.env.DB);
	const rows = await db
		.select()
		.from(segments)
		.where(and(eq(segments.imageId, row.image.id), isNull(segments.deletedAt)))
		.orderBy(segments.orderIdx);
	// Honest labeling (plan 17): the client shows a Demo badge when the
	// recognizer cannot actually see the image.
	return c.json({
		segments: rows,
		status: row.image.segmentStatus,
		recognizer: isMock(c.env) ? "demo" : "live",
	});
});

// Custom segment from a lasso polygon or PNG mask: the drawn region becomes a segment.
api.post("/images/:id/segments", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const body = await readJson(
		c,
		z.object({
			label: z.string().trim().min(1).max(40).optional(),
			polygon: z.array(z.object({ x: unit, y: unit })).min(3).max(MAX_POLYGON_POINTS).optional(),
			bbox: bboxSchema.optional(),
			maskPngBase64: z.string().min(16).max(3_000_000).optional(),
		}),
	);
	let x0 = 1;
	let y0 = 1;
	let x1 = 0;
	let y1 = 0;
	if (body.polygon) {
		for (const p of body.polygon) {
			x0 = Math.min(x0, p.x);
			y0 = Math.min(y0, p.y);
			x1 = Math.max(x1, p.x);
			y1 = Math.max(y1, p.y);
		}
	} else if (body.bbox) {
		x0 = body.bbox.x;
		y0 = body.bbox.y;
		x1 = Math.min(1, body.bbox.x + body.bbox.w);
		y1 = Math.min(1, body.bbox.y + body.bbox.h);
	} else {
		fail(400, "polygon_or_bbox_required");
	}
	if (x1 - x0 < 0.01 || y1 - y0 < 0.01) fail(400, "polygon_too_small");
	const db = createDb(c.env.DB);
	const id = crypto.randomUUID();
	const maskKey = mediaKeys(user.id, row.album.id, row.image.id).segmentMask(id);
	let hasMask = false;
	try {
		const mask = body.maskPngBase64
			? decodeBase64Png(body.maskPngBase64)
			: body.polygon
				? await buildPolygonMask(body.polygon, row.image.widthPx || 1024, row.image.heightPx || 1024)
				: null;
		if (mask) {
			await putObject(c.env.MEDIA, maskKey, mask, "image/png");
			hasMask = true;
		}
	} catch (error) {
		logWarn("polygon_mask_failed", error, { imageId: row.image.id });
	}
	const polyJson = body.polygon
		? JSON.stringify(body.polygon)
		: JSON.stringify([
				{ x: x0, y: y0 },
				{ x: x1, y: y0 },
				{ x: x1, y: y1 },
				{ x: x0, y: y1 },
			]);
	const [maxOrder] = await db
		.select({ max: sql<number>`COALESCE(MAX(${segments.orderIdx}), 0)` })
		.from(segments)
		.where(eq(segments.imageId, row.image.id));
	const [segment] = await db
		.insert(segments)
		.values({
			id,
			imageId: row.image.id,
			label: body.label ?? "custom region",
			caption: "A hand-drawn region marked by you for targeted editing.",
			bboxX: x0,
			bboxY: y0,
			bboxW: x1 - x0,
			bboxH: y1 - y0,
			polygonJson: polyJson,
			maskR2Key: hasMask ? maskKey : null,
			orderIdx: (maxOrder?.max ?? 0) + 1,
		})
		.returning();
	return c.json({ segment }, 201);
});

api.get("/segments/:id/mask", async (c) => {
	const user = await requireUser(c);
	const owned = await ownedSegment(c.env, user.id, c.req.param("id"));
	if (!owned || !owned.segment.maskR2Key) fail(404, "not_found");
	const res = await getObject(c.env.MEDIA, owned.segment.maskR2Key, {
		cacheControl: "private, max-age=86400",
		ifNoneMatch: c.req.header("If-None-Match"),
	});
	return res ?? c.json({ error: "not_found" }, 404);
});

api.patch("/segments/:id", async (c) => {
	const user = await requireUser(c);
	const body = await readJson(
		c,
		z.object({
			label: z.string().trim().min(1).max(40).optional(),
			bbox: bboxSchema.optional(),
			locked: z.boolean().optional(),
			hidden: z.boolean().optional(),
		}),
	);
	if (!hasAnyValue(body)) fail(400, "empty_patch");
	const owned = await ownedSegment(c.env, user.id, c.req.param("id"));
	if (!owned) fail(404, "not_found");
	const db = createDb(c.env.DB);
	const [updated] = await db
		.update(segments)
		.set({
			label: body.label,
			bboxX: body.bbox?.x,
			bboxY: body.bbox?.y,
			bboxW: body.bbox ? Math.min(body.bbox.w, 1 - body.bbox.x) : undefined,
			bboxH: body.bbox ? Math.min(body.bbox.h, 1 - body.bbox.y) : undefined,
			lockedAt: body.locked === undefined ? undefined : body.locked ? new Date() : null,
			hiddenAt: body.hidden === undefined ? undefined : body.hidden ? new Date() : null,
		})
		.where(eq(segments.id, owned.segment.id))
		.returning();
	return c.json({ segment: updated });
});

api.delete("/segments/:id", async (c) => {
	const user = await requireUser(c);
	const owned = await ownedSegment(c.env, user.id, c.req.param("id"));
	if (!owned) fail(404, "not_found");
	const db = createDb(c.env.DB);
	await db.update(segments).set({ deletedAt: new Date() }).where(eq(segments.id, owned.segment.id));
	const keys = mediaKeys(user.id, owned.albumId, owned.segment.imageId);
	background(
		c,
		Promise.allSettled([
			c.env.MEDIA.delete(keys.segmentCrop(owned.segment.id)),
			owned.segment.maskR2Key ? c.env.MEDIA.delete(owned.segment.maskR2Key) : Promise.resolve(),
		]),
	);
	return c.json({ ok: true });
});

api.get("/segments/:id/prompts", async (c) => {
	const user = await requireUser(c);
	const owned = await ownedSegment(c.env, user.id, c.req.param("id"));
	if (!owned) fail(404, "not_found");
	const db = createDb(c.env.DB);
	const rows = await db
		.select()
		.from(segmentPrompts)
		.where(eq(segmentPrompts.segmentId, owned.segment.id))
		.orderBy(desc(segmentPrompts.createdAt));
	return c.json({ prompts: rows, caption: owned.segment.caption });
});

api.post("/segments/:id/prompts", async (c) => {
	const user = await requireUser(c);
	const owned = await ownedSegment(c.env, user.id, c.req.param("id"));
	if (!owned) fail(404, "not_found");
	const { text } = await readJson(c, z.object({ text: z.string().trim().min(1).max(1000) }));
	const db = createDb(c.env.DB);
	const id = crypto.randomUUID();
	const [, inserted] = await db.batch([
		db.update(segmentPrompts).set({ isActive: false }).where(eq(segmentPrompts.segmentId, owned.segment.id)),
		db.insert(segmentPrompts).values({ id, segmentId: owned.segment.id, text }).returning(),
		db.update(segments).set({ hasPrompt: true }).where(eq(segments.id, owned.segment.id)),
	]);
	return c.json({ prompt: inserted[0] }, 201);
});

api.get("/segments/:id/crop", async (c) => {
	const user = await requireUser(c);
	const owned = await ownedSegment(c.env, user.id, c.req.param("id"));
	if (!owned) fail(404, "not_found");
	const keys = mediaKeys(user.id, owned.albumId, owned.segment.imageId);
	const res =
		(await getObject(c.env.MEDIA, keys.segmentCrop(owned.segment.id))) ??
		(await getObject(c.env.MEDIA, keys.thumb));
	return res ?? c.json({ error: "not_found" }, 404);
});

// ---------------------------------------------------------------------------
// Chat (plans 5-6)
// ---------------------------------------------------------------------------

api.get("/albums/:id/threads", async (c) => {
	const user = await requireUser(c);
	const album = await requireAlbum(c, user.id, c.req.param("id"));
	const db = createDb(c.env.DB);
	const rows = await db
		.select()
		.from(chatThreads)
		.where(eq(chatThreads.albumId, album.id))
		.orderBy(desc(chatThreads.createdAt));
	return c.json({ threads: rows });
});

api.post("/albums/:id/threads", async (c) => {
	const user = await requireUser(c);
	const album = await requireAlbum(c, user.id, c.req.param("id"));
	const body = await readJson(c, z.object({ new: z.boolean().optional() }));
	const db = createDb(c.env.DB);
	if (!body.new) {
		const [existing] = await db
			.select()
			.from(chatThreads)
			.where(and(eq(chatThreads.albumId, album.id), isNull(chatThreads.rootImageId)))
			.orderBy(desc(chatThreads.createdAt))
			.limit(1);
		if (existing) return c.json({ thread: existing, reused: true });
	}
	const [thread] = await db.insert(chatThreads).values({ id: crypto.randomUUID(), albumId: album.id }).returning();
	if (!body.new) {
		// Under concurrent first-open calls, deterministically prefer the oldest album thread.
		const [canonical] = await db
			.select()
			.from(chatThreads)
			.where(and(eq(chatThreads.albumId, album.id), isNull(chatThreads.rootImageId)))
			.orderBy(asc(chatThreads.createdAt), asc(chatThreads.id))
			.limit(1);
		if (canonical && canonical.id !== thread.id) {
			await db.delete(chatThreads).where(eq(chatThreads.id, thread.id));
			return c.json({ thread: canonical, reused: true });
		}
	}
	return c.json({ thread }, 201);
});

async function ownedThread(c: Ctx, userId: string) {
	const db = createDb(c.env.DB);
	const [row] = await db
		.select({ thread: chatThreads })
		.from(chatThreads)
		.innerJoin(albums, eq(albums.id, chatThreads.albumId))
		.innerJoin(projects, eq(projects.id, albums.projectId))
		.where(and(eq(chatThreads.id, c.req.param("id") ?? ""), eq(projects.ownerId, userId)))
		.limit(1);
	if (!row) fail(404, "not_found");
	return row.thread;
}

api.post("/threads/:id/messages", async (c) => {
	const user = await requireUser(c);
	const thread = await ownedThread(c, user.id);
	const body = await readJson(
		c,
		z.object({
			text: z.string().trim().min(1).max(MAX_CHAT_CHARS),
			attachedImageId: idSchema.optional(),
			segmentId: idSchema.optional(),
			mentionImageIds: z.array(idSchema).max(10).optional(),
			paletteIds: z.array(idSchema).max(10).optional(),
		}),
	);
	await requireAiQuota(c.env, user.id);
	const stream = streamAgentResponse(c.env, {
		threadId: thread.id,
		albumId: thread.albumId,
		user,
		origin: origin(c),
		rootImageId: thread.rootImageId,
		...body,
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"X-Content-Type-Options": "nosniff",
		},
	});
});

api.get("/threads/:id/messages", async (c) => {
	const user = await requireUser(c);
	const thread = await ownedThread(c, user.id);
	const db = createDb(c.env.DB);
	const rows = await db
		.select()
		.from(chatMessages)
		.where(eq(chatMessages.threadId, thread.id))
		.orderBy(chatMessages.createdAt);
	return c.json({ messages: rows });
});

// Jobs
api.get("/jobs/:id", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const [job] = await db
		.select()
		.from(jobs)
		.where(and(eq(jobs.id, c.req.param("id")), eq(jobs.userId, user.id)))
		.limit(1);
	if (!job) fail(404, "not_found");
	return c.json({
		job: {
			id: job.id,
			type: job.type,
			status: job.status,
			progress: job.progress,
			imageId: job.imageId,
			segmentId: job.segmentId,
			resultImageId: job.resultImageId,
			creditsCharged: job.creditsCharged,
			error: job.error
				? job.error.startsWith("fidelity_check_failed") || job.error.startsWith("stale")
					? job.error
					: friendlyError(job.error)
				: null,
			createdAt: job.createdAt,
			finishedAt: job.finishedAt,
		},
	});
});

/** Duplicate an image (current pixels) into the same album (plan 20). */
api.post("/images/:id/duplicate", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	await requireMediaQuota(c.env, user.id);
	const { bytes } = await loadImageBytes(c.env, row.image);
	const { image } = await createImageFromBytes(c.env, {
		userId: user.id,
		albumId: row.album.id,
		bytes,
		kind: row.image.kind,
		label: "Duplicate",
		filenameLabel: `${row.image.filenameLabel} copy`,
		sourceImageId: row.image.sourceImageId,
		rootImageId: row.image.rootImageId ?? row.image.id,
		operation: "duplicate",
	});
	return c.json({ image }, 201);
});

// Editor history (phase 5): the photo family's timeline + its chat thread.
api.get("/images/:id/history", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const threadId = await ensureFamilyThread(createDb(c.env.DB), row.image);
	const { rootImageId, turns } = await familyHistory(c.env, row.image);
	return c.json({ threadId, rootImageId, turns });
});

// Branch family (plan 24): scoped to rootImageId instead of scanning whole album.
api.get("/images/:id/branch", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const db = createDb(c.env.DB);
	const familyRootId = row.image.rootImageId ?? row.image.id;
	const albumImages = await db
		.select()
		.from(images)
		.where(
			and(
				eq(images.albumId, row.album.id),
				or(eq(images.rootImageId, familyRootId), eq(images.id, familyRootId), eq(images.id, row.image.id)),
			),
		)
		.orderBy(asc(images.createdAt));
	const byId = new Map(albumImages.map((img) => [img.id, img]));
	const children = new Map<string, string[]>();
	for (const img of albumImages) {
		if (!img.sourceImageId) continue;
		children.set(img.sourceImageId, [...(children.get(img.sourceImageId) ?? []), img.id]);
	}
	let root = row.image;
	for (let i = 0; i < 50; i++) {
		const parent = root.sourceImageId ? byId.get(root.sourceImageId) : undefined;
		if (!parent) break;
		root = parent;
	}
	const family: ImageRow[] = [];
	const queue = [root.id];
	const seen = new Set<string>();
	while (queue.length > 0 && family.length < 100) {
		const id = queue.shift()!;
		if (seen.has(id)) continue;
		seen.add(id);
		const img = byId.get(id);
		if (!img) continue;
		family.push(img);
		queue.push(...(children.get(id) ?? []));
	}
	return c.json({ images: family, rootId: root.id });
});

// ---------------------------------------------------------------------------
// Pinned edit instructions (annotate-then-apply)
// ---------------------------------------------------------------------------

api.get("/images/:id/instructions", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
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
	const row = await requireImage(c, user.id);
	const body = await readJson(
		c,
		z.object({
			text: z.string().trim().min(1).max(300),
			bbox: bboxSchema,
			polygon: z.array(z.object({ x: unit, y: unit })).min(3).max(MAX_POLYGON_POINTS).optional(),
			maskPngBase64: z.string().min(16).max(3_000_000).optional(),
		}),
	);
	const db = createDb(c.env.DB);
	const instId = crypto.randomUUID();
	let maskR2Key: string | null = null;
	if (body.maskPngBase64 || body.polygon) {
		const maskBytes = body.maskPngBase64
			? decodeBase64Png(body.maskPngBase64)
			: await buildPolygonMask(body.polygon!, row.image.widthPx || 1024, row.image.heightPx || 1024);
		maskR2Key = mediaKeys(user.id, row.album.id, row.image.id).instructionMask(instId);
		await putObject(c.env.MEDIA, maskR2Key, maskBytes, "image/png");
	}
	const [instruction] = await db
		.insert(editInstructions)
		.values({
			id: instId,
			imageId: row.image.id,
			text: body.text,
			bboxX: body.bbox.x,
			bboxY: body.bbox.y,
			bboxW: Math.min(body.bbox.w, 1 - body.bbox.x),
			bboxH: Math.min(body.bbox.h, 1 - body.bbox.y),
			maskR2Key,
		})
		.returning();
	return c.json({ instruction }, 201);
});

api.delete("/instructions/:id", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const [row] = await db
		.select({ id: editInstructions.id, maskR2Key: editInstructions.maskR2Key })
		.from(editInstructions)
		.innerJoin(images, eq(images.id, editInstructions.imageId))
		.innerJoin(albums, eq(albums.id, images.albumId))
		.innerJoin(projects, eq(projects.id, albums.projectId))
		.where(and(eq(editInstructions.id, c.req.param("id")), eq(projects.ownerId, user.id)))
		.limit(1);
	if (!row) fail(404, "not_found");
	await db.delete(editInstructions).where(eq(editInstructions.id, row.id));
	if (row.maskR2Key) background(c, c.env.MEDIA.delete(row.maskR2Key));
	return c.json({ ok: true });
});

/** Apply pending instructions in ONE generation pass → branched photo.
 * Atomically locks chosen chips to `applying` before queueing to avoid races. */
api.post("/images/:id/apply-instructions", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const body = await readJson(
		c,
		z.object({ instructionIds: z.array(idSchema).min(1).max(MAX_BATCH_INSTRUCTIONS).optional() }),
	);
	const db = createDb(c.env.DB);
	const candidates = await db
		.select({ id: editInstructions.id })
		.from(editInstructions)
		.where(
			and(
				eq(editInstructions.imageId, row.image.id),
				eq(editInstructions.status, "pending"),
				body.instructionIds ? inArray(editInstructions.id, body.instructionIds) : undefined,
			),
		)
		.orderBy(asc(editInstructions.createdAt))
		.limit(MAX_BATCH_INSTRUCTIONS);
	if (candidates.length === 0) fail(400, "no_instructions");

	const locked = await db
		.update(editInstructions)
		.set({ status: "applying" })
		.where(
			and(
				eq(editInstructions.imageId, row.image.id),
				eq(editInstructions.status, "pending"),
				inArray(editInstructions.id, candidates.map((p) => p.id)),
			),
		)
		.returning();
	if (locked.length === 0) fail(409, "already_applying");

	const instructions = locked.map((p) => ({
		text: p.text,
		bbox: { x: p.bboxX, y: p.bboxY, w: p.bboxW, h: p.bboxH },
		...(p.maskR2Key ? { maskR2Key: p.maskR2Key } : {}),
	}));
	const label = autoTitleFromInstructions(locked.map((p) => p.text));
	try {
		const jobId = await startJob(
			c,
			user.id,
			"batch_edit",
			{ imageId: row.image.id, instructions, instructionIds: locked.map((p) => p.id), label },
			{ instructions, label },
			{
				image: row.image,
				text: locked.map((p) => p.text).join("; "),
				opClass: "local",
				bboxes: instructions.map((i) => i.bbox),
			},
		);
		return c.json({ jobId, label }, 202);
	} catch (err) {
		await db
			.update(editInstructions)
			.set({ status: "pending" })
			.where(
				and(
					eq(editInstructions.imageId, row.image.id),
					eq(editInstructions.status, "applying"),
					inArray(editInstructions.id, locked.map((p) => p.id)),
				),
			);
		throw err;
	}
});

/** "change sunglass to eyeglass" -> "Eyeglass & business coat" style titles. */
export function autoTitleFromInstructions(texts: string[]): string {
	const targets = texts.map((t) => {
		const m = /(?:change|make|turn|replace|reupholster|convert)[\w\s]*?\bto\s+(.{2,40})/i.exec(t);
		return (m ? m[1]! : t).trim().replace(/[.!?]+$/, "");
	});
	const joined = targets.join(" & ");
	const titled = joined.charAt(0).toUpperCase() + joined.slice(1);
	return titled.slice(0, 60) || "Edited photo";
}

// ---------------------------------------------------------------------------
// Share (plan 13)
// ---------------------------------------------------------------------------

api.get("/images/:id/shares", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const db = createDb(c.env.DB);
	const nowMs = Date.now();
	const rows = await db
		.select()
		.from(shareLinks)
		.where(and(eq(shareLinks.imageId, row.image.id), eq(shareLinks.userId, user.id), isNull(shareLinks.revokedAt)))
		.orderBy(desc(shareLinks.createdAt));
	const active = rows.filter((r) => !r.expiresAt || r.expiresAt.getTime() > nowMs);
	return c.json({ shares: active });
});

api.post("/images/:id/share", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	const body = await readJson(
		c,
		z.object({
			allowDownload: z.boolean().default(true),
			expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
		}),
	);
	const db = createDb(c.env.DB);
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	const [link] = await db
		.insert(shareLinks)
		.values({
			id: crypto.randomUUID(),
			token,
			userId: user.id,
			imageId: row.image.id,
			allowDownload: body.allowDownload,
			expiresAt: body.expiresInHours ? new Date(Date.now() + body.expiresInHours * 3600_000) : null,
		})
		.returning();
	return c.json({ share: link, url: `/s/${token}` }, 201);
});

api.delete("/share/:id", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const [revoked] = await db
		.update(shareLinks)
		.set({ revokedAt: new Date() })
		.where(and(eq(shareLinks.id, c.req.param("id")), eq(shareLinks.userId, user.id)))
		.returning({ id: shareLinks.id });
	if (!revoked) fail(404, "not_found");
	return c.json({ ok: true });
});

/** Resolve a share token to a live link + image, or 404. Access is always
 * by TOKEN: knowing an image id grants nothing. */
async function liveShare(env: Env, token: string) {
	const db = createDb(env.DB);
	const [row] = await db
		.select({ link: shareLinks, image: images })
		.from(shareLinks)
		.innerJoin(images, eq(images.id, shareLinks.imageId))
		.where(eq(shareLinks.token, token))
		.limit(1);
	if (!row || row.link.revokedAt || (row.link.expiresAt && row.link.expiresAt.getTime() < Date.now())) {
		return null;
	}
	return row;
}

api.get("/public/share/:token", async (c) => {
	const share = await liveShare(c.env, c.req.param("token"));
	if (!share) fail(404, "not_found");
	return c.json({
		share: {
			allowDownload: share.link.allowDownload,
			title: share.image.filenameLabel,
			adjustmentsJson: share.image.adjustmentsJson,
			hasOverlay: Boolean(share.image.overlayR2Key),
		},
	});
});

/** Public file: the web variant for viewing; the full-resolution original
 * ONLY when the owner allowed downloads. Composites text overlay if saved. */
api.get("/public/share/:token/file", async (c) => {
	const share = await liveShare(c.env, c.req.param("token"));
	if (!share) fail(404, "not_found");
	const variant = variantSchema.parse(c.req.query("variant"));
	if (variant === "original" && !share.link.allowDownload) fail(403, "download_disabled");
	const version = await currentVersion(c.env, share.image);
	const key = variantKey(share.image, version, variant);
	if (share.image.overlayR2Key) {
		const obj = await c.env.MEDIA.get(key);
		if (!obj) fail(404, "not_found");
		const baseBytes = await obj.arrayBuffer();
		const composited = await compositeOverlay(c.env, baseBytes, share.image.overlayR2Key);
		const outBytes = composited ? composited.bytes : baseBytes;
		const outMime = composited ? composited.mime : (obj.httpMetadata?.contentType ?? share.image.mime);
		const ext = extForMime(outMime);
		const headers: Record<string, string> = {
			"Content-Type": outMime,
			"Cache-Control": "private, max-age=300",
		};
		if (variant === "original") {
			headers["Content-Disposition"] = `attachment; filename="editorium-${share.image.id.slice(0, 8)}.${ext}"`;
		}
		return new Response(outBytes, { headers });
	}
	const res = await getObject(c.env.MEDIA, key, {
		cacheControl: "private, max-age=300",
		ifNoneMatch: c.req.header("If-None-Match"),
	});
	if (!res) fail(404, "not_found");
	if (variant === "original" && res.status === 200) {
		const ext = extForMime(res.headers.get("Content-Type") ?? share.image.mime);
		res.headers.set("Content-Disposition", `attachment; filename="editorium-${share.image.id.slice(0, 8)}.${ext}"`);
	}
	return res;
});

// ---------------------------------------------------------------------------
// Canvas text annotations & baked transparent PNG overlay
// ---------------------------------------------------------------------------

api.post("/images/:id/annotations-overlay", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
	await requireMediaQuota(c.env, user.id);
	const form = await parseMultipart(c);
	const file = form["file"];
	const db = createDb(c.env.DB);
	const overlayKey = mediaKeys(user.id, row.album.id, row.image.id).overlay;
	if (!file) {
		await db.update(images).set({ overlayR2Key: null }).where(eq(images.id, row.image.id));
		background(c, c.env.MEDIA.delete(overlayKey));
		return c.json({ ok: true, overlayR2Key: null });
	}
	if (!(file instanceof File)) fail(400, "file_required");
	if (file.size === 0 || file.size > 4 * 1024 * 1024) fail(413, "invalid_file");
	const bytes = await file.arrayBuffer();
	if (sniffMime(bytes) !== "image/png") fail(400, "overlay_must_be_png");
	await putObject(c.env.MEDIA, overlayKey, bytes, "image/png");
	await db.update(images).set({ overlayR2Key: overlayKey }).where(eq(images.id, row.image.id));
	return c.json({ ok: true, overlayR2Key: overlayKey });
});

api.get("/images/:id/annotations", async (c) => {
	const user = await requireUser(c);
	const row = await requireImage(c, user.id);
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
	const row = await requireImage(c, user.id);
	const body = await readJson(
		c,
		z.object({
			text: z.string().trim().min(1).max(300),
			normX: unit.default(0.5),
			normY: unit.default(0.5),
			fontSize: z.number().min(0.01).max(0.3).default(0.04),
			color: hexColor.default("#ffffff"),
		}),
	);
	const db = createDb(c.env.DB);
	const [annotation] = await db
		.insert(imageAnnotations)
		.values({ id: crypto.randomUUID(), imageId: row.image.id, ...body })
		.returning();
	return c.json({ annotation }, 201);
});

api.delete("/annotations/:id", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const [row] = await db
		.select({ id: imageAnnotations.id })
		.from(imageAnnotations)
		.innerJoin(images, eq(images.id, imageAnnotations.imageId))
		.innerJoin(albums, eq(albums.id, images.albumId))
		.innerJoin(projects, eq(projects.id, albums.projectId))
		.where(and(eq(imageAnnotations.id, c.req.param("id")), eq(projects.ownerId, user.id)))
		.limit(1);
	if (!row) fail(404, "not_found");
	await db.delete(imageAnnotations).where(eq(imageAnnotations.id, row.id));
	return c.json({ ok: true });
});

// Usage (plan 13)
api.get("/usage", async (c) => {
	const user = await requireUser(c);
	const db = createDb(c.env.DB);
	const rows = await db
		.select({
			reason: creditEvents.reason,
			total: sql<number>`COUNT(*)`,
			credits: sql<number>`SUM(${creditEvents.delta})`,
		})
		.from(creditEvents)
		.where(eq(creditEvents.userId, user.id))
		.groupBy(creditEvents.reason);
	return c.json({ balance: user.creditBalance, events: rows });
});

// Signed public image URL — lets external services (Pruna P-Image family)
// fetch a photo without exposing the album. `?norm=1` bakes EXIF rotation.
api.get("/pub/img/:token", async (c) => {
	const imageId = await verifyPublicImageUrl(c.env, c.req.param("token"));
	if (!imageId) fail(404, "invalid_or_expired");
	const db = createDb(c.env.DB);
	const [image] = await db.select().from(images).where(eq(images.id, imageId)).limit(1);
	if (!image) fail(404, "not_found");
	if (c.req.query("norm") === "1") {
		const working = await loadWorkingImage(c.env, image);
		return new Response(working.bytes, {
			headers: { "Content-Type": working.mime, "Cache-Control": "private, no-store" },
		});
	}
	const version = await currentVersion(c.env, image);
	const res = await getObject(c.env.MEDIA, variantKey(image, version, "original"), {
		cacheControl: "private, no-store",
	});
	return res ?? c.json({ error: "not_found" }, 404);
});
