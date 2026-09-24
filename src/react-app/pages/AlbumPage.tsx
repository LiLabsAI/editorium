import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { api, describeError, fileUrl, uploadFile, waitForJob } from "../lib/api";
import type { ImageDto, MessageDto, ThreadDto } from "../lib/api";
import { AskComposer } from "../components/Composer";
import { TopBar, PillButton, IconButton } from "../components/TopBar";

type Frame = { event: string; data: Record<string, unknown> };

function parseFrame(part: string): Frame | null {
	const line = part.trim();
	if (!line.startsWith("data:")) return null;
	try {
		return JSON.parse(line.slice(5).trim()) as Frame;
	} catch {
		return null;
	}
}

/** Album workspace (Screen B): image cards on a dark canvas + the Ask chat panel. */
export function AlbumPage({ projectName }: { projectName: string }) {
	const { albumId } = useParams<{ albumId: string }>();
	const navigate = useNavigate();
	const [albumTitle, setAlbumTitle] = useState("Album");
	const [images, setImages] = useState<ImageDto[]>([]);
	const [threads, setThreads] = useState<ThreadDto[]>([]);
	const [threadId, setThreadId] = useState<string | null>(null);
	const [messages, setMessages] = useState<MessageDto[]>([]);
	const [streaming, setStreaming] = useState("");
	const [uploading, setUploading] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [pendingJobs, setPendingJobs] = useState(0);
	const fileRef = useRef<HTMLInputElement>(null);

	const loadImages = useCallback(async () => {
		if (!albumId) return;
		const [imgsRes, threadsRes] = await Promise.all([
			api.albumImages(albumId),
			api.albumThreads(albumId),
		]);
		setImages(imgsRes.images);
		setThreads(threadsRes.threads);
		if (threadsRes.threads.length > 0 && !threadId) {
			setThreadId(threadsRes.threads[0]!.id);
		} else if (threadsRes.threads.length === 0) {
			const { thread } = await api.createThread(albumId);
			setThreads([thread]);
			setThreadId(thread.id);
		}
	}, [albumId, threadId]);

	const hasPending = images.some((img) => img.segmentStatus === "pending");

	useEffect(() => {
		loadImages();
		if (albumId) api.albumGet(albumId).then((r) => setAlbumTitle(r.album.title));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [albumId]);

	// While any card is being recognized, refresh until it settles (plan 21).
	useEffect(() => {
		if (!hasPending) return;
		const timer = window.setInterval(loadImages, 2500);
		return () => window.clearInterval(timer);
	}, [hasPending, loadImages]);

	useEffect(() => {
		if (!threadId) return;
		api.threadMessages(threadId).then((res) => setMessages(res.messages));
	}, [threadId]);

	async function onUpload(files: FileList | null) {
		if (!albumId || !files?.length) return;
		setUploading(true);
		setNotice(null);
		try {
			for (const file of Array.from(files)) {
				await uploadFile(albumId, file);
			}
		} catch (err) {
			setNotice(`Upload failed: ${describeError(err)}`);
		} finally {
			await loadImages().catch(() => undefined);
			setUploading(false);
		}
	}

	/** Follow a queued AI job to completion, then refresh the grid + chat. */
	async function followJob(jobId: string) {
		if (!threadId) return;
		setPendingJobs((n) => n + 1);
		try {
			const job = await waitForJob(jobId);
			if (!job) setNotice("That's taking longer than usual — it will appear here when it finishes.");
			else if (job.status === "error") setNotice("The AI operation failed. Your credits were refunded.");
			await loadImages();
			const { messages: fresh } = await api.threadMessages(threadId);
			setMessages(fresh);
		} catch (err) {
			setNotice(describeError(err));
		} finally {
			setPendingJobs((n) => n - 1);
		}
	}

	async function send(text: string, attachedImageId?: string, paletteIds?: string[]) {
		if (!threadId) return;
		setStreaming("");
		const optimistic: MessageDto = {
			id: `tmp-${Date.now()}`,
			threadId,
			role: "user",
			text,
			attachedImageId: attachedImageId ?? null,
			resultImageId: null,
			operation: null,
			jobId: null,
			createdAt: new Date().toISOString(),
		};
		setMessages((m) => [...m, optimistic]);

		setNotice(null);
		const jobIds: string[] = [];
		try {
			const res = await api.sendMessage(threadId, { text, attachedImageId, paletteIds });
			if (!res.ok || !res.body) {
				const detail = (await res.json().catch(() => ({}))) as { error?: string };
				setNotice(describeError(new Error(detail.error ?? "error")));
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split("\n\n");
				buffer = parts.pop() ?? "";
				for (const frame of parts.map(parseFrame)) {
					if (!frame) continue;
					if (frame.event === "token") {
						setStreaming((s) => s + String(frame.data.value ?? ""));
					} else if (frame.event === "tool" && typeof frame.data.jobId === "string") {
						jobIds.push(frame.data.jobId);
					} else if (frame.event === "error") {
						setNotice(
							frame.data.code === "insufficient_credits"
								? describeError(new Error("insufficient_credits"))
								: String(frame.data.message ?? "Something went wrong."),
						);
					}
				}
			}
		} catch (err) {
			setNotice(describeError(err));
		} finally {
			// Refresh the persisted conversation, then follow any queued jobs.
			const { messages: fresh } = await api.threadMessages(threadId).catch(() => ({ messages }));
			setMessages(fresh);
			setStreaming("");
		}
		for (const jobId of jobIds) void followJob(jobId);
	}

	async function deleteImage(image: ImageDto) {
		try {
			await api.deleteImage(image.id);
			setImages((imgs) => imgs.filter((i) => i.id !== image.id));
		} catch (err) {
			setNotice(describeError(err));
		}
	}

	async function toggleBookmark(image: ImageDto) {
		await api.patchImage(image.id, { bookmarked: !image.bookmarkedAt });
		setImages((imgs) =>
			imgs.map((i) =>
				i.id === image.id
					? { ...i, bookmarkedAt: i.bookmarkedAt ? null : new Date().toISOString() }
					: i,
			),
		);
	}

	return (
		<div className="flex h-screen flex-col">
			<TopBar
				projectName={projectName}
				crumbs={[{ label: albumTitle }]}
				actions={
					<>
						<select
							aria-label="Filter images"
							className="rounded-lg bg-transparent px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
							onChange={async (e) => {
								if (!albumId) return;
								const res = await api.albumImages(albumId, e.target.value);
								setImages(res.images);
							}}
						>
							<option value="all">All</option>
							<option value="uploads">Uploads</option>
							<option value="generated">Generated</option>
						</select>
						<PillButton onClick={() => fileRef.current?.click()}>
							{uploading ? "Uploading…" : "Upload"}
						</PillButton>
						<input
							ref={fileRef}
							type="file"
							accept="image/png,image/jpeg,image/webp,image/gif"
							multiple
							hidden
							onChange={(e) => onUpload(e.target.files)}
						/>
					</>
				}
			/>
			<div className="flex min-h-0 flex-1">
				{/* Album canvas */}
				<main className="ed-canvas-bg min-w-0 flex-1 overflow-y-auto p-8">
					{images.length === 0 ? (
						<button
							onClick={() => fileRef.current?.click()}
							className="mx-auto mt-20 flex h-56 w-72 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 text-sm text-muted-foreground hover:border-white/30"
						>
							<span className="text-2xl">+</span>
							Upload a photo to start
						</button>
					) : (
						<div className="flex flex-wrap items-start gap-6">
							{images.map((image) => (
								<ImageCard
									key={image.id}
									image={image}
									onOpen={() => navigate(`/albums/${albumId}/images/${image.id}`)}
									onBookmark={() => toggleBookmark(image)}
									onDelete={() => deleteImage(image)}
									onAttach={() => send(`Work with ${image.filenameLabel}`, image.id)}
								/>
							))}
						</div>
					)}
				</main>

				{/* Chat panel */}
				<aside className="ed-panel flex w-[430px] shrink-0 flex-col border-l ed-hairline">
					<div className="flex items-center justify-between px-4 py-3">
						<h2 className="text-lg font-semibold">Create</h2>
						<select
							aria-label="Chat thread"
							value={threadId ?? ""}
							onChange={(e) => setThreadId(e.target.value)}
							className="rounded-full bg-secondary px-3 py-1 text-sm"
						>
							{threads.map((t) => (
								<option key={t.id} value={t.id}>
									{t.title}
								</option>
							))}
						</select>
					</div>
					<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4" role="log" aria-live="polite">
						{messages.map((m) => (
							<MessageBubble
								key={m.id}
								message={m}
								onOpen={(id) => navigate(`/albums/${albumId}/images/${id}`)}
							/>
						))}
						{streaming && (
							<p className="whitespace-pre-wrap text-[15px] text-foreground/90">{streaming}</p>
						)}
						{pendingJobs > 0 && (
							<p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
								<span className="inline-block size-3 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
								Working on it…
							</p>
						)}
						{notice && (
							<p role="alert" className="text-sm text-red-300">
								{notice}
							</p>
						)}
					</div>
					<div className="p-4 pt-0">
						<AskComposer onSend={(text) => send(text)} />
					</div>
				</aside>
			</div>
		</div>
	);
}

function ImageCard({
	image,
	onOpen,
	onBookmark,
	onDelete,
	onAttach,
}: {
	image: ImageDto;
	onOpen: () => void;
	onBookmark: () => void;
	onDelete: () => void;
	onAttach: () => void;
}) {
	return (
		<figure className="group relative w-72 select-none">
			<button onClick={onOpen} className="block w-full overflow-hidden rounded-xl bg-secondary" aria-label={`Open ${image.filenameLabel}`}>
				<img
					src={fileUrl(image.id, "web")}
					alt={image.filenameLabel}
					loading="lazy"
					className="aspect-square w-full object-cover"
				/>
			</button>
			{image.segmentStatus === "pending" && (
				<div
					className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45 text-xs text-white"
					role="status"
				>
					<span className="mr-2 inline-block size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
					Recognizing…
				</div>
			)}
			{image.segmentStatus === "failed" && (
				<div className="pointer-events-none absolute inset-x-0 bottom-8 text-center text-[11px] text-red-300">
					Recognition failed
				</div>
			)}
			<figcaption className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded-md bg-black/55 px-2 py-0.5 text-[11px] tracking-wide text-white/90">
				{image.filenameLabel.slice(0, 18).toUpperCase()}
			</figcaption>
			{image.kind !== "upload" && (
				<span className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/80">
					{image.kind}
				</span>
			)}
			<div className="absolute bottom-2 right-2 opacity-0 transition group-hover:opacity-100">
				<IconButton title="Bookmark" onClick={onBookmark}>
					{image.bookmarkedAt ? "★" : "☆"}
				</IconButton>
			</div>
			<div className="absolute bottom-2 left-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
				<IconButton title="Delete" onClick={onDelete}>
					🗑
				</IconButton>
				<IconButton title="Attach to chat" onClick={onAttach}>
					💬
				</IconButton>
			</div>
		</figure>
	);
}

function MessageBubble({ message, onOpen }: { message: MessageDto; onOpen: (imageId: string) => void }) {
	if (message.role === "user") {
		return (
			<div className="ml-8 rounded-2xl bg-secondary px-4 py-3 text-[15px]">{message.text}</div>
		);
	}
	return (
		<div className="space-y-3 pr-4">
			<p className="whitespace-pre-wrap text-[15px] leading-relaxed">{message.text}</p>
			{message.resultImageId && (
				<button
					onClick={() => onOpen(message.resultImageId!)}
					className="block overflow-hidden rounded-xl border ed-hairline"
					aria-label="Open result in editor"
				>
					<img src={fileUrl(message.resultImageId, "thumb")} alt="Result" className="h-24 w-24 object-cover" />
				</button>
			)}
		</div>
	);
}
