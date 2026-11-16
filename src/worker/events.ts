import { DurableObject } from "cloudflare:workers";

export type JobEventStatus = "queued" | "running" | "done" | "error";

export interface UserJobEvent {
	jobId: string;
	jobType?: string;
	status: JobEventStatus;
	progress: number;
	attempt?: number;
	imageId?: string | null;
	resultImageId?: string | null;
	error?: string | null;
	segmentStatus?: "none" | "pending" | "partial" | "ready" | "failed";
	ts: number;
}

function rankOf(status: JobEventStatus): number {
	if (status === "queued") return 0;
	if (status === "running") return 1;
	return 2;
}

type StoredRow = {
	[key: string]: SqlStorageValue;
	job_id: string;
	job_type: string | null;
	status: string;
	status_rank: number;
	progress: number;
	attempt: number;
	image_id: string | null;
	result_image_id: string | null;
	error: string | null;
	segment_status: string | null;
	updated_at: number;
};

/**
 * Per-user real-time event hub using the Durable Object WebSocket Hibernation
 * API (0 duration billing while idle) + SQLite state for monotonic delivery
 * across queue retries.
 */
export class UserEventsDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS job_events (
					job_id TEXT PRIMARY KEY,
					job_type TEXT,
					status TEXT NOT NULL,
					status_rank INTEGER NOT NULL,
					progress INTEGER NOT NULL,
					attempt INTEGER NOT NULL DEFAULT 0,
					image_id TEXT,
					result_image_id TEXT,
					error TEXT,
					segment_status TEXT,
					updated_at INTEGER NOT NULL
				)
			`);
		});
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket upgrade", { status: 426 });
		}
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ connectedAt: Date.now() });

		// Replay recent updates so a reconnecting tab doesn't miss fast jobs.
		const cutoff = Date.now() - 120_000;
		const recent = this.ctx.storage.sql
			.exec<StoredRow>("SELECT * FROM job_events WHERE updated_at >= ? ORDER BY updated_at ASC", cutoff)
			.toArray();
		for (const row of recent) {
			try {
				server.send(
					JSON.stringify({
						type: "job_event",
						jobId: row.job_id,
						jobType: row.job_type ?? undefined,
						status: row.status as JobEventStatus,
						progress: row.progress,
						attempt: row.attempt,
						imageId: row.image_id,
						resultImageId: row.result_image_id,
						error: row.error,
						segmentStatus: (row.segment_status as UserJobEvent["segmentStatus"] | null) ?? undefined,
						ts: row.updated_at,
					}),
				);
			} catch {
				// Ignore closing socket during handshake.
			}
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	async pushEvent(event: UserJobEvent): Promise<void> {
		const rank = rankOf(event.status);
		const attempt = event.attempt ?? 0;
		const existing = this.ctx.storage.sql
			.exec<StoredRow>("SELECT * FROM job_events WHERE job_id = ? LIMIT 1", event.jobId)
			.toArray()[0];

		if (existing) {
			if (rank < existing.status_rank) return;
			if (rank === existing.status_rank && rank === 2) return; // terminal already reached
			if (
				rank === existing.status_rank &&
				attempt === existing.attempt &&
				event.progress < existing.progress &&
				event.ts <= existing.updated_at
			) {
				return;
			}
		}

		this.ctx.storage.sql.exec(
			`INSERT INTO job_events (
				job_id, job_type, status, status_rank, progress, attempt,
				image_id, result_image_id, error, segment_status, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(job_id) DO UPDATE SET
				job_type = COALESCE(excluded.job_type, job_events.job_type),
				status = excluded.status,
				status_rank = excluded.status_rank,
				progress = excluded.progress,
				attempt = excluded.attempt,
				image_id = COALESCE(excluded.image_id, job_events.image_id),
				result_image_id = COALESCE(excluded.result_image_id, job_events.result_image_id),
				error = excluded.error,
				segment_status = COALESCE(excluded.segment_status, job_events.segment_status),
				updated_at = excluded.updated_at`,
			event.jobId,
			event.jobType ?? null,
			event.status,
			rank,
			event.progress,
			attempt,
			event.imageId ?? null,
			event.resultImageId ?? null,
			event.error ?? null,
			event.segmentStatus ?? null,
			event.ts,
		);
		this.ctx.storage.sql.exec("DELETE FROM job_events WHERE updated_at < ?", Date.now() - 3_600_000);

		const payload = JSON.stringify({ type: "job_event", ...event });
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(payload);
			} catch {
				try {
					ws.close(1011, "send failed");
				} catch {
					// Already closed.
				}
			}
		}
	}

	override webSocketMessage(): void {
		// Application ping/pong is handled by setWebSocketAutoResponse.
	}

	override webSocketClose(ws: WebSocket, code: number, reason: string): void {
		try {
			ws.close(code, reason);
		} catch {
			// Already closed.
		}
	}

	override webSocketError(ws: WebSocket): void {
		try {
			ws.close(1011, "socket error");
		} catch {
			// Already closed.
		}
	}
}

/** Best-effort push to the user's event hub; never fails a job or request. */
export async function notifyUserEvent(env: Env, userId: string, event: Omit<UserJobEvent, "ts">): Promise<void> {
	if (!env.USER_EVENTS) return;
	try {
		const stub = env.USER_EVENTS.getByName(userId);
		await stub.pushEvent({ ...event, ts: Date.now() });
	} catch {
		// Realtime push is an optimization; HTTP polling/history sync backs it up.
	}
}
