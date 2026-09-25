import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import {
	chatMessages,
	chatThreads,
	images,
	jobs,
	palettes,
	segments,
	type ImageRow,
	type User,
} from "../../database/schema";
import { createDb } from "./lib/db";
import { familyRoot, type OpClass } from "./lib/history";
import { chargeCredits, createJob, CREDIT_COSTS, enqueueJob } from "./lib/jobs";
import { loadModelInput } from "./lib/operations";
import { getProvider } from "./lib/providers";
import type { AiJobMessage } from "./queue";

/**
 * Chat agent (plan 6): classifies the user's request, narrates while the
 * matching AI operation runs, and links the produced image back into the
 * thread. Tool selection is a deterministic rule router (fast + testable);
 * the LLM shapes the conversational narration when a real provider is bound.
 *
 * SSE protocol: every frame is `data: {"event": E, "data": {...}}` where
 * token frames carry `{ value }`.
 */

export type AgentOperation = "answer" | "generate" | "enhance" | "edit" | "describe";

export interface AgentInput {
	threadId: string;
	albumId: string;
	user: User;
	text: string;
	/** Worker origin, needed for the signed URL the primary edit model fetches. */
	origin: string;
	/** Set when chatting from the editor: the photo family's history thread. */
	rootImageId?: string | null;
	attachedImageId?: string;
	segmentId?: string;
	mentionImageIds?: string[];
	paletteIds?: string[];
}

type JobKind = "generate" | "enhance" | "inpaint" | "caption" | "remove_bg";

export interface AgentDecision {
	operation: AgentOperation;
	targetImage: ImageRow | null;
	narration: string;
	job: { type: JobKind; prompt?: string; aspect?: string } | null;
}

const QUALITY_RE = /(4k|high[- ]?qualit|sharper|sharpen|resolution|upscale|professional camera|costly camera|better camera|clearer)/i;
const CREATE_RE = /(generate|create|make me|draw|design|produce) (an? |some )?(image|picture|photo|art|scene)/i;
const ADD_RE = /(add|put|place) (a|an|the|some)/i;
const BACKGROUND_RE = /(remove|delete|erase|cut out|get rid of)( the)? (background|backdrop|bg)|transparent background/i;
const DESCRIBE_RE = /(what|describe|explain|tell me about|what.s in) (this|the|that)? ?(image|photo|picture)?/i;

/** Chat generations use a fixed landscape aspect. */
export const CHAT_GENERATE_ASPECT = "4:3";

/**
 * Pick the image the request operates on: attachment, @mention, or the
 * album's latest. Explicit ids are honoured ONLY if they belong to this
 * thread's album (the thread's ownership is checked by the route), so a
 * caller can never target someone else's photo.
 */
export async function resolveTargetImage(
	env: Env,
	albumId: string,
	input: Pick<AgentInput, "attachedImageId" | "mentionImageIds">,
): Promise<ImageRow | null> {
	const db = createDb(env.DB);
	const explicit = input.attachedImageId ?? input.mentionImageIds?.[0];
	if (explicit) {
		const [row] = await db
			.select()
			.from(images)
			.where(and(eq(images.id, explicit), eq(images.albumId, albumId)))
			.limit(1);
		if (row) return row;
	}
	const [latest] = await db
		.select()
		.from(images)
		.where(eq(images.albumId, albumId))
		.orderBy(desc(images.createdAt))
		.limit(1);
	return latest ?? null;
}

export function decideOperation(text: string, target: ImageRow | null): AgentDecision {
	const wantsEnhance = QUALITY_RE.test(text);
	const wantsCreate = CREATE_RE.test(text) || (!target && ADD_RE.test(text));

	if (wantsCreate || (!target && text.trim().length > 0 && !DESCRIBE_RE.test(text))) {
		return {
			operation: "generate",
			targetImage: null,
			narration: "Generating a new image from your description.",
			job: { type: "generate", prompt: text, aspect: CHAT_GENERATE_ASPECT },
		};
	}
	if (BACKGROUND_RE.test(text) && target) {
		return {
			operation: "edit",
			targetImage: target,
			narration: "Removing the background — the subject stays exactly as it is.",
			job: { type: "remove_bg" },
		};
	}
	if (wantsEnhance && target) {
		return {
			operation: "enhance",
			targetImage: target,
			narration: "Enhancing detail and resolution — the photo itself stays the same.",
			job: { type: "enhance" },
		};
	}
	if (DESCRIBE_RE.test(text) && target) {
		return { operation: "describe", targetImage: target, narration: "", job: { type: "caption" } };
	}
	if (target && ADD_RE.test(text)) {
		return {
			operation: "edit",
			targetImage: target,
			narration: "Reimagining the photo with that change — AI may alter other details too.",
			job: { type: "inpaint", prompt: text },
		};
	}
	// Plain instruction + a target image: whole-photo edit (questions still
	// get answers).
	if (
		target &&
		text.trim().split(/\s+/).length >= 3 &&
		!/(\?|^(what|where|who|why|how|is|are|can|do|does)\b)/i.test(text.trim())
	) {
		return {
			operation: "edit",
			targetImage: target,
			narration: "Reimagining the photo with that change — AI may alter other details too.",
			job: { type: "inpaint", prompt: text },
		};
	}
	return { operation: "answer", targetImage: target, narration: "", job: null };
}

const SYSTEM_PROMPT =
	"You are Editorium's assistant inside an AI photo editor. Be brief and concrete. " +
	"You can generate images, enhance them, and edit photos or selected regions.";

/** Build the SSE-streamed response for one user message. */
export function streamAgentResponse(env: Env, input: AgentInput): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: string, data: Record<string, unknown>) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, data })}\n\n`));
			};
			const db = createDb(env.DB);
			try {
				const target = await resolveTargetImage(env, input.albumId, input);
				// A region only counts if it is a live segment of the target photo.
				const [segment] =
					input.segmentId && target
						? await db
								.select()
								.from(segments)
								.where(
									and(
										eq(segments.id, input.segmentId),
										eq(segments.imageId, target.id),
										isNull(segments.deletedAt),
									),
								)
								.limit(1)
						: [];
				const mentionIds = await ownedAlbumImageIds(env, input.albumId, input.mentionImageIds);
				const paletteIds = await ownedPaletteIds(env, input.user.id, input.paletteIds);

				let decision = decideOperation(input.text, target);
				if (segment && decision.operation !== "generate") {
					decision = {
						operation: "edit",
						targetImage: target,
						narration: `Applying that to the selected ${segment.label}.`,
						job: { type: "inpaint", prompt: input.text },
					};
				}

				const history = await recentHistory(env, input.threadId);
				// Phase 5: tag both sides of the turn so it appears in the photo
				// family's editor history (whichever thread it was sent from).
				const meta = {
					imageId: decision.targetImage?.id ?? null,
					rootImageId: input.rootImageId ?? (decision.targetImage ? familyRoot(decision.targetImage) : null),
					opClass: opClassOf(decision, !!segment),
				};
				const userMsgId = crypto.randomUUID();
				await db.insert(chatMessages).values({
					...meta,
					id: userMsgId,
					threadId: input.threadId,
					role: "user",
					text: input.text,
					attachedImageId: target && input.attachedImageId === target.id ? target.id : null,
					segmentId: segment?.id,
					bboxJson: segment
						? JSON.stringify([{ x: segment.bboxX, y: segment.bboxY, w: segment.bboxW, h: segment.bboxH }])
						: null,
					mentionImageIds: mentionIds.join(",") || null,
					attachedPaletteIds: paletteIds.join(",") || null,
				});
				await titleThread(env, input.threadId, input.text);

				const assistantId = crypto.randomUUID();
				const reply = { ...meta, id: assistantId, threadId: input.threadId, role: "assistant" as const, replyToId: userMsgId };

				if (decision.operation === "describe" && decision.targetImage) {
					const { bytes, mime } = await loadModelInput(env, decision.targetImage);
					const { caption } = await getProvider(env).captionRegion(bytes, mime, "scene", "in the frame");
					send("token", { value: caption });
					await db.insert(chatMessages).values({ ...reply, text: caption, operation: "describe" });
					send("done", { assistantId });
					return;
				}

				if (!decision.job || decision.job.type === "caption") {
					const collected = await streamTokens(
						env,
						[{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: input.text }],
						send,
					);
					await db.insert(chatMessages).values({ ...reply, text: collected.trim(), operation: "answer" });
					send("done", { assistantId });
					return;
				}

				// Metered operation: job row → atomic charge → assistant row → enqueue.
				const job = decision.job;
				const jobType = job.type as Exclude<JobKind, "caption">;
				const jobId = await createJob(db, {
					type: jobType,
					userId: input.user.id,
					imageId: decision.targetImage?.id,
					segmentId: segment?.id,
					payload: { prompt: job.prompt },
				});
				const charge = await chargeCredits(db, input.user.id, CREDIT_COSTS[jobType], jobType, jobId);
				if (!charge.ok) {
					await db.delete(jobs).where(eq(jobs.id, jobId));
					await db.insert(chatMessages).values({ ...reply, text: "You're out of credits.", operation: "answer" });
					send("error", { code: "insufficient_credits", balance: charge.balance });
					send("done", {});
					return;
				}
				await db.batch([
					db.update(chatMessages).set({ jobId }).where(eq(chatMessages.id, userMsgId)),
					db.insert(chatMessages).values({ ...reply, text: decision.narration, operation: decision.operation, jobId }),
				]);
				const message: AiJobMessage = {
					jobId,
					type: jobType,
					userId: input.user.id,
					albumId: input.albumId,
					imageId: decision.targetImage?.id,
					segmentId: segment?.id,
					prompt: job.prompt,
					aspect: job.aspect,
					origin: input.origin,
					chatMessageId: assistantId,
				};
				await enqueueJob(env.AI_JOBS, jobId, jobType, { ...message });

				send("token", { value: decision.narration });
				send("tool", { jobId, type: jobType, imageId: decision.targetImage?.id ?? null });
				send("done", { assistantId, jobId });
			} catch (error) {
				console.error(
					JSON.stringify({
						message: "agent_failure",
						error: error instanceof Error ? error.message : String(error),
						threadId: input.threadId,
					}),
				);
				send("error", { message: "Something went wrong. Please try again." });
			} finally {
				controller.close();
			}
		},
	});
}

function opClassOf(decision: AgentDecision, hasRegion: boolean): OpClass {
	switch (decision.job?.type) {
		case "generate":
			return "generate";
		case "enhance":
			return "enhance";
		case "remove_bg":
			return "segment";
		case "inpaint":
			return hasRegion ? "local" : "reimagine";
		default:
			return "answer";
	}
}

async function streamTokens(
	env: Env,
	messages: Array<{ role: string; content: string }>,
	send: (event: string, data: Record<string, unknown>) => void,
): Promise<string> {
	const reader = (await getProvider(env).streamChat(messages)).getReader();
	let collected = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		collected += value;
		send("token", { value });
	}
	return collected;
}

/** Last few turns so follow-up questions have context. */
async function recentHistory(env: Env, threadId: string): Promise<Array<{ role: string; content: string }>> {
	const db = createDb(env.DB);
	const rows = await db
		.select({ role: chatMessages.role, text: chatMessages.text })
		.from(chatMessages)
		.where(eq(chatMessages.threadId, threadId))
		.orderBy(desc(chatMessages.createdAt))
		.limit(10);
	return rows
		.reverse()
		.filter((r) => r.text.trim())
		.map((r) => ({ role: r.role, content: r.text }));
}

async function titleThread(env: Env, threadId: string, text: string): Promise<void> {
	const db = createDb(env.DB);
	await db
		.update(chatThreads)
		.set({ title: text.slice(0, 48) })
		.where(and(eq(chatThreads.id, threadId), eq(chatThreads.title, "New chat")));
}

async function ownedAlbumImageIds(env: Env, albumId: string, ids: string[] | undefined): Promise<string[]> {
	if (!ids?.length) return [];
	const db = createDb(env.DB);
	const rows = await db
		.select({ id: images.id })
		.from(images)
		.where(and(eq(images.albumId, albumId), inArray(images.id, ids.slice(0, 10))));
	return rows.map((r) => r.id);
}

async function ownedPaletteIds(env: Env, userId: string, ids: string[] | undefined): Promise<string[]> {
	if (!ids?.length) return [];
	const db = createDb(env.DB);
	const rows = await db
		.select({ id: palettes.id })
		.from(palettes)
		.where(and(eq(palettes.ownerId, userId), inArray(palettes.id, ids.slice(0, 10))));
	return rows.map((r) => r.id);
}
