import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import {
	api,
	describeError,
	fileUrl,
	readAgentStream,
	uploadFile,
	waitForJob,
	type ImageDto,
	type Me,
	type MessageDto,
	type ReferenceDto,
	type ThreadDto,
} from "../lib/api";
import { jobEvents } from "../lib/events";
import { AskComposer, type AttachedTarget } from "../components/Composer";
import { IconButton, PillButton, TopBar } from "../components/TopBar";

/** Album workspace (Screen B): image gallery with drag-drop uploads, branch filter,
 * non-destructive chat attachment, real-time DO status updates, and Ask chat panel. */
export function AlbumPage({ projectName, me }: { projectName: string; me?: Me | null }) {
	const { albumId } = useParams<{ albumId: string }>();
	const navigate = useNavigate();
	const [albumTitle, setAlbumTitle] = useState("Album");
	const [filter, setFilter] = useState<"all" | "uploads" | "generated">("all");
	const [hideBranches, setHideBranches] = useState(false);
	const [images, setImages] = useState<ImageDto[]>([]);
	const [threads, setThreads] = useState<ThreadDto[]>([]);
	const [threadId, setThreadId] = useState<string | null>(null);
	const [messages, setMessages] = useState<MessageDto[]>([]);
	const [streaming, setStreaming] = useState("");
	const [isStreaming, setIsStreaming] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [draggingOver, setDraggingOver] = useState(false);
	const [attached, setAttached] = useState<AttachedTarget | null>(null);
	const [references, setReferences] = useState<ReferenceDto[]>([]);
	const [selectedRefIds, setSelectedRefIds] = useState<string[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [pendingJobs, setPendingJobs] = useState(0);
	const fileRef = useRef<HTMLInputElement>(null);
	const abortRef = useRef<AbortController | null>(null);

	const loadImages = useCallback(
		async (activeFilter = filter, preferThreadId?: string | null) => {
			if (!albumId) return;
			const [imgsRes, threadsRes] = await Promise.all([
				api.albumImages(albumId, activeFilter),
				api.albumThreads(albumId),
			]);
			setImages(imgsRes.images);
			setThreads(threadsRes.threads);
			const currentId = preferThreadId !== undefined ? preferThreadId : threadId;
			if (!currentId || !threadsRes.threads.some((t) => t.id === currentId)) {
				const albumChat = threadsRes.threads.find((t) => !t.rootImageId);
				if (albumChat) {
					setThreadId(albumChat.id);
				} else {
					const { thread } = await api.createThread(albumId);
					setThreads([thread, ...threadsRes.threads]);
					setThreadId(thread.id);
				}
			}
		},
		[albumId, filter, threadId],
	);

	useEffect(() => {
		setThreadId(null);
		setMessages([]);
		setAttached(null);
		setSelectedRefIds([]);
		setStreaming("");
		setNotice(null);
		if (!albumId) return;
		void loadImages(filter, null).catch((err) => setNotice(describeError(err)));
		api.albumGet(albumId)
			.then((r) => setAlbumTitle(r.album.title))
			.catch((err) => setNotice(describeError(err)));
		api.references()
			.then((r) => setReferences(r.references))
			.catch(() => {});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [albumId]);

	const hasPendingSegments = images.some((img) => img.segmentStatus === "pending");
	const activeThread = threads.find((t) => t.id === threadId);

	// Real-time DO event subscription replaces rapid polling; fallback interval only runs when WS isn't open.
	useEffect(() => {
		const unsub = jobEvents.subscribe((ev) => {
			if (ev.status === "done" || ev.status === "error" || ev.segmentStatus) {
				void loadImages(filter).catch(() => {});
			}
		});
		const timer =
			hasPendingSegments && !jobEvents.isConnected()
				? window.setInterval(() => void loadImages(filter).catch(() => {}), 3000)
				: null;
		return () => {
			unsub();
			if (timer) window.clearInterval(timer);
		};
	}, [hasPendingSegments, filter, loadImages]);

	useEffect(() => {
		if (!threadId) return;
		api.threadMessages(threadId)
			.then((res) => setMessages(res.messages))
			.catch((err) => setNotice(describeError(err)));
	}, [threadId]);

	async function onUpload(files: FileList | null) {
		if (!albumId || !files?.length) return;
		const valid = Array.from(files).filter((f) => f.size > 0);
		if (!valid.length) return;
		setUploading(true);
		setNotice(null);
		try {
			for (const file of valid) {
				await uploadFile(albumId, file);
			}
		} catch (err) {
			setNotice(`Upload failed: ${describeError(err)}`);
		} finally {
			await loadImages(filter).catch(() => undefined);
			setUploading(false);
		}
	}

	async function followJob(jobId: string) {
		if (!threadId) return;
		setPendingJobs((n) => n + 1);
		try {
			const job = await waitForJob(jobId);
			if (!job) setNotice("That's taking longer than usual — it will appear here when it finishes.");
			else if (job.status === "error") setNotice(job.error ?? "The AI operation failed. Your credits were refunded.");
			await loadImages(filter);
			const { messages: fresh } = await api.threadMessages(threadId);
			setMessages(fresh);
		} catch (err) {
			setNotice(describeError(err));
		} finally {
			setPendingJobs((n) => n - 1);
		}
	}

	async function send(text: string) {
		if (!threadId || isStreaming) return;
		const controller = new AbortController();
		abortRef.current = controller;
		setStreaming("");
		setIsStreaming(true);
		const optimistic: MessageDto = {
			id: `tmp-${Date.now()}`,
			threadId,
			role: "user",
			text,
			attachedImageId: attached?.id ?? null,
			resultImageId: null,
			operation: null,
			jobId: null,
			createdAt: new Date().toISOString(),
		};
		setMessages((m) => [...m, optimistic]);
		setNotice(null);
		const targetAttachmentId = attached?.id;
		const refs = [...selectedRefIds];
		setAttached(null);

		const jobIds: string[] = [];
		try {
			const res = await api.sendMessage(
				threadId,
				{
					text,
					attachedImageId: targetAttachmentId,
					mentionImageIds: refs.length ? refs : undefined,
				},
				controller.signal,
			);
			await readAgentStream(res, (event, data) => {
				if (event === "token") {
					setStreaming((s) => s + String(data.value ?? ""));
				} else if (event === "tool" && typeof data.jobId === "string") {
					jobIds.push(data.jobId);
				} else if (event === "error") {
					setNotice(
						data.code === "insufficient_credits"
							? describeError(new Error("insufficient_credits"))
							: String(data.message ?? "Something went wrong."),
					);
				}
			});
		} catch (err) {
			if (!(err instanceof DOMException && err.name === "AbortError")) {
				setNotice(describeError(err));
			}
		} finally {
			abortRef.current = null;
			setIsStreaming(false);
			setStreaming("");
			const { messages: fresh } = await api.threadMessages(threadId).catch(() => ({ messages }));
			setMessages(fresh);
		}
		for (const jobId of jobIds) void followJob(jobId);
	}

	async function startNewThread() {
		if (!albumId) return;
		try {
			const { thread } = await api.createThread(albumId, true);
			setThreads((list) => [thread, ...list]);
			setThreadId(thread.id);
			setMessages([]);
		} catch (err) {
			setNotice(describeError(err));
		}
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
		try {
			await api.patchImage(image.id, { bookmarked: !image.bookmarkedAt });
			setImages((imgs) =>
				imgs.map((i) =>
					i.id === image.id ? { ...i, bookmarkedAt: i.bookmarkedAt ? null : new Date().toISOString() } : i,
				),
			);
		} catch (err) {
			setNotice(describeError(err));
		}
	}

	const visibleImages = hideBranches ? images.filter((i) => !i.sourceImageId) : images;

	return (
		<div className="flex h-screen flex-col">
			<TopBar
				projectName={projectName}
				crumbs={[{ label: albumTitle }]}
				me={me}
				actions={
					<>
						<button
							type="button"
							onClick={() => setHideBranches((v) => !v)}
							aria-pressed={hideBranches}
							className={`rounded-lg px-2 py-1 text-xs transition ${
								hideBranches ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"
							}`}
						>
							{hideBranches ? "Showing roots" : "All versions"}
						</button>
						<select
							aria-label="Filter images"
							value={filter}
							onChange={(e) => {
								const next = e.target.value as "all" | "uploads" | "generated";
								setFilter(next);
								void loadImages(next).catch((err) => setNotice(describeError(err)));
							}}
							className="rounded-lg bg-transparent px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
						>
							<option value="all">All</option>
							<option value="uploads">Uploads</option>
							<option value="generated">Generated</option>
						</select>
						<PillButton onClick={() => fileRef.current?.click()} disabled={uploading}>
							{uploading ? "Uploading…" : "Upload"}
						</PillButton>
						<input
							ref={fileRef}
							type="file"
							accept="image/png,image/jpeg,image/webp,image/gif"
							multiple
							hidden
							onChange={(e) => {
								void onUpload(e.target.files);
								e.target.value = "";
							}}
						/>
					</>
				}
			/>
			<div className="flex min-h-0 flex-1">
				{/* Album canvas with drag-and-drop */}
				<main
					onDragOver={(e) => {
						e.preventDefault();
						setDraggingOver(true);
					}}
					onDragLeave={() => setDraggingOver(false)}
					onDrop={(e) => {
						e.preventDefault();
						setDraggingOver(false);
						void onUpload(e.dataTransfer.files);
					}}
					className={`ed-canvas-bg relative min-w-0 flex-1 overflow-y-auto p-8 transition ${
						draggingOver ? "ring-2 ring-inset ring-indigo-400" : ""
					}`}
				>
					{visibleImages.length === 0 ? (
						<button
							type="button"
							onClick={() => fileRef.current?.click()}
							className="mx-auto mt-20 flex h-56 w-72 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 text-sm text-muted-foreground hover:border-white/30"
						>
							<span className="text-2xl">+</span>
							Drop or upload a photo to start
						</button>
					) : (
						<div className="flex flex-wrap items-start gap-6">
							{visibleImages.map((image) => (
								<ImageCard
									key={image.id}
									image={image}
									onOpen={() => navigate(`/albums/${albumId}/images/${image.id}`)}
									onBookmark={() => void toggleBookmark(image)}
									onDelete={() => void deleteImage(image)}
									onAttach={() =>
										setAttached({
											id: image.id,
											label: image.filenameLabel,
											thumbUrl: fileUrl(image.id, "thumb"),
										})
									}
								/>
							))}
						</div>
					)}
				</main>

				{/* Chat panel */}
				<aside className="ed-panel flex w-[430px] shrink-0 flex-col border-l ed-hairline">
					<div className="flex items-center justify-between gap-2 px-4 py-3">
						<h2 className="text-lg font-semibold">Create</h2>
						<div className="flex items-center gap-1.5">
							<select
								aria-label="Chat thread"
								value={threadId ?? ""}
								onChange={(e) => setThreadId(e.target.value)}
								className="max-w-44 truncate rounded-full bg-secondary px-3 py-1 text-sm"
							>
								<optgroup label="Album chats">
									{threads
										.filter((t) => !t.rootImageId)
										.map((t) => (
											<option key={t.id} value={t.id}>
												{t.title}
											</option>
										))}
								</optgroup>
								{threads.some((t) => t.rootImageId) && (
									<optgroup label="Photo histories">
										{threads
											.filter((t) => t.rootImageId)
											.map((t) => (
												<option key={t.id} value={t.id}>
													{images.find((i) => i.id === t.rootImageId)?.filenameLabel ?? "Photo history"}
												</option>
											))}
									</optgroup>
								)}
							</select>
							<button
								type="button"
								title="New chat thread"
								aria-label="New chat thread"
								onClick={() => void startNewThread()}
								className="rounded-full border ed-hairline px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								+ New
							</button>
						</div>
					</div>
					<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4" role="log" aria-live="polite">
						{messages.map((m) => (
							<MessageBubble
								key={m.id}
								message={m}
								onOpen={(id) => navigate(`/albums/${albumId}/images/${id}`)}
							/>
						))}
						{streaming && <p className="whitespace-pre-wrap text-[15px] text-foreground/90">{streaming}</p>}
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
						{activeThread?.rootImageId ? (
							<button
								type="button"
								onClick={() => navigate(`/albums/${albumId}/images/${activeThread.rootImageId}`)}
								className="w-full rounded-2xl border ed-hairline bg-card px-4 py-3 text-sm transition hover:bg-muted"
							>
								Continue this photo's history in the editor →
							</button>
						) : (
							<AskComposer
								onSend={(text) => void send(text)}
								onAbort={() => abortRef.current?.abort()}
								disabled={isStreaming}
								streaming={isStreaming}
								attachment={attached}
								onClearAttachment={() => setAttached(null)}
								references={references}
								selectedRefIds={selectedRefIds}
								onToggleRef={(id) =>
									setSelectedRefIds((list) =>
										list.includes(id)
											? list.filter((x) => x !== id)
											: list.length >= 3
												? list
												: [...list, id],
									)
								}
							/>
						)}
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
	const [confirmingDelete, setConfirmingDelete] = useState(false);

	return (
		<figure className="group relative w-72 select-none">
			<button
				type="button"
				onClick={onOpen}
				className="block w-full overflow-hidden rounded-xl bg-secondary focus-visible:ring-2"
				aria-label={`Open ${image.filenameLabel}`}
			>
				<img
					src={fileUrl(image.id, "web")}
					alt={image.filenameLabel}
					loading="lazy"
					className="aspect-square w-full object-cover"
				/>
			</button>
			{image.segmentStatus === "pending" && (
				<div
					className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-black/45 text-xs text-white"
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
			<div className="absolute bottom-2 right-2 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
				<IconButton title={image.bookmarkedAt ? "Remove bookmark" : "Bookmark"} active={!!image.bookmarkedAt} onClick={onBookmark}>
					{image.bookmarkedAt ? "★" : "☆"}
				</IconButton>
			</div>
			<div className="absolute bottom-2 left-2 flex items-center gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
				{confirmingDelete ? (
					<div className="flex items-center gap-1 rounded-lg bg-black/80 px-2 py-1 text-xs">
						<button type="button" onClick={onDelete} className="font-medium text-red-300 hover:text-red-200">
							Confirm
						</button>
						<button type="button" onClick={() => setConfirmingDelete(false)} className="text-white/70 hover:text-white">
							Cancel
						</button>
					</div>
				) : (
					<>
						<IconButton title="Delete" onClick={() => setConfirmingDelete(true)}>
							🗑
						</IconButton>
						<IconButton title="Attach to chat" onClick={onAttach}>
							💬
						</IconButton>
					</>
				)}
			</div>
		</figure>
	);
}

function MessageBubble({ message, onOpen }: { message: MessageDto; onOpen: (imageId: string) => void }) {
	if (message.role === "user") {
		return (
			<div className="ml-8 space-y-1.5 rounded-2xl bg-secondary px-4 py-3 text-[15px]">
				{message.attachedImageId && (
					<img
						src={fileUrl(message.attachedImageId, "thumb")}
						alt="Attached photo"
						className="h-14 w-14 rounded-lg object-cover"
					/>
				)}
				<p>{message.text}</p>
			</div>
		);
	}
	return (
		<div className="space-y-3 pr-4">
			<p className="whitespace-pre-wrap text-[15px] leading-relaxed">{message.text}</p>
			{message.resultImageId && (
				<button
					type="button"
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
