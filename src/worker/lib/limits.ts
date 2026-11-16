import { and, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";

import { aiRequests, jobs } from "../../../database/schema";
import { AI_CALLS_PER_MINUTE, AI_JOBS_PER_MINUTE } from "./config";
import { createDb } from "./db";
import { fail } from "./http";

/** Client IP for anonymous-route limiting. Only used where no user id exists
 * yet (guest creation, owner claim). */
export function clientIp(c: Context): string {
	return (
		c.req.header("CF-Connecting-IP") ??
		c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
		"missing-ip"
	);
}

/** Workers Rate Limiting binding check. The binding is per-location and
 * eventually consistent, so it is a cheap first line, not an accounting system. */
export async function allow(limiter: RateLimit | undefined, key: string): Promise<boolean> {
	if (!limiter) return true;
	const { success } = await limiter.limit({ key });
	return success;
}

/** Separate limiter for non-AI media & metadata mutations. */
export async function requireMediaQuota(env: Env, userId: string): Promise<void> {
	if (!(await allow(env.MEDIA_LIMITER, userId))) fail(429, "rate_limited");
}

/**
 * Gate every route that spends AI usage. Layer 1: the AI_LIMITER binding.
 * Layer 2: exact D1 counts of this user's jobs and non-job AI calls in the
 * last minute across ALL operations.
 */
export async function requireAiQuota(env: Env, userId: string): Promise<void> {
	if (!(await allow(env.AI_LIMITER, userId))) fail(429, "rate_limited");
	const db = createDb(env.DB);
	const since = new Date(Date.now() - 60_000);
	const [[jobRow], [callRow]] = await Promise.all([
		db
			.select({ count: sql<number>`COUNT(*)` })
			.from(jobs)
			.where(and(eq(jobs.userId, userId), gt(jobs.createdAt, since))),
		db
			.select({ count: sql<number>`COUNT(*)` })
			.from(aiRequests)
			.where(and(eq(aiRequests.userId, userId), gt(aiRequests.createdAt, since))),
	]);
	if ((jobRow?.count ?? 0) >= AI_JOBS_PER_MINUTE) fail(429, "rate_limited");
	if ((jobRow?.count ?? 0) + (callRow?.count ?? 0) >= AI_CALLS_PER_MINUTE) fail(429, "rate_limited");
}

/** Record a non-job AI call (chat answer, caption, prompt rewrite) for quota accounting. */
export async function recordAiRequest(env: Env, userId: string, kind: string): Promise<void> {
	const db = createDb(env.DB);
	await db.insert(aiRequests).values({ id: crypto.randomUUID(), userId, kind });
}
