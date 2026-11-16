import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
	chatMessages,
	chatThreads,
	images,
	jobs,
	palettes,
	projects,
	references,
	segments,
	type ImageRow,
	type Segment,
	type User,
} from "../../database/schema";
import { notifyUserEvent } from "./events";
import { MAX_HISTORY_MESSAGES, WORKING_MAX_PX } from "./lib/config";
import { createDb } from "./lib/db";
import { familyRoot, friendlyError, type OpClass } from "./lib/history";
import { chargeCredits, createJob, CREDIT_COSTS, enqueueJob, finishJob, refundJob, type JobType } from "./lib/jobs";
import { recordAiRequest } from "./lib/limits";
import { loadModelInput } from "./lib/operations";
import { getProvider } from "./lib/providers";
import type { AiJobMessage } from "./queue";
import type { OutpaintPad } from "./workflows";

/**
 * Chat agent (plan 6): classifies the user's request via a 2-tier router
 * (fast deterministic rules -> LLM JSON-schema intent classification), narrates
 * while the matching AI operation runs, and links the produced image back.
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

type AgentJobKind = "generate" | "enhance" | "inpaint" | "caption" | "remove_bg" | "outpaint";

export interface AgentDecision {
	operation: AgentOperation;
	targetImage: ImageRow | null;
	targetSegmentId?: string;
	narration: string;
	lockedNotice?: string;
	job: { type: AgentJobKind; prompt?: string; aspect?: string; pad?: OutpaintPad } | null;
}

const QUALITY_RE = /(4k|high[- ]?qualit|sharper|sharpen|resolution|upscale|professional camera|costly camera|better camera|clearer)/i;
const CREATE_RE = /(generate|create|make me|draw|design|produce) (an? |some )?(image|picture|photo|art|scene)/i;
const ADD_RE = /(add|put|place) (a|an|the|some)/i;
const BACKGROUND_RE = /(remove|delete|erase|cut out|get rid of)( the)? (background|backdrop|bg)|transparent background/i;
const DESCRIBE_RE = /(what|describe|explain|tell me about|what.s in) (this|the|that)? ?(image|photo|picture)?/i;
const OUTPAINT_RE = /^(outpaint|uncrop|extend|expand|widen)( the)? (image|photo|canvas|border|edges|frame|top|bottom|left|right)?/i;
const QUESTION_RE = /(\?|^(what|where|who|why|how|is|are|can|do|does|could|should)\b)/i;

/** Chat generations use a fixed landscape aspect. */
export const CHAT_GENERATE_ASPECT = "4:3";

/**
 * Pick the image the request operates on: attachment, @mention (strictly within
 * `rootImageId` family when inside an editor thread), or the latest photo.
 */
export async function resolveTargetImage(
	env: Env,
	albumId: string,
	input: Pick<AgentInput, "attachedImageId" | "mentionImageIds" | "rootImageId">,
): Promise<ImageRow | null> {
	const db = createDb(env.DB);
	const familyFilter = input.rootImageId ? eq(images.rootImageId, input.rootImageId) : undefined;

	if (input.attachedImageId) {
		const [row] = await db
			.select()
			.from(images)
			.where(and(eq(images.id, input.attachedImageId), eq(images.albumId, albumId), familyFilter))
			.limit(1);
		if (row) return row;
	}
	if (!input.rootImageId && input.mentionImageIds?.[0]) {
		const [row] = await db
			.select()
			.from(images)
			.where(and(eq(images.id, input.mentionImageIds[0]), eq(images.albumId, albumId)))
			.limit(1);
		if (row) return row;
	}
	const [latest] = await db
		.select()
		.from(images)
		.where(and(eq(images.albumId, albumId), familyFilter))
		.orderBy(desc(images.createdAt))
		.limit(1);
	return latest ?? null;
}

function defaultOutpaintPad(target: ImageRow, text: string): OutpaintPad {
	const w = target.widthPx || 1024;
	const h = target.heightPx || 1024;
	const maxAddW = Math.max(0, WORKING_MAX_PX - w);
	const maxAddH = Math.max(0, WORKING_MAX_PX - h);
	const dx = Math.min(Math.round(w * 0.25), Math.floor(maxAddW / 2));
	const dy = Math.min(Math.round(h * 0.25), Math.floor(maxAddH / 2));
	const lower = text.toLowerCase();
	const hasDir = /\b(left|right|top|up|bottom|down|wider|taller)\b/.test(lower);
	if (!hasDir) return { left: dx, right: dx, top: dy, bottom: dy };
	return {
		left: /\b(left|wider)\b/.test(lower) ? dx : 0,
		right: /\b(right|wider)\b/.test(lower) ? dx : 0,
		top: /\b(top|up|taller)\b/.test(lower) ? dy : 0,
		bottom: /\b(bottom|down|taller)\b/.test(lower) ? dy : 0,
	};
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
	if (OUTPAINT_RE.test(text.trim()) && target) {
		return {
			operation: "edit",
			targetImage: target,
			narration: "Extending the canvas outward while keeping the original photo intact.",
			job: { type: "outpaint", prompt: text, pad: defaultOutpaintPad(target, text) },
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
	if (target && text.trim().split(/\s+/).length >= 3 && !QUESTION_RE.test(text.trim())) {
		return {
			operation: "edit",
			targetImage: target,
			narration: "Reimagining the photo with that change — AI may alter other details too.",
			job: { type: "inpaint", prompt: text },
		};
	}
	return { operation: "answer", targetImage: target, narration: "", job: null };
}

/**
 * 2-tier intent router: deterministic regex/fast-path first, falling back to
 * LLM structured intent classification for ambiguous phrasing when a target exists.
 */
async function resolveAgentDecision(
	env: Env,
	text: string,
	target: ImageRow | null,
	selectedSegment: Segment | undefined,
	liveSegments: Segment[],
): Promise<AgentDecision> {
	if (selectedSegment) {
		if (DESCRIBE_RE.test(text) && !/\b(change|make|turn|replace|remove|erase)\b/i.test(text)) {
			return {
				operation: "describe",
				targetImage: target,
				targetSegmentId: selectedSegment.id,
				narration: "",
				job: { type: "caption" },
			};
		}
		if (selectedSegment.lockedAt) {
			return {
				operation: "answer",
				targetImage: target,
				narration: "",
				lockedNotice: `The "${selectedSegment.label}" layer is locked. Unlock it in the Layers drawer to edit it.`,
				job: null,
			};
		}
		if (!QUESTION_RE.test(text.trim()) || /\b(change|make|turn|replace|remove|erase|recolor)\b/i.test(text)) {
			return {
				operation: "edit",
				targetImage: target,
				targetSegmentId: selectedSegment.id,
				narration: `Applying that to the selected ${selectedSegment.label}.`,
				job: { type: "inpaint", prompt: text },
			};
		}
	}

	// Tier 1 deterministic matches take priority so clear intents never wait for an extra LLM call.
	if (
		CREATE_RE.test(text) ||
		!target ||
		BACKGROUND_RE.test(text) ||
		OUTPAINT_RE.test(text.trim()) ||
		QUALITY_RE.test(text) ||
		DESCRIBE_RE.test(text)
	) {
		return decideOperation(text, target);
	}

	// Tier 2: structured LLM intent classifier for ambiguous natural language.
	const provider = getProvider(env);
	if (provider.classifyIntent) {
		try {
			const cls = await provider.classifyIntent(text, {
				hasTarget: !!target,
				segmentLabels: liveSegments.map((s) => s.label),
			});
			if (cls) {
				const promptText = cls.clarifiedPrompt?.trim() || text;
				switch (cls.intent) {
					case "generate":
						return {
							operation: "generate",
							targetImage: null,
							narration: "Generating a new image from your description.",
							job: { type: "generate", prompt: promptText, aspect: cls.aspect ?? CHAT_GENERATE_ASPECT },
						};
					case "enhance":
						return {
							operation: "enhance",
							targetImage: target,
							narration: "Enhancing detail and resolution — the photo itself stays the same.",
							job: { type: "enhance" },
						};
					case "remove_bg":
						return {
							operation: "edit",
							targetImage: target,
							narration: "Removing the background — the subject stays exactly as it is.",
							job: { type: "remove_bg" },
						};
					case "outpaint":
						return {
							operation: "edit",
							targetImage: target,
							narration: "Extending the canvas outward while keeping the original photo intact.",
							job: { type: "outpaint", prompt: promptText, pad: defaultOutpaintPad(target, text) },
						};
					case "describe":
						return { operation: "describe", targetImage: target, narration: "", job: { type: "caption" } };
					case "answer":
						return { operation: "answer", targetImage: target, narration: "", job: null };
					case "edit_region":
					case "remove_object": {
						const objName = cls.targetObject?.toLowerCase().trim();
						const match = objName
							? liveSegments.find(
									(s) =>
										s.label.toLowerCase().includes(objName) ||
										objName.includes(s.label.toLowerCase()),
								)
							: undefined;
						if (match?.lockedAt) {
							return {
								operation: "answer",
								targetImage: target,
								narration: "",
								lockedNotice: `The "${match.label}" layer is locked. Unlock it in the Layers drawer to edit it.`,
								job: null,
							};
						}
						return {
							operation: "edit",
							targetImage: target,
							targetSegmentId: match?.id,
							narration: match
								? `Updating the ${match.label} — the rest of your photo stays intact.`
								: "Applying that edit to your photo.",
							job: { type: "inpaint", prompt: promptText },
						};
					}
					case "reimagine":
						return {
							operation: "edit",
							targetImage: target,
							narration: "Reimagining the photo with that change — AI may alter other details too.",
							job: { type: "inpaint", prompt: promptText },
						};
				}
			}
		} catch {
			// Fall back cleanly to rule router if Tier 2 classification fails.
		}
	}

	return decideOperation(text, target);
}

const SYSTEM_PROMPT =
	"You are Editorium's assistant inside an AI photo editor. Be brief and concrete. " +
	"You can generate images, enhance them, extend borders, remove backgrounds, and edit photos or selected regions.";

/** Build the SSE-streamed response for one user message. */
export function streamAgentResponse(env: Env, input: AgentInput): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let cancelled = false;
	return new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
		async start(controller) {
			const send = (event: string, data: Record<string, unknown>) => {
				if (cancelled) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, data })}\n\n`));
				} catch {
					cancelled = true;
				}
			};
			const db = createDb(env.DB);
			try {
				const target = await resolveTargetImage(env, input.albumId, input);
				const liveSegments = target
					? await db
							.select()
							.from(segments)
							.where(and(eq(segments.imageId, target.id), isNull(segments.deletedAt)))
					: [];
				const segment = input.segmentId
					? liveSegments.find((s) => s.id === input.segmentId)
					: undefined;

				const [mentionImgIds, refLibIds, attachedPalettes] = await Promise.all([
					ownedAlbumImageIds(env, input.albumId, input.mentionImageIds),
					ownedReferenceIds(env, input.user.id, input.mentionImageIds),
					ownedPaletteDetails(env, input.user.id, input.paletteIds),
				]);
				const allReferenceIds = [...new Set([...mentionImgIds, ...refLibIds])];
				const paletteIds = attachedPalettes.map((p) => p.id);

				const decision = await resolveAgentDecision(env, input.text, target, segment, liveSegments);
				const targetSegId = decision.targetSegmentId ?? segment?.id;
				const activeSegment = targetSegId ? liveSegments.find((s) => s.id === targetSegId) : undefined;

				const history = await recentHistory(env, input.threadId);
				const meta = {
					imageId: decision.targetImage?.id ?? null,
					rootImageId: input.rootImageId ?? (decision.targetImage ? familyRoot(decision.targetImage) : null),
					opClass: opClassOf(decision, !!activeSegment),
				};
				const userMsgId = crypto.randomUUID();
				await db.insert(chatMessages).values({
					...meta,
					id: userMsgId,
					threadId: input.threadId,
					role: "user",
					text: input.text,
					attachedImageId: target && input.attachedImageId === target.id ? target.id : null,
					segmentId: activeSegment?.id,
					bboxJson: activeSegment
						? JSON.stringify([{ x: activeSegment.bboxX, y: activeSegment.bboxY, w: activeSegment.bboxW, h: activeSegment.bboxH }])
						: null,
					mentionImageIds: allReferenceIds.join(",") || null,
					attachedPaletteIds: paletteIds.join(",") || null,
				});
				await titleThread(env, input.threadId, input.text);

				const assistantId = crypto.randomUUID();
				const reply = { ...meta, id: assistantId, threadId: input.threadId, role: "assistant" as const, replyToId: userMsgId };

				if (decision.lockedNotice) {
					send("token", { value: decision.lockedNotice });
					await db.insert(chatMessages).values({ ...reply, text: decision.lockedNotice, operation: "answer" });
					send("done", { assistantId });
					return;
				}

				if (decision.operation === "describe" && decision.targetImage) {
					try {
						const { bytes, mime } = await loadModelInput(env, decision.targetImage);
						await recordAiRequest(env, input.user.id, "describe");
						const { caption } = await getProvider(env).captionRegion(
							bytes,
							mime,
							activeSegment?.label ?? "scene",
							"in the frame",
							input.text,
						);
						send("token", { value: caption });
						await db.insert(chatMessages).values({ ...reply, text: caption, operation: "describe" });
						send("done", { assistantId });
					} catch (err) {
						const errMsg = friendlyError(err instanceof Error ? err.message : null);
						await db.insert(chatMessages).values({ ...reply, text: errMsg, operation: "describe" });
						send("error", { message: errMsg });
					}
					return;
				}

				if (!decision.job || decision.job.type === "caption") {
					const sysExtras: string[] = [];
					if (target) {
						const labels = liveSegments.filter((s) => !s.hiddenAt).map((s) => s.label);
						sysExtras.push(
							`Current photo: ${target.widthPx}×${target.heightPx}px${labels.length ? `, detected regions: ${labels.slice(0, 12).join(", ")}` : ""}.`,
						);
					}
					if (attachedPalettes.length) {
						sysExtras.push(`Attached color palettes: ${attachedPalettes.map((p) => p.colors.join(", ")).join(" | ")}.`);
					}
					try {
						await recordAiRequest(env, input.user.id, "answer");
						const collected = await streamTokens(
							env,
							[
								{ role: "system", content: [SYSTEM_PROMPT, ...sysExtras].join(" ") },
								...history,
								{ role: "user", content: input.text },
							],
							send,
							() => cancelled,
						);
						const textOut = collected.trim() || "I couldn't generate a response for that.";
						await db.insert(chatMessages).values({ ...reply, text: textOut, operation: "answer" });
						send("done", { assistantId });
					} catch (err) {
						const errMsg = friendlyError(err instanceof Error ? err.message : null);
						await db.insert(chatMessages).values({ ...reply, text: errMsg, operation: "answer" });
						send("error", { message: errMsg });
					}
					return;
				}

				// Inject palette hex instructions if palettes were attached to this request.
				const paletteSuffix = attachedPalettes.length
					? ` Match these palette colors: ${attachedPalettes.flatMap((p) => p.colors).slice(0, 10).join(", ")}.`
					: "";
				const finalPrompt = decision.job.prompt ? `${decision.job.prompt}${paletteSuffix}` : undefined;

				// Metered operation: job row -> atomic charge -> assistant row -> enqueue.
				const job = decision.job;
				const jobType = job.type as Exclude<JobType, "caption" | "segment" | "thumb">;
				const jobId = await createJob(db, {
					type: jobType,
					userId: input.user.id,
					imageId: decision.targetImage?.id,
					segmentId: activeSegment?.id,
					payload: { prompt: finalPrompt, pad: job.pad },
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
					segmentId: activeSegment?.id,
					prompt: finalPrompt,
					aspect: job.aspect,
					pad: job.pad,
					referenceImageIds: allReferenceIds.length ? allReferenceIds : undefined,
					origin: input.origin,
					chatMessageId: assistantId,
				};
				try {
					await enqueueJob(env.AI_JOBS, jobId, jobType, { ...message });
				} catch (err) {
					await refundJob(db, jobId);
					await finishJob(db, jobId, "error", err instanceof Error ? err.message : "Failed to queue job");
					send("error", { message: "Could not start the AI job. Your credits were refunded." });
					return;
				}
				await notifyUserEvent(env, input.user.id, {
					jobId,
					jobType,
					status: "queued",
					progress: 0,
					imageId: decision.targetImage?.id ?? null,
				});

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
				try {
					controller.close();
				} catch {
					// Stream already closed by client abort.
				}
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
		case "outpaint":
			return "outpaint";
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
	isCancelled: () => boolean,
): Promise<string> {
	const reader = (await getProvider(env).streamChat(messages)).getReader();
	let collected = "";
	for (;;) {
		if (isCancelled()) {
			await reader.cancel().catch(() => {});
			break;
		}
		const { done, value } = await reader.read();
		if (done) break;
		collected += value;
		send("token", { value });
	}
	return collected;
}

/** Last few alternating turns so follow-up questions have clean conversation context. */
async function recentHistory(env: Env, threadId: string): Promise<Array<{ role: string; content: string }>> {
	const db = createDb(env.DB);
	const rows = await db
		.select({ role: chatMessages.role, text: chatMessages.text })
		.from(chatMessages)
		.where(eq(chatMessages.threadId, threadId))
		.orderBy(desc(chatMessages.createdAt), desc(sql`"chat_messages"."rowid"`))
		.limit(MAX_HISTORY_MESSAGES * 2);
	const ordered = rows.reverse().filter((r) => r.text.trim());
	const alternating: Array<{ role: string; content: string }> = [];
	for (const r of ordered) {
		const prev = alternating[alternating.length - 1];
		if (prev && prev.role === r.role) {
			prev.content = `${prev.content}\n\n${r.text}`;
		} else {
			alternating.push({ role: r.role, content: r.text });
		}
	}
	return alternating.slice(-MAX_HISTORY_MESSAGES);
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

async function ownedReferenceIds(env: Env, userId: string, ids: string[] | undefined): Promise<string[]> {
	if (!ids?.length) return [];
	const db = createDb(env.DB);
	const rows = await db
		.select({ id: references.id })
		.from(references)
		.innerJoin(projects, eq(projects.id, references.projectId))
		.where(and(eq(projects.ownerId, userId), inArray(references.id, ids.slice(0, 10))));
	return rows.map((r) => r.id);
}

async function ownedPaletteDetails(
	env: Env,
	userId: string,
	ids: string[] | undefined,
): Promise<Array<{ id: string; colors: string[] }>> {
	if (!ids?.length) return [];
	const db = createDb(env.DB);
	const rows = await db
		.select({ id: palettes.id, colorsJson: palettes.colorsJson })
		.from(palettes)
		.where(and(eq(palettes.ownerId, userId), inArray(palettes.id, ids.slice(0, 10))));
	return rows.map((r) => {
		try {
			const parsed = JSON.parse(r.colorsJson) as unknown;
			return { id: r.id, colors: Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [] };
		} catch {
			return { id: r.id, colors: [] };
		}
	});
}
