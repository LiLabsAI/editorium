/**
 * Real-time job & segment event client backed by `UserEventsDO` WebSocket
 * Hibernation (`/api/events`), with monotonic dedupe and graceful polling
 * fallback when offline or in environments without WebSockets.
 */

export type JobEventStatus = "queued" | "running" | "done" | "error";

export interface JobRealtimeEvent {
	type: "job_event";
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

type Listener = (ev: JobRealtimeEvent) => void;

const RANK: Record<JobEventStatus, number> = {
	queued: 0,
	running: 1,
	done: 2,
	error: 2,
};

class JobEventClient {
	private ws: WebSocket | null = null;
	private connected = false;
	private enabled = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private retryDelay = 1000;
	private latestByJob = new Map<string, JobRealtimeEvent>();
	private anyListeners = new Set<Listener>();
	private jobListeners = new Map<string, Set<Listener>>();

	start(): void {
		this.enabled = true;
		if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
		this.connect();
	}

	stop(): void {
		this.enabled = false;
		this.connected = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
		if (this.ws) {
			try {
				this.ws.close(1000, "client stop");
			} catch {
				// Ignore close errors.
			}
			this.ws = null;
		}
	}

	isConnected(): boolean {
		return this.connected && this.ws?.readyState === WebSocket.OPEN;
	}

	getLatest(jobId: string): JobRealtimeEvent | undefined {
		return this.latestByJob.get(jobId);
	}

	subscribe(listener: Listener): () => void {
		this.anyListeners.add(listener);
		return () => {
			this.anyListeners.delete(listener);
		};
	}

	subscribeJob(jobId: string, listener: Listener): () => void {
		const cached = this.latestByJob.get(jobId);
		if (cached) listener(cached);
		let set = this.jobListeners.get(jobId);
		if (!set) {
			set = new Set();
			this.jobListeners.set(jobId, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.jobListeners.delete(jobId);
		};
	}

	private connect(): void {
		if (!this.enabled || typeof window === "undefined") return;
		const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
		const url = `${proto}//${window.location.host}/api/events`;
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.ws = socket;

		socket.onopen = () => {
			this.connected = true;
			this.retryDelay = 1000;
			if (this.pingTimer) clearInterval(this.pingTimer);
			this.pingTimer = setInterval(() => {
				if (socket.readyState === WebSocket.OPEN) {
					try {
						socket.send("ping");
					} catch {
						// Ignore send errors.
					}
				}
			}, 25_000);
		};

		socket.onmessage = (msg) => {
			if (typeof msg.data !== "string" || msg.data === "pong") return;
			try {
				const parsed = JSON.parse(msg.data) as JobRealtimeEvent;
				if (parsed?.type !== "job_event" || !parsed.jobId) return;
				this.ingest(parsed);
			} catch {
				// Ignore malformed frames.
			}
		};

		socket.onerror = () => {
			this.connected = false;
		};

		socket.onclose = () => {
			this.connected = false;
			if (this.pingTimer) {
				clearInterval(this.pingTimer);
				this.pingTimer = null;
			}
			this.ws = null;
			if (this.enabled) this.scheduleReconnect();
		};
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || !this.enabled) return;
		const delay = this.retryDelay;
		this.retryDelay = Math.min(20_000, Math.round(this.retryDelay * 1.6));
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	private ingest(ev: JobRealtimeEvent): void {
		const prev = this.latestByJob.get(ev.jobId);
		if (prev) {
			const prevRank = RANK[prev.status];
			const nextRank = RANK[ev.status];
			if (nextRank < prevRank) return;
			if (nextRank === prevRank && nextRank === 2) return;
			if (
				nextRank === prevRank &&
				(ev.attempt ?? 0) === (prev.attempt ?? 0) &&
				ev.progress < prev.progress &&
				ev.ts <= prev.ts
			) {
				return;
			}
		}
		this.latestByJob.set(ev.jobId, ev);
		if (this.latestByJob.size > 200) {
			const oldestKey = this.latestByJob.keys().next().value;
			if (oldestKey) this.latestByJob.delete(oldestKey);
		}
		for (const listener of this.anyListeners) listener(ev);
		const perJob = this.jobListeners.get(ev.jobId);
		if (perJob) {
			for (const listener of perJob) listener(ev);
		}
	}
}

export const jobEvents = new JobEventClient();
