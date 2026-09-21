import { eq } from "drizzle-orm";
import type { Context } from "hono";

import { projects, users, type User } from "../../../database/schema";
import { createDb } from "./db";

const COOKIE = "ed_session";
const MAX_AGE = 60 * 60 * 24 * 30;

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function sign(payload: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return toBase64Url(new Uint8Array(mac));
}

export async function makeSessionToken(userId: string, secret: string): Promise<string> {
	const payload = `${userId}.${Date.now()}`;
	return `${toBase64Url(new TextEncoder().encode(payload))}.${await sign(payload, secret)}`;
}

export async function readSessionToken(
	token: string | undefined,
	secret: string,
): Promise<string | null> {
	if (!token) return null;
	const [encoded, mac] = token.split(".");
	if (!encoded || !mac) return null;
	const payload = new TextDecoder().decode(fromBase64Url(encoded));
	const expected = await sign(payload, secret);
	if (expected.length !== mac.length) return null;
	// Constant-time-ish comparison over equal-length base64url strings.
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ mac.charCodeAt(i);
	if (diff !== 0) return null;
	const dot = payload.lastIndexOf(".");
	if (dot < 0) return null;
	const userId = payload.slice(0, dot);
	const ts = Number(payload.slice(dot + 1));
	if (!userId || !Number.isFinite(ts)) return null;
	if (Date.now() - ts > MAX_AGE * 1000) return null;
	return userId;
}

export function sessionCookie(token: string): string {
	return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearCookie(): string {
	return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readCookie(c: Context<{ Bindings: Env }>): string | undefined {
	return c.req
		.header("Cookie")
		?.split(";")
		.map((s) => s.trim())
		.find((s) => s.startsWith(`${COOKIE}=`))
		?.slice(COOKIE.length + 1);
}

/** Resolve the signed-in user, or null for anonymous requests. */
export async function getUser(c: Context<{ Bindings: Env }>): Promise<User | null> {
	const userId = await readSessionToken(readCookie(c), c.env.AUTH_SECRET);
	if (!userId) return null;
	const db = createDb(c.env.DB);
	const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	return user ?? null;
}

/** Require a signed-in user; throws a tagged error mapped to 401 by onError. */
export async function requireUser(
	c: Context<{ Bindings: Env }>,
): Promise<User> {
	const user = await getUser(c);
	if (!user) {
		const err = new Error("unauthorized") as Error & { status?: number };
		err.status = 401;
		throw err;
	}
	return user;
}

/** Create (or fetch) the user's default project. */
export async function ensureProject(
	c: Context<{ Bindings: Env }>,
	user: User,
) {
	const db = createDb(c.env.DB);
	const [existing] = await db
		.select()
		.from(projects)
		.where(eq(projects.ownerId, user.id))
		.limit(1);
	if (existing) return existing;
	const [project] = await db
		.insert(projects)
		.values({
			id: crypto.randomUUID(),
			ownerId: user.id,
			name: `${user.name.split(" ")[0]}'s Project`,
		})
		.returning();
	return project!;
}
