import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { users } from "../../../database/schema";
import { clearCookie, createGuest, getUser, makeSessionToken, sessionCookie } from "../lib/auth";
import { safeEqual } from "../lib/crypto";
import { createDb } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { allow, clientIp } from "../lib/limits";

/**
 * Session bootstrap. Every browser gets its OWN private guest account — the
 * old /auth/demo handed every caller the most recent project owner's
 * session. The pre-auth demo account is recoverable only with the
 * OWNER_CLAIM_KEY secret.
 */
export const auth = new Hono<{ Bindings: Env }>();

auth.post("/guest", async (c) => {
	const existing = await getUser(c);
	if (existing) return c.json({ ok: true, userId: existing.id, created: false });
	if (!(await allow(c.env.AUTH_LIMITER, `guest:${clientIp(c)}`))) fail(429, "rate_limited");
	const user = await createGuest(c.env);
	c.header("Set-Cookie", sessionCookie(c, await makeSessionToken(user.id, c.env.AUTH_SECRET)));
	return c.json({ ok: true, userId: user.id, created: true }, 201);
});

auth.post("/claim", async (c) => {
	if (!(await allow(c.env.AUTH_LIMITER, `claim:${clientIp(c)}`))) fail(429, "rate_limited");
	const { key } = await readJson(c, z.object({ key: z.string().min(1).max(256) }));
	const expected = c.env.OWNER_CLAIM_KEY;
	const ownerId = c.env.OWNER_USER_ID;
	if (!expected || !ownerId || !(await safeEqual(key, expected))) fail(403, "invalid_key");
	const db = createDb(c.env.DB);
	await db.insert(users).values({ id: ownerId, name: "Owner" }).onConflictDoNothing();
	const [owner] = await db.select().from(users).where(eq(users.id, ownerId)).limit(1);
	if (!owner) fail(404, "owner_not_found");
	c.header("Set-Cookie", sessionCookie(c, await makeSessionToken(owner.id, c.env.AUTH_SECRET)));
	return c.json({ ok: true, userId: owner.id });
});

auth.post("/logout", (c) => {
	c.header("Set-Cookie", clearCookie(c));
	return c.json({ ok: true });
});
