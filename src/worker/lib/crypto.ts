/** WebCrypto helpers shared by sessions (lib/auth.ts) and signed image URLs
 * (lib/sign.ts). Every MAC is domain-separated by a purpose prefix so a token
 * minted for one purpose can never verify as another. */

export type MacPurpose = "session" | "img";

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	try {
		const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

function requireSecret(secret: string | undefined): string {
	// A missing or placeholder secret must fail loudly, never sign with "undefined".
	if (!secret || secret.length < 32) {
		throw new Error("AUTH_SECRET is missing or too short (need >= 32 chars)");
	}
	return secret;
}

export async function mac(purpose: MacPurpose, payload: string, secret: string | undefined): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(requireSecret(secret)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}:${payload}`));
	return toBase64Url(new Uint8Array(sig));
}

/** Constant-time string comparison (hashes both inputs first to avoid length leaks). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}
