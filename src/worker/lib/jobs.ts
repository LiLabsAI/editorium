import { eq } from "drizzle-orm";

import { jobs, users } from "../../../database/schema";
import { createDb } from "./db";

export type JobType =
	| "segment"
	| "generate"
	| "enhance"
	| "inpaint"
	| "caption"
	| "thumb"
	| "batch_edit"
	| "remove_bg"
	| "outpaint";

/** The ONE credit price list. Charges and refunds both read it (previously
 * three diverging copies meant failed batch edits were never refunded). */
export const CREDIT_COSTS: Record<JobType, number> = {
	generate: 1,
	inpaint: 2,
	enhance: 3,
	batch_edit: 2,
	remove_bg: 1,
	outpaint: 2,
	segment: 0,
	caption: 0,
	thumb: 0,
};

export interface JobPayload {
	[key: string]: unknown;
}

type Db = ReturnType<typeof createDb>;

export async function createJob(
	db: Db,
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
	await queue.send({ ...payload, jobId, type });
}

/**
 * Atomically debit credits, append the ledger entry and record the charge on
 * the job — one D1 batch (a single transaction). The ledger insert and job
 * update only apply when the guarded debit actually changed a row
 * (`changes()` reports the previous statement in the batch).
 */
export async function chargeCredits(
	db: Db,
	userId: string,
	amount: number,
	reason: string,
	jobId: string,
): Promise<{ ok: boolean; balance: number }> {
	if (amount === 0) return { ok: true, balance: -1 };
	const d1 = db.$client;
	const [debit] = await d1.batch<{ credit_balance: number }>([
		d1
			.prepare(
				"UPDATE users SET credit_balance = credit_balance - ?1 WHERE id = ?2 AND credit_balance >= ?1 RETURNING credit_balance",
			)
			.bind(amount, userId),
		d1
			.prepare(
				"INSERT INTO credit_events (id, user_id, delta, reason, job_id) SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() > 0",
			)
			.bind(crypto.randomUUID(), userId, -amount, reason, jobId),
		d1.prepare("UPDATE jobs SET credits_charged = ?1 WHERE id = ?2 AND changes() > 0").bind(amount, jobId),
	]);
	const row = debit?.results?.[0];
	if (!row) {
		const [user] = await db.select().from(users).where(eq(users.id, userId));
		return { ok: false, balance: user?.creditBalance ?? 0 };
	}
	return { ok: true, balance: row.credit_balance };
}

/**
 * Refund exactly what this job was charged, at most once: zeroing
 * `credits_charged`, crediting the user and writing the ledger row happen in
 * one batch, each step guarded on the previous one, so a second refund
 * attempt (queue redelivery) is a no-op.
 */
export async function refundJob(db: Db, jobId: string): Promise<number> {
	const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
	const amount = job?.creditsCharged ?? 0;
	if (!job || amount <= 0) return 0;
	const d1 = db.$client;
	const [cleared] = await d1.batch([
		d1
			.prepare("UPDATE jobs SET credits_charged = 0 WHERE id = ?1 AND credits_charged = ?2 RETURNING id")
			.bind(jobId, amount),
		d1
			.prepare("UPDATE users SET credit_balance = credit_balance + ?1 WHERE id = ?2 AND changes() > 0")
			.bind(amount, job.userId),
		d1
			.prepare(
				"INSERT INTO credit_events (id, user_id, delta, reason, job_id) SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() > 0",
			)
			.bind(crypto.randomUUID(), job.userId, amount, `refund:${job.type}`, jobId),
	]);
	return cleared?.results?.length ? amount : 0;
}

export async function setJobProgress(
	db: Db,
	jobId: string,
	progress: number,
	status: "queued" | "running" | "done" | "error" = "running",
): Promise<void> {
	await db.update(jobs).set({ progress, status }).where(eq(jobs.id, jobId));
}

export async function finishJob(
	db: Db,
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
