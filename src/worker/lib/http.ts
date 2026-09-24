import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

/** Throw a JSON API error (`{ error: code }`) with the given status. */
export function fail(status: ContentfulStatusCode, code: string): never {
	throw new HTTPException(status, { message: code });
}

/**
 * Parse and validate a JSON body. Malformed JSON and schema mismatches become
 * 400s instead of unhandled 500s; an empty body parses as `{}` so routes with
 * all-optional fields accept a bodyless POST.
 */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
	const text = await c.req.text();
	let raw: unknown = {};
	if (text.trim()) {
		try {
			raw = JSON.parse(text);
		} catch {
			fail(400, "invalid_json");
		}
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) fail(400, "invalid_body");
	return parsed.data;
}

/** Reusable field schemas. */
export const unit = z.number().min(0).max(1);
export const bboxSchema = z.object({
	x: unit,
	y: unit,
	w: z.number().min(0.005).max(1),
	h: z.number().min(0.005).max(1),
});

/** Global error handler: HTTPExceptions keep their status, everything else is
 * a logged 500 that never leaks internals to the client. */
export const onError: ErrorHandler<{ Bindings: Env }> = (err, c) => {
	if (err instanceof HTTPException) {
		return c.json({ error: err.message || "error" }, err.status);
	}
	console.error(
		JSON.stringify({
			message: "unhandled_error",
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
			method: c.req.method,
			path: new URL(c.req.url).pathname,
		}),
	);
	return c.json({ error: "internal_error" }, 500);
};
