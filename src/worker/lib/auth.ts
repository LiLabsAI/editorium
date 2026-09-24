import { eq } from "drizzle-orm";
import type { Context } from "hono";

import { projects, users, type User } from "../../../database/schema";
import { SESSION_MAX_AGE_S } from "./config";
import { fromBase64Url, mac, safeEqual, toBase64Url } from "./crypto";
import { createDb } from "./db";
import { fail } from "./http";

const COOKIE = "ed_session";

type Ctx = Context<{ Bindings: Env }>;

export async function makeSessionToken(userId: string, secret: string): Promise<string> {
	const payload = `${userId}.${Date.now()}`;
	const encoded = toBase64Url(new TextEncoder().encode(payload));
	return `${encoded}.${await mac("session", payload, secret)}`;
}

export async function readSessionToken(
	token: string | undefined,
	secret: string,
): Promise<string | null> {
	if (!token) return null;
	const parts = token.split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	const bytes = fromBase64Url(parts[0]);
	if (!bytes) return null;
	const payload = new TextDecoder().decode(bytes);
	if (!safeEqual(await mac("session", payload, secret), parts[1])) return null;
	const dot = payload.lastIndexOf(".");
	if (dot <= 0) return null;
	const userId = payload.slice(0, dot);
	const issuedAt = Number(payload.slice(dot + 1));
	if (!Number.isFinite(issuedAt)) return null;
	const age = Date.now() - issuedAt;
	if (age < -60_000 || age > SESSION_MAX_AGE_S * 1000) return null;
	return userId;
}

function cookieFlags(c: Ctx, maxAge: number): string {
	const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
	return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function sessionCookie(c: Ctx, token: string): string {
	return `${COOKIE}=${token}; ${cookieFlags(c, SESSION_MAX_AGE_S)}`;
}

export function clearCookie(c: Ctx): string {
	return `${COOKIE}=; ${cookieFlags(c, 0)}`;
}

function readCookie(c: Ctx): string | undefined {
	return c.req
		.header("Cookie")
		?.split(";")
		.map((s) => s.trim())
		.find((s) => s.startsWith(`${COOKIE}=`))
		?.slice(COOKIE.length + 1);
}

/** Resolve the signed-in user, or null for anonymous requests. */
export async function getUser(c: Ctx): Promise<User | null> {
	const userId = await readSessionToken(readCookie(c), c.env.AUTH_SECRET);
	if (!userId) return null;
	const db = createDb(c.env.DB);
	const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	return user ?? null;
}

/** Require a signed-in user; anonymous requests get a 401 via onError. */
export async function requireUser(c: Ctx): Promise<User> {
	const user = await getUser(c);
	if (!user) fail(401, "unauthorized");
	return user;
}

/** Create a fresh, private guest account (never an existing one). */
export async function createGuest(env: Env): Promise<User> {
	const db = createDb(env.DB);
	const [user] = await db
		.insert(users)
		.values({ id: crypto.randomUUID(), name: "Guest" })
		.returning();
	return user!;
}

/** Create (or fetch) the user's default project. The unique index on
 * projects.owner_id makes concurrent first requests converge on one row. */
export async function ensureProject(c: Ctx, user: User) {
	const db = createDb(c.env.DB);
	const [existing] = await db
		.select()
		.from(projects)
		.where(eq(projects.ownerId, user.id))
		.limit(1);
	if (existing) return existing;
	await db
		.insert(projects)
		.values({
			id: crypto.randomUUID(),
			ownerId: user.id,
			name: `${user.name.split(" ")[0]}'s Project`,
		})
		.onConflictDoNothing({ target: projects.ownerId });
	const [project] = await db
		.select()
		.from(projects)
		.where(eq(projects.ownerId, user.id))
		.limit(1);
	return project!;
}
