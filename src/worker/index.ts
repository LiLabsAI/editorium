import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { createDb } from "./lib/db";
import { onError } from "./lib/http";
import { api } from "./routes/api";
import { UserEventsDO } from "./events";
import { handleQueue, type AiJobMessage } from "./queue";
import { SegmentWorkflow } from "./workflows";

const app = new Hono<{ Bindings: Env }>();

// Every API response: nosniff, frame-deny, same-origin resource policy, etc.
app.use("/api/*", secureHeaders({ xFrameOptions: "DENY" }));
app.onError(onError);

app.get("/api/", (c) => c.json({ name: "editorium" }));

app.get("/api/health", async (c) => {
	try {
		const database = createDb(c.env.DB);
		const result = await database.get<{ ok: number }>(sql`SELECT 1 AS ok`);
		if (result?.ok !== 1) {
			throw new Error("D1 health query returned an unexpected result");
		}
		return c.json({ status: "ok", database: "ok" });
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "D1 health check failed",
				error: error instanceof Error ? error.message : "Unknown error",
				route: "/api/health",
			}),
		);
		return c.json({ status: "degraded", database: "error" }, 503);
	}
});

app.route("/api", api);

export default {
	fetch: app.fetch.bind(app),
	queue: (batch: MessageBatch<AiJobMessage>, env: Env) => handleQueue(batch, env),
} satisfies ExportedHandler<Env, AiJobMessage>;

export { SegmentWorkflow, UserEventsDO };

export type { AiJobMessage };
