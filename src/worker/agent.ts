import { desc, eq } from "drizzle-orm";

import {
	chatMessages,
	chatThreads,
	images,
	type ImageRow,
	type User,
} from "../../database/schema";
import { createDb } from "./lib/db";
import { chargeCredits, createJob, enqueueJob } from "./lib/jobs";
import { getProvider } from "./lib/providers";

/**
 * Chat agent (plan 6): classifies the user's request, narrates while the
 * matching AI operation runs, and links the produced image back into the
 * thread. Tool selection is a deterministic rule router (fast + testable);
 * the LLM shapes the conversational narration when a real provider is bound.
 */

export type AgentOperation = "answer" | "generate" | "enhance" | "edit" | "describe";

export interface AgentInput {
	threadId: string;
	albumId: string;
	user: User;
	text: string;
	attachedImageId?: string;
	segmentId?: string;
	mentionImageIds?: string[];
	paletteIds?: string[];
}

export interface AgentDecision {
	operation: AgentOperation;
	targetImage: ImageRow | null;
	narration: string;
	job: {
		type: "generate" | "enhance" | "inpaint" | "caption";
		prompt?: string;
		aspect?: string;
		strength?: number;
	} | null;
}

const QUALITY_RE = /(4k|high[- ]?qualit|sharper|sharpen|resolution|upscale|professional camera|costly camera|better camera|clearer)/i;
const CREATE_RE = /(generate|create|make me|draw|design|produce) (an? |some )?(image|picture|photo|art|scene)/i;
const ADD_RE = /(add|put|place) (a|an|the|some)/i;
const DESCRIBE_RE = /(what|describe|explain|tell me about|what.s in) (this|the|that)? ?(image|photo|picture)?/i;

/** Pick the image the request operates on: attachment, @mention, or latest. */
export async function resolveTargetImage(
	env: Env,
	albumId: string,
	input: AgentInput,
): Promise<ImageRow | null> {
	const db = createDb(env.DB);
	const explicit = input.attachedImageId ?? input.mentionImageIds?.[0];
	if (explicit) {
		const [row] = await db.select().from(images).where(eq(images.id, explicit)).limit(1);
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

export function decideOperation(
	text: string,
	target: ImageRow | null,
): AgentDecision {
	const wantsEnhance = QUALITY_RE.test(text);
	const wantsCreate = CREATE_RE.test(text) || (!target && ADD_RE.test(text));

	if (wantsCreate || (!target && text.trim().length > 0 && !DESCRIBE_RE.test(text))) {
		return {
			operation: "generate",
			targetImage: null,
			narration: "Generating a new image from your description.",
			job: { type: "generate", prompt: text, aspect: "4:3" },
		};
	}
	if (wantsEnhance && target) {
		return {
			operation: "enhance",
			targetImage: target,
			narration: "I'll enhance this into a crisp, high-quality photograph with the depth and clarity of a professional camera.",
			job: { type: "enhance", strength: 0.8 },
		};
	}
	if (DESCRIBE_RE.test(text) && target) {
		return {
			operation: "describe",
			targetImage: target,
			narration: "Looking at the image…",
			job: { type: "caption" },
		};
	}
	if (target && ADD_RE.test(text)) {
		return {
			operation: "edit",
			targetImage: target,
			narration: "Applying that change to the latest image.",
			job: { type: "inpaint", prompt: text, strength: 0.6 },
		};
	}
	// Plain instruction + a target image and no selected region: whole-photo
	// edit (questions still get answers).
	if (target && text.trim().split(/\s+/).length >= 3 && !/(\?|^(what|where|who|why|how|is|are|can|do|does)\b)/i.test(text.trim())) {
		return {
			operation: "edit",
			targetImage: target,
			narration: "Applying that change to the photo.",
			job: { type: "inpaint", prompt: text, strength: 0.6 },
		};
	}
	return {
		operation: "answer",
		targetImage: target,
		narration: "",
		job: null,
	};
}

/** Build the SSE-streamed response for one user message. */
export function streamAgentResponse(
	env: Env,
	input: AgentInput,
): ReadableStream {
	const encoder = new TextEncoder();
	return new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, data })}\n\n`));
			};
			try {
				const db = createDb(env.DB);
				const target = await resolveTargetImage(env, input.albumId, input);
				let decision = decideOperation(input.text, target);

				// A selected segment + an instruction = a region edit (plan 19):
				// chat becomes a second way to drive the plan-16 endpoint.
				if (input.segmentId && decision.operation !== "generate") {
					decision = {
						operation: "edit",
						targetImage: target,
						narration: `Applying that to the selected region.`,
						job: {
							type: "inpaint",
							prompt: input.text,
							strength: 0.6,
						},
					};
				}

				// Persist the user message.
				const userMsgId = crypto.randomUUID();
				await db.insert(chatMessages).values({
					id: userMsgId,
					threadId: input.threadId,
					role: "user",
					text: input.text,
					attachedImageId: input.attachedImageId,
					segmentId: input.segmentId,
					mentionImageIds: input.mentionImageIds?.join(","),
					attachedPaletteIds: input.paletteIds?.join(","),
				});

				const assistantId = crypto.randomUUID();
				let jobId: string | null = null;

				if (decision.job) {
					const costs: Record<string, number> = { generate: 1, inpaint: 2, enhance: 3, caption: 0 };
					jobId = await createJob(db, {
						type: decision.job.type,
						userId: input.user.id,
						imageId: decision.targetImage?.id,
						segmentId: decision.operation === "edit" ? input.segmentId : undefined,
						payload: { prompt: decision.job.prompt },
					});
					const charge = await chargeCredits(
						db,
						input.user.id,
						costs[decision.job.type] ?? 0,
						decision.job.type,
						jobId,
					);
					if (!charge.ok) {
						send("error", { code: "insufficient_credits", balance: charge.balance });
						send("done", {});
						controller.close();
						return;
					}
					// Create the assistant row now so the queue can attach results.
					await db.insert(chatMessages).values({
						id: assistantId,
						threadId: input.threadId,
						role: "assistant",
						text: "",
						operation: decision.operation,
						jobId,
					});

					if (decision.job.type === "generate") {
						await enqueueJob(env.AI_JOBS, jobId, "generate", {
							jobId,
							type: "generate",
							userId: input.user.id,
							prompt: decision.job.prompt,
							aspect: decision.job.aspect,
							chatMessageId: assistantId,
						});
					} else if (decision.job.type === "inpaint" && decision.targetImage && input.segmentId) {
						await enqueueJob(env.AI_JOBS, jobId, "inpaint", {
							jobId,
							type: "inpaint",
							userId: input.user.id,
							imageId: decision.targetImage.id,
							segmentId: input.segmentId,
							prompt: decision.job.prompt,
							mode: "balanced",
							chatMessageId: assistantId,
						});
					} else if (decision.job.type === "enhance" && decision.targetImage) {
						await enqueueJob(env.AI_JOBS, jobId, "enhance", {
							jobId,
							type: "enhance",
							userId: input.user.id,
							imageId: decision.targetImage.id,
							strength: decision.job.strength,
							chatMessageId: assistantId,
						});
					} else if (decision.job.type === "caption" && decision.targetImage) {
						// Inline: describe uses the provider directly (fast, cheap).
						const provider = getProvider(env);
						const { loadImageBytes } = await import("./lib/operations");
						const { bytes, mime } = await loadImageBytes(env, decision.targetImage);
						const { captionRegion } = describeViaProvider(provider);
						const { caption } = await captionRegion(bytes, mime, "scene", "in the frame");
						decision.narration = caption;
					}
				}

				// Stream the narration (assistant text) through the provider so a
				// real LLM can phrase it; mock streams word-by-word.
				const narration = decision.narration;
				if (decision.operation === "answer") {
					const provider = getProvider(env);
					const stream = await provider.streamChat([
						{
							role: "system",
							content:
								"You are Editorium's assistant inside an AI photo editor. Be brief and concrete. " +
								"You can generate images, enhance them, and edit recognized regions.",
						},
						{ role: "user", content: input.text },
					]);
					const reader = stream.getReader();
					let collected = "";
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						collected += value;
						const clean = value.replace(/\[job:[^\]]*\]/g, "");
						if (clean) send("token", clean);
					}
					await db.insert(chatMessages).values({
						id: assistantId,
						threadId: input.threadId,
						role: "assistant",
						text: collected.replace(/\[job:[^\]]*\]/g, "").trim(),
						operation: "answer",
					});
					send("done", { assistantId });
					controller.close();
					return;
				}

				// Operation flows: narrate, then emit tool + job events.
				const stream = await getProvider(env).streamChat([
					{ role: "system", content: "You are Editorium's assistant. Repeat the user's plan in one short friendly sentence. No preamble." },
					{ role: "user", content: narration },
				]);
				const reader = stream.getReader();
				let collected = "";
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					collected += value;
					send("token", value);
				}
				if (jobId) {
					send("tool", { jobId, type: decision.job?.type, imageId: decision.targetImage?.id });
					// If the job already finished (mock mode is fast), include the result.
					const [msg] = await db
						.select()
						.from(chatMessages)
						.where(eq(chatMessages.id, assistantId))
						.limit(1);
					send("result", {
						assistantId,
						jobId,
						imageId: msg?.resultImageId ?? null,
					});
				}
				await db
					.update(chatMessages)
					.set({ text: collected })
					.where(eq(chatMessages.id, assistantId));
				// Title the thread from the first exchange.
				const [thread] = await db
					.select()
					.from(chatThreads)
					.where(eq(chatThreads.id, input.threadId))
					.limit(1);
				if (thread && thread.title === "New chat") {
					await db
						.update(chatThreads)
						.set({ title: input.text.slice(0, 48) })
						.where(eq(chatThreads.id, input.threadId));
				}
				send("done", { assistantId, jobId });
				controller.close();
			} catch (error) {
				send("error", {
					message: error instanceof Error ? error.message : "Agent failure",
				});
				controller.close();
			}
		},
	});
}

function describeViaProvider(provider: ReturnType<typeof getProvider>) {
	return {
		captionRegion: provider.captionRegion.bind(provider),
	};
}
