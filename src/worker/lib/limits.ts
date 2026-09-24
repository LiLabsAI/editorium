import { and, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";

import { jobs } from "../../../database/schema";
import { AI_JOBS_PER_MINUTE } from "./config";
import { createDb } from "./db";
import { fail } from "./http";

/** Client IP for anonymous-route limiting. Only used where no user id exists
 * yet (guest creation, owner claim). */
export function clientIp(c: Context): string {
	return c.req.header("CF-Connecting-IP") ?? "unknown";
}

/** Workers Rate Limiting binding check. The binding is per-location and
 * eventually consistent, so it is a cheap first line, not an accounting system. */
export async function allow(limiter: RateLimit | undefined, key: string): Promise<boolean> {
	if (!limiter) return true;
	const { success } = await limiter.limit({ key });
	return success;
}

/**
 * Gate every route that spends AI usage. Layer 1: the AI_LIMITER binding.
 * Layer 2: an exact D1 count of this user's jobs in the last minute, across
 * ALL job types (the old check only counted three of them).
 */
export async function requireAiQuota(env: Env, userId: string): Promise<void> {
	if (!(await allow(env.AI_LIMITER, userId))) fail(429, "rate_limited");
	const db = createDb(env.DB);
	const since = new Date(Date.now() - 60_000);
	const [row] = await db
		.select({ count: sql<number>`COUNT(*)` })
		.from(jobs)
		.where(and(eq(jobs.userId, userId), gt(jobs.createdAt, since)));
	if ((row?.count ?? 0) >= AI_JOBS_PER_MINUTE) fail(429, "rate_limited");
}
