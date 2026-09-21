import { sql } from "drizzle-orm";
import { Hono } from "hono";

import { createDb } from "./lib/db";
import { api } from "./routes/api";
import { handleQueue, type AiJobMessage } from "./queue";
import { SegmentWorkflow } from "./workflows";

const app = new Hono<{ Bindings: Env }>();

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

async function queue(
	batch: MessageBatch<AiJobMessage>,
	env: Env,
): Promise<void> {
	return handleQueue(batch, env);
}

export default {
	fetch: app.fetch.bind(app),
	queue,
};

export { SegmentWorkflow };

export type { AiJobMessage };
