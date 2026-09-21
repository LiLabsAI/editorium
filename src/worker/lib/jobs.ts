import { eq, sql } from "drizzle-orm";

import { createDb } from "./db";
import { creditEvents, jobs, users } from "../../../database/schema";

export type JobType =
	| "segment"
	| "generate"
	| "enhance"
	| "inpaint"
	| "caption"
	| "thumb"
	| "batch_edit";

export const CREDIT_COSTS: Record<string, number> = {
	generate: 1,
	inpaint: 2,
	enhance: 3,
	segment: 0,
	caption: 0,
	thumb: 0,
};

export interface JobPayload {
	[key: string]: unknown;
}

export async function createJob(
	db: ReturnType<typeof createDb>,
	opts: {
		type: JobType;
		userId: string;
		imageId?: string;
		segmentId?: string;
		payload?: JobPayload;
	},
) {
	const id = crypto.randomUUID();
	await db.insert(jobs).values({
		id,
		type: opts.type,
		userId: opts.userId,
		imageId: opts.imageId,
		segmentId: opts.segmentId,
		payloadJson: opts.payload ? JSON.stringify(opts.payload) : null,
	});
	return id;
}

export async function enqueueJob(
	queue: Queue,
	jobId: string,
	type: JobType,
	payload: JobPayload,
): Promise<void> {
	await queue.send({ jobId, type, ...payload });
}

/** Atomically debit credits and append the ledger entry. */
export async function chargeCredits(
	db: ReturnType<typeof createDb>,
	userId: string,
	amount: number,
	reason: string,
	jobId: string,
): Promise<{ ok: boolean; balance: number }> {
	if (amount === 0) return { ok: true, balance: -1 };
	const [updated] = await db
		.update(users)
		.set({ creditBalance: sql`${users.creditBalance} - ${amount}` })
		.where(sql`${users.id} = ${userId} AND ${users.creditBalance} >= ${amount}`)
		.returning();
	if (!updated) {
		const [user] = await db.select().from(users).where(eq(users.id, userId));
		return { ok: false, balance: user?.creditBalance ?? 0 };
	}
	await db.insert(creditEvents).values({
		id: crypto.randomUUID(),
		userId,
		delta: -amount,
		reason,
		jobId,
	});
	return { ok: true, balance: updated.creditBalance };
}

export async function refundCredits(
	db: ReturnType<typeof createDb>,
	userId: string,
	amount: number,
	reason: string,
	jobId: string,
): Promise<void> {
	if (amount === 0) return;
	await db
		.update(users)
		.set({ creditBalance: sql`${users.creditBalance} + ${amount}` })
		.where(eq(users.id, userId));
	await db.insert(creditEvents).values({
		id: crypto.randomUUID(),
		userId,
		delta: amount,
		reason,
		jobId,
	});
}

export async function setJobProgress(
	db: ReturnType<typeof createDb>,
	jobId: string,
	progress: number,
	status: "queued" | "running" | "done" | "error" = "running",
): Promise<void> {
	await db
		.update(jobs)
		.set({ progress, status })
		.where(eq(jobs.id, jobId));
}

export async function finishJob(
	db: ReturnType<typeof createDb>,
	jobId: string,
	status: "done" | "error",
	error?: string,
): Promise<void> {
	await db
		.update(jobs)
		.set({
			status,
			error: error ?? null,
			progress: status === "done" ? 100 : undefined,
			finishedAt: new Date(),
		})
		.where(eq(jobs.id, jobId));
}
