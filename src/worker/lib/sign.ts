/** Short-lived signed URLs for images — lets external services (Pruna
 * P-Image family) fetch a photo without exposing the album. WebCrypto HMAC,
 * same scheme as lib/auth.ts sessions. */

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(payload: string, secret: string): Promise<string> {
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

export async function signPublicImageUrl(
	env: Env,
	imageId: string,
	ttlSeconds = 600,
): Promise<string> {
	const exp = Date.now() + ttlSeconds * 1000;
	const payload = `${imageId}.${exp}`;
	const mac = await hmac(payload, env.AUTH_SECRET);
	return `/api/pub/img/${payload}.${mac}`;
}

export async function verifyPublicImageUrl(
	env: Env,
	token: string,
): Promise<string | null> {
	const lastDot = token.lastIndexOf(".");
	if (lastDot < 0) return null;
	const payload = token.slice(0, lastDot);
	const mac = token.slice(lastDot + 1);
	const expected = await hmac(payload, env.AUTH_SECRET);
	if (expected.length !== mac.length) return null;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ mac.charCodeAt(i);
	if (diff !== 0) return null;
	const dot = payload.indexOf(".");
	if (dot < 0) return null;
	const imageId = payload.slice(0, dot);
	const exp = Number(payload.slice(dot + 1));
	if (!imageId || !Number.isFinite(exp) || Date.now() > exp) return null;
	return imageId;
}
