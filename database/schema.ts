import { sql } from "drizzle-orm";
import {
	foreignKey,
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

/** Generic, non-secret application metadata. */
export const appMetadata = sqliteTable("app_metadata", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
});

export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	email: text("email"),
	name: text("name").notNull(),
	plan: text("plan").notNull().default("free"),
	creditBalance: integer("credit_balance").notNull().default(20),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
});

export const projects = sqliteTable(
	"projects",
	{
		id: text("id").primaryKey(),
		ownerId: text("owner_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.default(now),
	},
	// One default project per user: concurrent first requests converge.
	(t) => [uniqueIndex("projects_owner_unique").on(t.ownerId)],
);

export const albums = sqliteTable(
	"albums",
	{
	id: text("id").primaryKey(),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	title: text("title").notNull(),
	coverImageId: text("cover_image_id"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
	},
	(t) => [index("albums_project_idx").on(t.projectId)],
);

export const images = sqliteTable(
	"images",
	{
		id: text("id").primaryKey(),
		albumId: text("album_id")
			.notNull()
			.references(() => albums.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: ["upload", "generated", "edited"] }).notNull(),
		r2KeyOriginal: text("r2_key_original").notNull(),
		r2KeyWeb: text("r2_key_web"),
		r2KeyThumb: text("r2_key_thumb"),
		mime: text("mime").notNull(),
		widthPx: integer("width_px").notNull().default(0),
		heightPx: integer("height_px").notNull().default(0),
		sizeBytes: integer("size_bytes").notNull().default(0),
		sourceImageId: text("source_image_id"),
		/** Original upload this photo descends from (itself for roots). One
		 * editor history ("photo family") per root — phase 5. */
		rootImageId: text("root_image_id"),
		currentVersionId: text("current_version_id"),
		filenameLabel: text("filename_label").notNull(),
		bookmarkedAt: integer("bookmarked_at", { mode: "timestamp_ms" }),
		segmentStatus: text("segment_status", {
			enum: ["none", "pending", "partial", "ready", "failed"],
		})
			.notNull()
			.default("none"),
		positionIdx: integer("position_idx").notNull().default(0),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.default(now),
	},
	(t) => [
		foreignKey({
			columns: [t.sourceImageId],
			foreignColumns: [t.id],
			name: "images_source_fk",
		}).onDelete("set null"),
		index("images_album_idx").on(t.albumId, t.positionIdx),
		index("images_source_idx").on(t.sourceImageId),
		index("images_root_idx").on(t.rootImageId),
	],
);

export const imageVersions = sqliteTable(
	"image_versions",
	{
	id: text("id").primaryKey(),
	imageId: text("image_id")
		.notNull()
		.references(() => images.id, { onDelete: "cascade" }),
	parentVersionId: text("parent_version_id"),
	label: text("label").notNull(),
	r2KeyFull: text("r2_key_full").notNull(),
	r2KeyWeb: text("r2_key_web"),
	r2KeyThumb: text("r2_key_thumb"),
	prompt: text("prompt"),
	operation: text("operation"),
	/** Phase 4 audit: fidelity class, producing model, guard score (r). */
	opClass: text("op_class"),
	model: text("model"),
	fidelity: real("fidelity"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
	},
	(t) => [index("image_versions_image_idx").on(t.imageId)],
);

export const segments = sqliteTable(
	"segments",
	{
	id: text("id").primaryKey(),
	imageId: text("image_id")
		.notNull()
		.references(() => images.id, { onDelete: "cascade" }),
	parentSegmentId: text("parent_segment_id"),
	label: text("label").notNull(),
	caption: text("caption"),
	bboxX: real("bbox_x").notNull(),
	bboxY: real("bbox_y").notNull(),
	bboxW: real("bbox_w").notNull(),
	bboxH: real("bbox_h").notNull(),
	maskR2Key: text("mask_r2_key"),
	polygonJson: text("polygon_json"),
	lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
	hiddenAt: integer("hidden_at", { mode: "timestamp_ms" }),
	deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
	hasPrompt: integer("has_prompt", { mode: "boolean" }).notNull().default(false),
	orderIdx: integer("order_idx").notNull().default(0),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
	},
	(t) => [index("segments_image_idx").on(t.imageId, t.orderIdx)],
);

export const segmentPrompts = sqliteTable(
	"segment_prompts",
	{
	id: text("id").primaryKey(),
	segmentId: text("segment_id")
		.notNull()
		.references(() => segments.id, { onDelete: "cascade" }),
	text: text("text").notNull(),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
	},
	(t) => [index("segment_prompts_segment_idx").on(t.segmentId)],
);

export const chatThreads = sqliteTable(
	"chat_threads",
	{
	id: text("id").primaryKey(),
	albumId: text("album_id")
		.notNull()
		.references(() => albums.id, { onDelete: "cascade" }),
	title: text("title").notNull().default("New chat"),
	/** Set for a photo family's editor history; null for album chats. */
	rootImageId: text("root_image_id"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
	},
	(t) => [
		index("chat_threads_album_idx").on(t.albumId),
		uniqueIndex("chat_threads_family_unique").on(t.albumId, t.rootImageId),
	],
);

export const chatMessages = sqliteTable(
	"chat_messages",
	{
	id: text("id").primaryKey(),
	threadId: text("thread_id")
		.notNull()
		.references(() => chatThreads.id, { onDelete: "cascade" }),
	role: text("role", { enum: ["user", "assistant"] }).notNull(),
	text: text("text").notNull().default(""),
	attachedImageId: text("attached_image_id"),
	segmentId: text("segment_id"),
	mentionImageIds: text("mention_image_ids"),
	attachedPaletteIds: text("attached_palette_ids"),
	resultImageId: text("result_image_id"),
	resultVersionId: text("result_version_id"),
	operation: text("operation", {
		enum: ["answer", "generate", "enhance", "edit", "describe"],
	}),
	jobId: text("job_id"),
	/** Phase 5 history: the photo acted on, its family, the operation class,
	 * the region(s) as JSON [{x,y,w,h}], and (assistant) the request answered. */
	imageId: text("image_id"),
	rootImageId: text("root_image_id"),
	opClass: text("op_class"),
	bboxJson: text("bbox_json"),
	replyToId: text("reply_to_id"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
	},
	(t) => [
		index("chat_messages_thread_idx").on(t.threadId, t.createdAt),
		index("chat_messages_root_idx").on(t.rootImageId, t.createdAt),
	],
);

export const editInstructions = sqliteTable(
	"edit_instructions",
	{
	id: text("id").primaryKey(),
	imageId: text("image_id")
		.notNull()
		.references(() => images.id, { onDelete: "cascade" }),
	text: text("text").notNull(),
	bboxX: real("bbox_x").notNull(),
	bboxY: real("bbox_y").notNull(),
	bboxW: real("bbox_w").notNull(),
	bboxH: real("bbox_h").notNull(),
	status: text("status", { enum: ["pending", "applied"] })
		.notNull()
		.default("pending"),
	resultImageId: text("result_image_id"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
	},
	(t) => [index("edit_instructions_image_idx").on(t.imageId, t.status)],
);

export const jobs = sqliteTable(
	"jobs",
	{
	id: text("id").primaryKey(),
	type: text("type", {
		enum: ["segment", "generate", "enhance", "inpaint", "caption", "thumb", "batch_edit", "remove_bg"],
	}).notNull(),
	userId: text("user_id").notNull(),
	imageId: text("image_id"),
	segmentId: text("segment_id"),
	status: text("status", {
		enum: ["queued", "running", "done", "error"],
	})
		.notNull()
		.default("queued"),
	progress: integer("progress").notNull().default(0),
	error: text("error"),
	payloadJson: text("payload_json"),
	workflowId: text("workflow_id"),
	resultImageId: text("result_image_id"),
	creditsCharged: integer("credits_charged").notNull().default(0),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
	finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	},
	(t) => [index("jobs_user_created_idx").on(t.userId, t.createdAt)],
);

export const palettes = sqliteTable("palettes", {
	id: text("id").primaryKey(),
	ownerId: text("owner_id").notNull(),
	colorsJson: text("colors_json").notNull(),
	source: text("source", { enum: ["manual", "extracted"] })
		.notNull()
		.default("manual"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
});

export const imagePalettes = sqliteTable(
	"image_palettes",
	{
	imageId: text("image_id")
		.notNull()
		.references(() => images.id, { onDelete: "cascade" }),
	paletteId: text("palette_id")
		.notNull()
		.references(() => palettes.id, { onDelete: "cascade" }),
	scope: text("scope", { enum: ["image", "segment"] })
		.notNull()
		.default("image"),
	segmentId: text("segment_id"),
	},
	(t) => [index("image_palettes_image_idx").on(t.imageId)],
);

export const references = sqliteTable("references", {
	id: text("id").primaryKey(),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	r2KeyThumb: text("r2_key_thumb").notNull(),
	kind: text("kind").notNull().default("image"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
});

export const shareLinks = sqliteTable(
	"share_links",
	{
	id: text("id").primaryKey(),
	token: text("token").notNull().unique(),
	userId: text("user_id").notNull(),
	imageId: text("image_id"),
	albumId: text("album_id"),
	allowDownload: integer("allow_download", { mode: "boolean" })
		.notNull()
		.default(true),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
	revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
	},
	(t) => [index("share_links_image_idx").on(t.imageId)],
);

export const creditEvents = sqliteTable(
	"credit_events",
	{
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	delta: integer("delta").notNull(),
	reason: text("reason").notNull(),
	jobId: text("job_id"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
	},
	(t) => [index("credit_events_user_idx").on(t.userId)],
);

/** Canvas text annotations (plan 20): rendered over the image and baked
 * into the download export. Positions are normalized 0..1. */
export const imageAnnotations = sqliteTable(
	"image_annotations",
	{
	id: text("id").primaryKey(),
	imageId: text("image_id")
		.notNull()
		.references(() => images.id, { onDelete: "cascade" }),
	text: text("text").notNull(),
	normX: real("norm_x").notNull().default(0.5),
	normY: real("norm_y").notNull().default(0.5),
	fontSize: real("font_size").notNull().default(0.04),
	color: text("color").notNull().default("#ffffff"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(now),
	},
	(t) => [index("image_annotations_image_idx").on(t.imageId)],
);

export type ImageAnnotation = typeof imageAnnotations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Album = typeof albums.$inferSelect;
export type ImageRow = typeof images.$inferSelect;
export type ImageVersion = typeof imageVersions.$inferSelect;
export type Segment = typeof segments.$inferSelect;
export type ChatThread = typeof chatThreads.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type EditInstruction = typeof editInstructions.$inferSelect;
export type Palette = typeof palettes.$inferSelect;
export type ShareLink = typeof shareLinks.$inferSelect;
