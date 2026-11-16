/** Short-lived signed URLs for images — lets external services (Pruna
 * P-Image family) fetch a photo without exposing the album. HMAC with the
 * "img" purpose, so these tokens can never be replayed as sessions. */

import { SIGNED_IMAGE_URL_TTL_S } from "./config";
import { mac, safeEqual } from "./crypto";

export async function signPublicImageUrl(
	env: Env,
	imageId: string,
	ttlSeconds = SIGNED_IMAGE_URL_TTL_S,
): Promise<string> {
	const exp = Date.now() + ttlSeconds * 1000;
	const payload = `${imageId}.${exp}`;
	return `/api/pub/img/${payload}.${await mac("img", payload, env.AUTH_SECRET)}`;
}

export async function verifyPublicImageUrl(
	env: Env,
	token: string,
): Promise<string | null> {
	const lastDot = token.lastIndexOf(".");
	if (lastDot < 0) return null;
	const payload = token.slice(0, lastDot);
	if (!(await safeEqual(await mac("img", payload, env.AUTH_SECRET), token.slice(lastDot + 1)))) {
		return null;
	}
	const dot = payload.indexOf(".");
	if (dot <= 0) return null;
	const imageId = payload.slice(0, dot);
	const exp = Number(payload.slice(dot + 1));
	if (!Number.isFinite(exp) || Date.now() > exp) return null;
	return imageId;
}
