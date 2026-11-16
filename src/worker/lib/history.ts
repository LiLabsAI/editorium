/**
 * Editor history (phase 5). One chat thread per photo family (original +
 * every branch), recorded server-side so every action — buttons, presets,
 * region edits, chat — survives reloads, other tabs and failures.
 *
 * Each action is a request message (role user) and a reply message (role
 * assistant, `reply_to_id` → request). Reply state is never stored twice:
 * it is derived from the job row (queued/running/done/error, refund) when
 * the timeline is read.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
	chatMessages,
	chatThreads,
	imageVersions,
	images,
	jobs,
	type ChatMessage,
	type ImageRow,
	type Job,
} from "../../../database/schema";
import { createDb } from "./db";
import { CREDIT_COSTS, type JobType } from "./jobs";

type Db = ReturnType<typeof createDb>;
export type Box = { x: number; y: number; w: number; h: number };

export type OpClass =
	| "adjust"
	| "enhance"
	| "segment"
	| "local"
	| "reimagine"
	| "style_transfer"
	| "outpaint"
	| "generate"
	| "answer"
	| "upload";

export function familyRoot(image: Pick<ImageRow, "id" | "rootImageId">): string {
	return image.rootImageId ?? image.id;
}

/** The family's history thread, created on first use (unique per album+root). */
export async function ensureFamilyThread(db: Db, image: ImageRow): Promise<string> {
	const root = familyRoot(image);
	const where = and(eq(chatThreads.albumId, image.albumId), eq(chatThreads.rootImageId, root));
	const [existing] = await db.select({ id: chatThreads.id }).from(chatThreads).where(where).limit(1);
	if (existing) return existing.id;
	await db
		.insert(chatThreads)
		.values({ id: crypto.randomUUID(), albumId: image.albumId, rootImageId: root, title: "Photo history" })
		.onConflictDoNothing({ target: [chatThreads.albumId, chatThreads.rootImageId] });
	const [thread] = await db.select({ id: chatThreads.id }).from(chatThreads).where(where).limit(1);
	return thread!.id;
}

/**
 * Record one action as a request + reply pair in the family thread. Called
 * when the job is created (reply linked to the job) or, for instant
 * operations, with the finished result.
 */
export async function recordAction(
	db: Db,
	opts: {
		image: ImageRow;
		text: string;
		opClass: OpClass;
		bboxes?: Box[];
		jobId?: string;
		resultImageId?: string;
		replyText?: string;
		threadId?: string;
	},
): Promise<{ threadId: string; requestId: string; replyId: string }> {
	const threadId = opts.threadId ?? (await ensureFamilyThread(db, opts.image));
	const requestId = crypto.randomUUID();
	const replyId = crypto.randomUUID();
	const common = {
		threadId,
		imageId: opts.image.id,
		rootImageId: familyRoot(opts.image),
		opClass: opts.opClass,
		jobId: opts.jobId ?? null,
	};
	await db.batch([
		db.insert(chatMessages).values({
			...common,
			id: requestId,
			role: "user",
			text: opts.text,
			bboxJson: opts.bboxes?.length ? JSON.stringify(opts.bboxes) : null,
		}),
		db.insert(chatMessages).values({
			...common,
			id: replyId,
			role: "assistant",
			text: opts.replyText ?? "",
			replyToId: requestId,
			resultImageId: opts.resultImageId ?? null,
		}),
	]);
	return { threadId, requestId, replyId };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type TurnStatus = "queued" | "running" | "done" | "error";

export interface HistoryTurn {
	id: string;
	createdAt: string;
	/** True for entries reconstructed from photo records (before phase 5). */
	derived: boolean;
	request: {
		text: string;
		opClass: OpClass | null;
		bboxes: Box[];
		imageId: string | null;
	};
	reply: {
		status: TurnStatus;
		text: string;
		/** Plain-language failure reason (never a raw exception). */
		error: string | null;
		credits: number;
		refunded: boolean;
		result: {
			imageId: string;
			label: string;
			opClass: string | null;
			model: string | null;
			fidelity: number | null;
			exists: boolean;
		} | null;
	};
}

/** Translate job errors into sentences for the UI. */
export function friendlyError(raw: string | null): string {
	if (!raw) return "Something went wrong. Try again.";
	if (raw.startsWith("fidelity_check_failed")) {
		return "The result didn't match your photo, so it wasn't saved.";
	}
	if (/no image|All editing models failed|returned nothing/i.test(raw)) {
		return "The AI model didn't return an image. Try again.";
	}
	if (raw.startsWith("stale")) return "This request never ran.";
	if (/too large/i.test(raw)) return "This photo is too large to process.";
	if (/segment (not found|is locked)/.test(raw)) return "That region is no longer available.";
	return "Something went wrong. Try again.";
}

const STALE_RUNNING_MS = 90_000;

const OPERATION_CLASS: Record<string, OpClass> = {
	filter: "adjust",
	enhance: "enhance",
	remove_bg: "segment",
	generate: "generate",
	edit: "reimagine",
	style_transfer: "style_transfer",
	outpaint: "outpaint",
	upload: "upload",
	duplicate: "upload",
};

function parseBoxes(json: string | null): Box[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json) as unknown;
		return Array.isArray(parsed) ? (parsed as Box[]) : [];
	} catch {
		return [];
	}
}

/** Build the family timeline for the photo's root, oldest first. */
export async function familyHistory(env: Env, image: ImageRow): Promise<{ rootImageId: string; turns: HistoryTurn[] }> {
	const db = createDb(env.DB);
	const root = familyRoot(image);

	const [messages, family] = await Promise.all([
		db
			.select({ message: chatMessages })
			.from(chatMessages)
			.innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
			.where(and(eq(chatMessages.rootImageId, root), eq(chatThreads.albumId, image.albumId)))
			.orderBy(asc(chatMessages.createdAt), asc(sql`"chat_messages"."rowid"`)),
		db
			.select({ image: images, version: imageVersions })
			.from(images)
			.leftJoin(imageVersions, eq(imageVersions.id, images.currentVersionId))
			.where(and(eq(images.albumId, image.albumId), eq(images.rootImageId, root))),
	]);
	const msgs = messages.map((m) => m.message);
	const byImage = new Map(family.map((f) => [f.image.id, f]));

	const jobIds = [...new Set(msgs.map((m) => m.jobId).filter((id): id is string => !!id))];
	const jobRows: Job[] = jobIds.length ? await db.select().from(jobs).where(inArray(jobs.id, jobIds)) : [];
	const jobById = new Map(jobRows.map((j) => [j.id, j]));

	const replies = new Map<string, ChatMessage>();
	for (const m of msgs) if (m.role === "assistant" && m.replyToId) replies.set(m.replyToId, m);

	const resultOf = (imageId: string | null | undefined): HistoryTurn["reply"]["result"] => {
		if (!imageId) return null;
		const row = byImage.get(imageId);
		return {
			imageId,
			label: row?.version?.label ?? row?.image.filenameLabel ?? "Deleted photo",
			opClass: row?.version?.opClass ?? null,
			model: row?.version?.model ?? null,
			fidelity: row?.version?.fidelity ?? null,
			exists: !!row,
		};
	};

	const nowMs = Date.now();
	const turns: HistoryTurn[] = [];
	const seenResults = new Set<string>();
	for (const request of msgs) {
		if (request.role !== "user") continue;
		const reply = replies.get(request.id);
		const job = request.jobId ? jobById.get(request.jobId) : undefined;
		const resultImageId = reply?.resultImageId ?? job?.resultImageId ?? null;
		if (resultImageId) seenResults.add(resultImageId);

		let status: TurnStatus = "done";
		let staleError: string | null = null;
		if (job) {
			status = job.status;
		} else if (!reply || (!reply.text && !reply.resultImageId)) {
			if (nowMs - request.createdAt.getTime() > STALE_RUNNING_MS) {
				status = "error";
				staleError = "The response was interrupted. Try asking again.";
			} else {
				status = "running"; // answer still streaming
			}
		}

		const cost = job ? (CREDIT_COSTS[job.type as JobType] ?? 0) : 0;
		turns.push({
			id: request.id,
			createdAt: request.createdAt.toISOString(),
			derived: false,
			request: {
				text: request.text,
				opClass: (request.opClass as OpClass | null) ?? null,
				bboxes: parseBoxes(request.bboxJson),
				imageId: request.imageId,
			},
			reply: {
				status,
				text: reply?.text ?? "",
				error: status === "error" ? (staleError ?? friendlyError(job?.error ?? null)) : null,
				credits: cost,
				refunded: status === "error" && cost > 0 && (job?.creditsCharged ?? 0) === 0,
				result: status === "done" ? resultOf(resultImageId) : null,
			},
		});
	}

	// Photos in the family with no recorded request (made before phase 5):
	// reconstruct an entry from their version record so history is complete.
	for (const { image: img, version } of family) {
		if (seenResults.has(img.id)) continue;
		const isRoot = img.id === root;
		const opClass = isRoot ? "upload" : ((version?.opClass as OpClass | null) ?? OPERATION_CLASS[version?.operation ?? ""] ?? null);
		turns.push({
			id: `derived-${img.id}`,
			createdAt: img.createdAt.toISOString(),
			derived: true,
			request: {
				text: isRoot ? "Original photo" : (version?.prompt ?? version?.label ?? img.filenameLabel),
				opClass,
				bboxes: [],
				imageId: isRoot ? null : img.sourceImageId,
			},
			reply: { status: "done", text: "", error: null, credits: 0, refunded: false, result: resultOf(img.id) },
		});
	}

	turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return { rootImageId: root, turns };
}
