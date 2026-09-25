import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import {
	api,
	describeError,
	fileUrl,
	readAgentStream,
	waitForJob,
	type Box,
	type HistoryTurn,
	type ImageDto,
} from "../lib/api";
import { isPending } from "../lib/history";
import { editorStore } from "../lib/store";
import { TopBar } from "../components/TopBar";
import { EditComposer } from "../components/EditComposer";
import { HistoryPanel, type LiveTurn } from "../components/HistoryPanel";
import { EditorCanvas } from "../editor/Canvas";

const HISTORY_POLL_MS = 2000;

/**
 * The editor: one photo family, one history, one composer (phase 5).
 * Left rail = branch filmstrip. Center = the photo (drag a box to select a
 * region). Right rail = the family's history + the context-aware composer.
 */
export function EditorPage({ projectName }: { projectName: string }) {
	const { albumId, imageId } = useParams<{ albumId: string; imageId: string }>();
	const navigate = useNavigate();
	const [albumTitle, setAlbumTitle] = useState("Album");
	const [image, setImage] = useState<ImageDto | null>(null);
	const [family, setFamily] = useState<ImageDto[]>([]);
	const [turns, setTurns] = useState<HistoryTurn[]>([]);
	const [threadId, setThreadId] = useState<string | null>(null);
	const [live, setLive] = useState<LiveTurn | null>(null);
	const [selection, setSelection] = useState<Box | null>(null);
	const [highlights, setHighlights] = useState<Box[]>([]);
	const [draft, setDraft] = useState("");
	const [wantsRegion, setWantsRegion] = useState(false);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const viewing = useRef(imageId);
	viewing.current = imageId;

	// Fresh canvas state per photo.
	useEffect(() => {
		editorStore.set({ tool: "region", selectedIds: [], hoveredId: null });
		setSelection(null);
		setHighlights([]);
	}, [imageId]);

	const loadPhoto = useCallback(async () => {
		if (!albumId || !imageId) return;
		const { image: img, album } = await api.image(imageId);
		setImage(img);
		setAlbumTitle(album.title);
		const f = await api.branchFamily(imageId).catch(() => ({ images: [] as ImageDto[] }));
		setFamily(f.images);
	}, [albumId, imageId]);

	const loadHistory = useCallback(async () => {
		if (!imageId) return;
		const h = await api.history(imageId);
		setTurns(h.turns);
		setThreadId(h.threadId);
	}, [imageId]);

	useEffect(() => {
		loadPhoto().catch((err) => setNotice(describeError(err)));
		loadHistory().catch((err) => setNotice(describeError(err)));
	}, [loadPhoto, loadHistory]);

	// While anything is queued or running, keep the history (and strip) fresh.
	const pending = turns.some(isPending);
	useEffect(() => {
		if (!pending) return;
		const timer = window.setInterval(() => {
			loadHistory().catch(() => undefined);
		}, HISTORY_POLL_MS);
		return () => {
			window.clearInterval(timer);
			// A pending entry just settled: new branches may exist.
			loadPhoto().catch(() => undefined);
		};
	}, [pending, loadHistory, loadPhoto]);

	const open = useCallback(
		(id: string) => {
			if (albumId) navigate(`/albums/${albumId}/images/${id}`);
		},
		[albumId, navigate],
	);

	/** When a job started from this photo finishes, go to its result — but
	 * only if the user is still looking at the photo it started from. */
	const follow = useCallback(
		async (jobId: string, startedOn: string) => {
			const job = await waitForJob(jobId).catch(() => null);
			await loadHistory().catch(() => undefined);
			if (job?.status === "done" && job.resultImageId && viewing.current === startedOn) open(job.resultImageId);
		},
		[loadHistory, open],
	);

	/** Start a queued operation; the history shows its progress. */
	async function startJob(start: () => Promise<{ jobId: string }>) {
		if (!image) return;
		setBusy(true);
		setNotice(null);
		try {
			const { jobId } = await start();
			await loadHistory();
			void follow(jobId, image.id);
		} catch (err) {
			setNotice(describeError(err));
		} finally {
			setBusy(false);
		}
	}

	/** Region edit on the selected box (only that area changes). */
	const regionEdit = (text: string, box: Box, onImage = image?.id) =>
		startJob(async () => {
			const { instruction } = await api.createInstruction(onImage!, { text, bbox: box });
			return api.applyInstructions(onImage!, [instruction.id]);
		});

	/** No box: the agent answers a question or runs what the message asks for. */
	async function chat(text: string) {
		if (!image || !threadId) return;
		setBusy(true);
		setNotice(null);
		setLive({ text, reply: "" });
		const startedOn = image.id;
		try {
			const res = await api.sendMessage(threadId, { text, attachedImageId: image.id });
			await readAgentStream(res, (event, data) => {
				if (event === "token") setLive((l) => (l ? { ...l, reply: l.reply + String(data.value ?? "") } : l));
				else if (event === "tool" && typeof data.jobId === "string") void follow(data.jobId, startedOn);
				else if (event === "error") {
					setNotice(data.code === "insufficient_credits" ? "You're out of credits." : String(data.message ?? "Something went wrong."));
				}
			});
		} catch (err) {
			setNotice(describeError(err));
		} finally {
			await loadHistory().catch(() => undefined);
			setLive(null);
			setBusy(false);
		}
	}

	async function submit(text: string) {
		setDraft("");
		setWantsRegion(false);
		if (selection) {
			const box = selection;
			setSelection(null);
			await regionEdit(text, box);
		} else {
			await chat(text);
		}
	}

	function retry(turn: HistoryTurn) {
		const on = turn.request.imageId;
		if (!on) return;
		const { text, opClass, bboxes } = turn.request;
		if (opClass === "enhance") void startJob(() => api.enhanceImage(on));
		else if (opClass === "segment") void startJob(() => api.removeBackground(on));
		else if (opClass === "reimagine") void startJob(() => api.editImage(on, text));
		else if (opClass === "local" && bboxes[0]) void regionEdit(text, bboxes[0], on);
	}

	/** Deterministic pixel presets (B&W, golden hour): instant, free, no AI. */
	async function applyFilter(kind: "bw" | "golden", label: string) {
		if (!image || busy) return;
		setBusy(true);
		setNotice(null);
		try {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.src = fileUrl(image.id, "original", image.currentVersionId ?? undefined);
			await new Promise((res, rej) => {
				img.onload = res;
				img.onerror = () => rej(new Error("Could not load photo"));
			});
			// Cap at ~24 MP so huge photos neither exhaust memory nor exceed
			// the 25 MB upload limit once re-encoded.
			const scale = Math.min(1, Math.sqrt(24_000_000 / (img.naturalWidth * img.naturalHeight)));
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(img.naturalWidth * scale);
			canvas.height = Math.round(img.naturalHeight * scale);
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Canvas unavailable");
			ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
			const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
			const px = data.data;
			for (let i = 0; i < px.length; i += 4) {
				const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
				if (kind === "bw") {
					const l = 0.299 * r + 0.587 * g + 0.114 * b;
					px[i] = px[i + 1] = px[i + 2] = l;
				} else {
					px[i] = Math.min(255, r * 1.12 + 12);
					px[i + 1] = Math.min(255, g * 1.02 + 6);
					px[i + 2] = b * 0.86;
				}
			}
			ctx.putImageData(data, 0, 0);
			const blob = await new Promise<Blob>((res, rej) =>
				canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/jpeg", 0.92),
			);
			const { imageId: newId } = await api.filterBranch(image.id, label, blob);
			open(newId);
		} catch (err) {
			setNotice(`${label} failed: ${describeError(err)}`);
		} finally {
			setBusy(false);
		}
	}

	async function download() {
		if (!image) return;
		const res = await fetch(fileUrl(image.id, "original", image.currentVersionId ?? undefined));
		if (!res.ok) {
			setNotice("Download failed. Try again.");
			return;
		}
		const blob = await res.blob();
		const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${image.filenameLabel.replace(/\.[a-z0-9]+$/i, "") || "editorium"}.${ext}`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	async function share() {
		if (!image) return;
		try {
			const { url } = await api.share(image.id);
			const full = `${location.origin}${url}`;
			const copied = await navigator.clipboard?.writeText(full).then(
				() => true,
				() => false,
			);
			setNotice(copied ? `Share link copied: ${full}` : `Share link: ${full}`);
		} catch (err) {
			setNotice(`Couldn't create a share link: ${describeError(err)}`);
		}
	}

	const lastPrompt =
		[...turns].reverse().find((t) => !t.derived && t.request.opClass !== "upload")?.request.text ?? null;
	const quick = "rounded-full border ed-hairline bg-secondary px-3 py-1.5 text-xs transition hover:bg-muted disabled:opacity-40";

	return (
		<div className="flex h-screen flex-col">
			<TopBar
				projectName={projectName}
				crumbs={[{ label: albumTitle, to: albumId ? `/albums/${albumId}` : undefined }, { label: image?.filenameLabel ?? "…" }]}
				actions={
					image && (
						<>
							<button onClick={download} className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground">
								Download
							</button>
							<button onClick={share} className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-85">
								Share
							</button>
						</>
					)
				}
			/>
			<div className="flex min-h-0 flex-1">
				{/* Branch filmstrip: every edit becomes a photo beside the original */}
				<aside className="ed-panel flex w-16 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r ed-hairline py-3">
					{family.map((img) => (
						<button
							key={img.id}
							title={img.filenameLabel}
							onClick={() => open(img.id)}
							className={`overflow-hidden rounded-lg border-2 transition ${
								img.id === imageId ? "border-[rgba(99,120,255,0.95)]" : "border-transparent opacity-70 hover:opacity-100"
							}`}
						>
							<img
								src={fileUrl(img.id, "thumb", img.currentVersionId ?? undefined)}
								alt={img.filenameLabel}
								loading="lazy"
								className="size-11 object-cover"
							/>
						</button>
					))}
				</aside>

				{image ? (
					<EditorCanvas
						image={image}
						selection={selection}
						onSelectionChange={setSelection}
						highlights={highlights}
						sourceUrl={
							image.sourceImageId
								? fileUrl(
										image.sourceImageId,
										"web",
										family.find((f) => f.id === image.sourceImageId)?.currentVersionId ?? undefined,
									)
								: undefined
						}
					/>
				) : (
					<div className="ed-canvas-bg flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
						Loading…
					</div>
				)}

				{/* History + composer: everything asked, everything returned */}
				<aside className="ed-panel flex w-[360px] shrink-0 flex-col border-l ed-hairline">
					{image ? (
						<HistoryPanel
							turns={turns}
							live={live}
							currentImageId={image.id}
							onOpen={open}
							onRetry={retry}
							onEditPrompt={(text) => setDraft(text)}
							onRegionize={(text) => {
								setDraft(text);
								setWantsRegion(true);
							}}
							onHighlight={setHighlights}
						/>
					) : (
						<div className="flex-1" />
					)}
					<div className="space-y-2 border-t ed-hairline p-3">
						<div className="flex flex-wrap gap-1.5">
							<button disabled={busy} onClick={() => applyFilter("bw", "Black & white")} className={quick}>
								Black & white
							</button>
							<button disabled={busy} onClick={() => applyFilter("golden", "Golden hour")} className={quick}>
								Golden hour
							</button>
							<button
								disabled={busy || !image}
								onClick={() => image && startJob(() => api.enhanceImage(image.id))}
								title="AI upscale + sharpen. Keeps the photo exactly as it is."
								className={quick}
							>
								✦ Enhance (AI)
							</button>
							<button
								disabled={busy || !image}
								onClick={() => image && startJob(() => api.removeBackground(image.id))}
								title="Cuts out the subject onto a transparent background. Nothing is repainted."
								className={quick}
							>
								Remove background
							</button>
						</div>
						{notice && (
							<p role="alert" className="break-words rounded-lg bg-secondary/60 px-3 py-2 text-xs text-foreground">
								{notice}
							</p>
						)}
						{image && (
							<EditComposer
								imageId={image.id}
								imageLabel={image.filenameLabel}
								selection={selection}
								onClearSelection={() => setSelection(null)}
								value={draft}
								onChange={setDraft}
								onSubmit={submit}
								busy={busy}
								lastPrompt={lastPrompt}
								wantsRegion={wantsRegion}
							/>
						)}
					</div>
				</aside>
			</div>
		</div>
	);
}
