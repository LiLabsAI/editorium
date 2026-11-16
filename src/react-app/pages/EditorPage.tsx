import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import {
	api,
	describeError,
	fileUrl,
	readAgentStream,
	segmentMaskUrl,
	waitForJob,
	type AnnotationDto,
	type Box,
	type EditInstructionDto,
	type HistoryTurn,
	type ImageAdjustments,
	type ImageDto,
	type Me,
	type PaletteDto,
	type ReferenceDto,
	type SegmentDto,
} from "../lib/api";
import { jobEvents } from "../lib/events";
import { isPending } from "../lib/history";
import { editorStore, useEditorState, type EditorTool } from "../lib/store";
import { AdjustPanel } from "../components/AdjustPanel";
import { BranchRail } from "../components/BranchRail";
import { EditComposer } from "../components/EditComposer";
import { HistoryPanel, type LiveTurn } from "../components/HistoryPanel";
import { LayersDrawer } from "../components/LayersDrawer";
import { ShareDialog } from "../components/ShareDialog";
import { TopBar } from "../components/TopBar";
import { EditorCanvas, type CanvasHandle, type OutpaintPad } from "../editor/Canvas";
import type { NormPoint } from "../editor/geometry";
import {
	bakeAdjustedBlob,
	extractImageColors,
	hasNonZeroAdjustments,
	renderOverlayPngBlob,
} from "../editor/webgl";

const FALLBACK_POLL_MS = 3000;

function parseAdjustments(json: string | null | undefined): ImageAdjustments {
	if (!json) return {};
	try {
		const p = JSON.parse(json) as ImageAdjustments;
		return p && typeof p === "object" ? p : {};
	} catch {
		return {};
	}
}

const TOOL_BUTTONS: Array<{ id: EditorTool; label: string; key: string }> = [
	{ id: "box", label: "Box", key: "V" },
	{ id: "select", label: "Pick", key: "A" },
	{ id: "brush", label: "Brush", key: "B" },
	{ id: "eraser", label: "Eraser", key: "E" },
	{ id: "lasso", label: "Lasso", key: "L" },
	{ id: "wand", label: "Wand", key: "W" },
	{ id: "crop", label: "Crop", key: "C" },
	{ id: "outpaint", label: "Extend", key: "O" },
	{ id: "text", label: "Text", key: "T" },
	{ id: "pan", label: "Pan", key: "H" },
];

/**
 * The editor: WebGL2 non-destructive grading + crop, 4-channel brush/lasso/wand/
 * BiRefNet masks, generative outpaint, reference & palette style transfer,
 * branch timeline undo/redo, real-time DO updates, and unified history.
 */
export function EditorPage({
	projectName,
	me,
	onRefreshMe,
}: {
	projectName: string;
	me?: Me | null;
	onRefreshMe?: () => void;
}) {
	const { albumId, imageId } = useParams<{ albumId: string; imageId: string }>();
	const navigate = useNavigate();
	const editor = useEditorState();
	const canvasRef = useRef<CanvasHandle>(null);

	const [albumTitle, setAlbumTitle] = useState("Album");
	const [image, setImage] = useState<ImageDto | null>(null);
	const [family, setFamily] = useState<ImageDto[]>([]);
	const [segments, setSegments] = useState<SegmentDto[]>([]);
	const [segmentStatus, setSegmentStatus] = useState("none");
	const [annotations, setAnnotations] = useState<AnnotationDto[]>([]);
	const [pendingChips, setPendingChips] = useState<EditInstructionDto[]>([]);
	const [references, setReferences] = useState<ReferenceDto[]>([]);
	const [palettes, setPalettes] = useState<PaletteDto[]>([]);
	const [selectedRefIds, setSelectedRefIds] = useState<string[]>([]);
	const [selectedPaletteIds, setSelectedPaletteIds] = useState<string[]>([]);

	const [turns, setTurns] = useState<HistoryTurn[]>([]);
	const [threadId, setThreadId] = useState<string | null>(null);
	const [live, setLive] = useState<LiveTurn | null>(null);
	const [selection, setSelection] = useState<Box | null>(null);
	const [maskPngBase64, setMaskPngBase64] = useState<string | null>(null);
	const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
	const [adjustments, setAdjustments] = useState<ImageAdjustments>({});
	const [savingAdj, setSavingAdj] = useState(false);
	const [outpaintPad, setOutpaintPad] = useState<OutpaintPad>({ top: 0, bottom: 0, left: 0, right: 0 });
	const [textDraftPoint, setTextDraftPoint] = useState<NormPoint | null>(null);
	const [textInput, setTextInput] = useState("");
	const [textColor, setTextColor] = useState("#ffffff");

	const [leftDrawer, setLeftDrawer] = useState<"none" | "layers" | "adjust">("none");
	const [showSegmentsOnCanvas, setShowSegmentsOnCanvas] = useState(false);
	const [batchMode, setBatchMode] = useState(false);
	const [enhancingPrompt, setEnhancingPrompt] = useState(false);
	const [subjectBusy, setSubjectBusy] = useState(false);
	const [shareOpen, setShareOpen] = useState(false);
	const [highlights, setHighlights] = useState<Box[]>([]);
	const [draft, setDraft] = useState("");
	const [wantsRegion, setWantsRegion] = useState(false);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	const viewing = useRef(imageId);
	viewing.current = imageId;
	const adjTimerRef = useRef<number | null>(null);

	// Reset canvas tool state on photo change.
	useEffect(() => {
		editorStore.set({ tool: "box", selectedIds: [], hoveredId: null, compareMode: "off" });
		setSelection(null);
		setMaskPngBase64(null);
		setSelectedSegmentId(null);
		setHighlights([]);
		setOutpaintPad({ top: 0, bottom: 0, left: 0, right: 0 });
		setTextDraftPoint(null);
	}, [imageId]);

	const loadPhoto = useCallback(async () => {
		if (!albumId || !imageId) return;
		const { image: img, album } = await api.image(imageId);
		setImage(img);
		setAlbumTitle(album.title);
		setAdjustments(parseAdjustments(img.adjustmentsJson));
		const [f, segs, inst, anns, pals, refs] = await Promise.all([
			api.branchFamily(imageId).catch(() => ({ images: [] as ImageDto[] })),
			api.segments(imageId).catch(() => ({ segments: [] as SegmentDto[], status: "none" })),
			api.instructions(imageId).catch(() => ({ instructions: [] as EditInstructionDto[] })),
			api.annotations(imageId).catch(() => ({ annotations: [] as AnnotationDto[] })),
			api.imagePalettes(imageId).catch(() => ({ palettes: [] as PaletteDto[] })),
			api.references().catch(() => ({ references: [] as ReferenceDto[] })),
		]);
		setFamily(f.images);
		setSegments(segs.segments);
		setSegmentStatus(segs.status);
		setPendingChips(inst.instructions);
		setAnnotations(anns.annotations);
		setPalettes(pals.palettes);
		setReferences(refs.references);
	}, [albumId, imageId]);

	const loadHistory = useCallback(async () => {
		if (!imageId) return;
		const h = await api.history(imageId);
		setTurns(h.turns);
		setThreadId(h.threadId);
	}, [imageId]);

	const loadSegmentsOnly = useCallback(async () => {
		if (!imageId) return;
		const res = await api.segments(imageId);
		setSegments(res.segments);
		setSegmentStatus(res.status);
	}, [imageId]);

	useEffect(() => {
		void loadPhoto().catch((err) => setNotice(describeError(err)));
		void loadHistory().catch((err) => setNotice(describeError(err)));
	}, [loadPhoto, loadHistory]);

	// Real-time DO WebSocket listener + fallback poll when disconnected.
	const pending = turns.some(isPending) || segmentStatus === "pending";
	useEffect(() => {
		const unsub = jobEvents.subscribe((ev) => {
			if (ev.status === "done" || ev.status === "error") {
				void loadHistory().catch(() => {});
				void loadPhoto().catch(() => {});
				onRefreshMe?.();
			} else if (ev.segmentStatus && ev.imageId === imageId) {
				void loadSegmentsOnly().catch(() => {});
			}
		});
		const timer =
			pending && !jobEvents.isConnected()
				? window.setInterval(() => {
						void loadHistory().catch(() => {});
						void loadSegmentsOnly().catch(() => {});
					}, FALLBACK_POLL_MS)
				: null;
		return () => {
			unsub();
			if (timer) window.clearInterval(timer);
		};
	}, [pending, imageId, loadHistory, loadPhoto, loadSegmentsOnly, onRefreshMe]);

	const open = useCallback(
		(id: string) => {
			if (albumId) navigate(`/albums/${albumId}/images/${id}`);
		},
		[albumId, navigate],
	);

	// Branch Undo / Redo (Cmd+Z / Cmd+Shift+Z) across family parent -> child links.
	const undoTargetId = image?.sourceImageId ?? null;
	const redoTargetId = useMemo(
		() => family.find((f) => f.sourceImageId === image?.id)?.id ?? null,
		[family, image?.id],
	);

	useEffect(() => {
		const isTyping = (target: EventTarget | null) => {
			const el = target as HTMLElement | null;
			return el?.tagName === "TEXTAREA" || el?.tagName === "INPUT" || el?.isContentEditable;
		};
		const onKey = (e: KeyboardEvent) => {
			if (isTyping(e.target)) return;
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
				e.preventDefault();
				if (e.shiftKey) {
					if (redoTargetId) open(redoTargetId);
				} else if (undoTargetId) {
					open(undoTargetId);
				}
				return;
			}
			const shortcut = TOOL_BUTTONS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
			if (shortcut && !e.metaKey && !e.ctrlKey && !e.altKey) {
				editorStore.set({ tool: shortcut.id });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [undoTargetId, redoTargetId, open]);

	const follow = useCallback(
		async (jobId: string, startedOn: string) => {
			const job = await waitForJob(jobId).catch(() => null);
			await loadHistory().catch(() => undefined);
			onRefreshMe?.();
			if (job?.status === "done" && job.resultImageId && viewing.current === startedOn) {
				open(job.resultImageId);
			}
		},
		[loadHistory, open, onRefreshMe],
	);

	async function startJob(start: () => Promise<{ jobId: string }>) {
		if (!image) return;
		setBusy(true);
		setNotice(null);
		try {
			const { jobId } = await start();
			onRefreshMe?.();
			await loadHistory();
			void follow(jobId, image.id);
		} catch (err) {
			setNotice(describeError(err));
		} finally {
			setBusy(false);
		}
	}

	function handleAdjustChange(next: ImageAdjustments) {
		setAdjustments(next);
		if (!image) return;
		if (adjTimerRef.current) window.clearTimeout(adjTimerRef.current);
		setSavingAdj(true);
		const targetId = image.id;
		adjTimerRef.current = window.setTimeout(() => {
			api.saveAdjustments(targetId, hasNonZeroAdjustments(next) ? next : null)
				.catch((err) => setNotice(describeError(err)))
				.finally(() => setSavingAdj(false));
		}, 350);
	}

	async function bakeAdjustmentsToBranch(label = "Color adjustment") {
		if (!image || busy) return;
		setBusy(true);
		setNotice(null);
		try {
			const origUrl = fileUrl(image.id, "original", image.currentVersionId ?? undefined);
			const mime = image.mime === "image/png" ? "image/png" : "image/jpeg";
			const blob = await bakeAdjustedBlob(origUrl, adjustments, annotations, mime);
			const { imageId: newId } = await api.filterBranch(image.id, label, blob, JSON.stringify(adjustments));
			open(newId);
		} catch (err) {
			setNotice(`${label} failed: ${describeError(err)}`);
		} finally {
			setBusy(false);
		}
	}

	async function regionEdit(text: string, box: Box, maskB64 = maskPngBase64, segId = selectedSegmentId) {
		if (!image) return;
		if (segId && !maskB64) {
			await startJob(() => api.editRegion(image.id, segId, text, selectedRefIds));
			return;
		}
		if (maskB64) {
			await startJob(() =>
				api.editRegionMask(image.id, {
					bbox: box,
					prompt: text,
					maskPngBase64: maskB64,
					referenceImageIds: selectedRefIds,
				}),
			);
			return;
		}
		await startJob(async () => {
			const { instruction } = await api.createInstruction(image.id, { text, bbox: box });
			return api.applyInstructions(image.id, [instruction.id]);
		});
	}

	async function chat(text: string) {
		if (!image || !threadId) return;
		setBusy(true);
		setNotice(null);
		setLive({ text, reply: "" });
		const startedOn = image.id;
		try {
			const res = await api.sendMessage(threadId, {
				text,
				attachedImageId: image.id,
				segmentId: selectedSegmentId ?? undefined,
				mentionImageIds: selectedRefIds.length ? selectedRefIds : undefined,
				paletteIds: selectedPaletteIds.length ? selectedPaletteIds : undefined,
			});
			await readAgentStream(res, (event, data) => {
				if (event === "token") setLive((l) => (l ? { ...l, reply: l.reply + String(data.value ?? "") } : l));
				else if (event === "tool" && typeof data.jobId === "string") void follow(data.jobId, startedOn);
				else if (event === "error") {
					setNotice(
						data.code === "insufficient_credits"
							? describeError(new Error("insufficient_credits"))
							: String(data.message ?? "Something went wrong."),
					);
				}
			});
		} catch (err) {
			setNotice(describeError(err));
		} finally {
			await loadHistory().catch(() => undefined);
			onRefreshMe?.();
			setLive(null);
			setBusy(false);
		}
	}

	async function submit(text: string) {
		if (!image) return;
		setDraft("");
		setWantsRegion(false);

		if (editor.tool === "outpaint" && outpaintPad.left + outpaintPad.right + outpaintPad.top + outpaintPad.bottom > 0) {
			const pad = { ...outpaintPad };
			setOutpaintPad({ top: 0, bottom: 0, left: 0, right: 0 });
			editorStore.set({ tool: "box" });
			await startJob(() => api.outpaintImage(image.id, pad, text));
			return;
		}

		if (selection && batchMode) {
			try {
				const { instruction } = await api.createInstruction(image.id, {
					text,
					bbox: selection,
					...(maskPngBase64 ? { maskPngBase64 } : {}),
				});
				setPendingChips((list) => [...list, instruction]);
				setSelection(null);
				setMaskPngBase64(null);
				setSelectedSegmentId(null);
				canvasRef.current?.clearMask();
			} catch (err) {
				setNotice(describeError(err));
			}
			return;
		}

		if (selection) {
			const box = selection;
			const maskB64 = maskPngBase64;
			const segId = selectedSegmentId;
			setSelection(null);
			setMaskPngBase64(null);
			setSelectedSegmentId(null);
			canvasRef.current?.clearMask();
			if (selectedRefIds.length === 0 && !maskB64 && !segId) {
				await regionEdit(text, box, null, null);
			} else {
				await regionEdit(text, box, maskB64, segId);
			}
		} else if (selectedRefIds.length > 0 && !/\?/.test(text)) {
			await startJob(() => api.editImage(image.id, text, selectedRefIds));
		} else {
			await chat(text);
		}
	}

	async function applyBatchChips() {
		if (!image || pendingChips.length === 0) return;
		const ids = pendingChips.map((c) => c.id);
		await startJob(async () => {
			const res = await api.applyInstructions(image.id, ids);
			setPendingChips([]);
			return res;
		});
	}

	async function deleteChip(chipId: string) {
		try {
			await api.deleteInstruction(chipId);
			setPendingChips((list) => list.filter((c) => c.id !== chipId));
		} catch (err) {
			setNotice(describeError(err));
		}
	}

	function retry(turn: HistoryTurn) {
		const on = turn.request.imageId;
		if (!on) return;
		const { text, opClass, bboxes } = turn.request;
		if (opClass === "enhance") void startJob(() => api.enhanceImage(on));
		else if (opClass === "segment") void startJob(() => api.removeBackground(on));
		else if (opClass === "reimagine" || opClass === "style_transfer") void startJob(() => api.editImage(on, text));
		else if (opClass === "local" && bboxes[0]) {
			void startJob(async () => {
				const { instruction } = await api.createInstruction(on, { text, bbox: bboxes[0]! });
				return api.applyInstructions(on, [instruction.id]);
			});
		}
	}

	/** Quick deterministic presets (B&W, Golden hour). */
	async function applyFilter(kind: "bw" | "golden", label: string) {
		if (!image || busy) return;
		const preset: ImageAdjustments =
			kind === "bw"
				? { saturation: -1, contrast: 0.16, clarity: 0.1 }
				: { temperature: 0.38, vibrance: 0.25, contrast: 0.08, vignette: 0.22 };
		setBusy(true);
		setNotice(null);
		try {
			const origUrl = fileUrl(image.id, "original", image.currentVersionId ?? undefined);
			const mime = image.mime === "image/png" ? "image/png" : "image/jpeg";
			const blob = await bakeAdjustedBlob(origUrl, { ...adjustments, ...preset }, annotations, mime);
			const { imageId: newId } = await api.filterBranch(image.id, label, blob, JSON.stringify({ ...adjustments, ...preset }));
			open(newId);
		} catch (err) {
			setNotice(`${label} failed: ${describeError(err)}`);
		} finally {
			setBusy(false);
		}
	}

	async function extractSubject() {
		if (!image || subjectBusy) return;
		setSubjectBusy(true);
		setNotice(null);
		try {
			const { segment } = await api.extractSubjectMask(image.id);
			await loadSegmentsOnly();
			setSelectedSegmentId(segment.id);
			editorStore.set({ selectedIds: [segment.id], showMaskOverlay: true });
			const box = await canvasRef.current?.loadMaskFromUrl(segmentMaskUrl(segment.id));
			setSelection(box ?? { x: segment.bboxX, y: segment.bboxY, w: segment.bboxW, h: segment.bboxH });
			setLeftDrawer("layers");
		} catch (err) {
			setNotice(describeError(err));
		} finally {
			setSubjectBusy(false);
		}
	}

	async function saveNewAnnotation() {
		if (!image || !textDraftPoint || !textInput.trim()) return;
		try {
			const { annotation } = await api.addAnnotation(image.id, {
				text: textInput.trim(),
				normX: textDraftPoint.x,
				normY: textDraftPoint.y,
				color: textColor,
			});
			const nextList = [...annotations, annotation];
			setAnnotations(nextList);
			setTextDraftPoint(null);
			setTextInput("");
			const blob = await renderOverlayPngBlob(image.widthPx || 1024, image.heightPx || 1024, nextList);
			await api.saveOverlay(image.id, blob);
		} catch (err) {
			setNotice(describeError(err));
		}
	}

	async function removeAnnotation(annId: string) {
		if (!image) return;
		try {
			await api.deleteAnnotation(annId);
			const nextList = annotations.filter((a) => a.id !== annId);
			setAnnotations(nextList);
			const blob = await renderOverlayPngBlob(image.widthPx || 1024, image.heightPx || 1024, nextList);
			await api.saveOverlay(image.id, blob);
		} catch (err) {
			setNotice(describeError(err));
		}
	}

	async function extractPaletteFromPhoto() {
		if (!image) return;
		const srcImg = canvasRef.current?.getColorSampleSource();
		if (!srcImg) return;
		const colors = extractImageColors(srcImg, 5);
		if (!colors.length) return;
		try {
			await api.savePalette(image.id, colors, selectedSegmentId ?? undefined);
			const pals = await api.imagePalettes(image.id);
			setPalettes(pals.palettes);
		} catch (err) {
			setNotice(describeError(err));
		}
	}

	async function enhancePromptText() {
		const trimmed = draft.trim();
		if (!trimmed || enhancingPrompt) return;
		setEnhancingPrompt(true);
		try {
			const segLabel = selectedSegment?.label;
			const ctx = segLabel ? `Editing region: ${segLabel}` : "";
			const { rewritten } = await api.rewritePrompt(trimmed, selection ? "edit" : "edit", ctx);
			setDraft(rewritten);
		} catch (err) {
			setNotice(describeError(err));
		} finally {
			setEnhancingPrompt(false);
		}
	}

	async function download() {
		if (!image) return;
		setNotice(null);
		try {
			const needsClientBake = hasNonZeroAdjustments(adjustments) || annotations.length > 0;
			let blob: Blob;
			let ext = image.mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
			if (needsClientBake) {
				const outMime = image.mime === "image/png" ? "image/png" : "image/jpeg";
				ext = outMime === "image/png" ? "png" : "jpg";
				blob = await bakeAdjustedBlob(
					fileUrl(image.id, "original", image.currentVersionId ?? undefined),
					adjustments,
					annotations,
					outMime,
				);
			} else {
				const res = await fetch(fileUrl(image.id, "original", image.currentVersionId ?? undefined, true));
				if (!res.ok) throw new Error("Download failed");
				blob = await res.blob();
				ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") ?? ext;
			}
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${image.filenameLabel.replace(/\.[a-z0-9]+$/i, "") || "editorium"}.${ext}`;
			a.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (err) {
			setNotice(describeError(err));
		}
	}

	const selectedSegment = segments.find((s) => s.id === selectedSegmentId) ?? null;
	const lastPrompt = [...turns].reverse().find((t) => !t.derived && t.request.opClass !== "upload")?.request.text ?? null;
	const quick = "rounded-full border ed-hairline bg-secondary px-3 py-1.5 text-xs transition hover:bg-muted disabled:opacity-40";
	const outpaintTotal = outpaintPad.left + outpaintPad.right + outpaintPad.top + outpaintPad.bottom;

	return (
		<div className="flex h-screen flex-col">
			<TopBar
				projectName={projectName}
				crumbs={[{ label: albumTitle, to: albumId ? `/albums/${albumId}` : undefined }, { label: image?.filenameLabel ?? "…" }]}
				me={me}
				actions={
					image && (
						<>
							<button
								type="button"
								disabled={!undoTargetId}
								onClick={() => undoTargetId && open(undoTargetId)}
								title="Step back to parent branch (Cmd+Z)"
								className="rounded-full px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-30"
							>
								← Parent
							</button>
							<button
								type="button"
								disabled={!redoTargetId}
								onClick={() => redoTargetId && open(redoTargetId)}
								title="Step forward to child branch (Cmd+Shift+Z)"
								className="rounded-full px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-30"
							>
								Child →
							</button>
							<button
								type="button"
								onClick={() => void download()}
								className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
							>
								Download
							</button>
							<button
								type="button"
								onClick={() => setShareOpen(true)}
								className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-85"
							>
								Share
							</button>
						</>
					)
				}
			/>

			<div className="flex min-h-0 flex-1">
				<BranchRail
					family={family}
					currentId={imageId ?? ""}
					onOpen={open}
					onDuplicate={() =>
						image &&
						api
							.duplicateImage(image.id)
							.then((res) => open(res.image.id))
							.catch((err) => setNotice(describeError(err)))
					}
					busy={busy}
				/>

				{/* Optional Left Inspector Drawer (Layers | Adjust) */}
				{leftDrawer !== "none" && image && (
					<aside className="ed-panel flex w-72 shrink-0 flex-col border-r ed-hairline">
						<div className="flex items-center border-b ed-hairline px-3 py-2 text-xs">
							{(["layers", "adjust"] as const).map((tab) => (
								<button
									key={tab}
									type="button"
									onClick={() => setLeftDrawer(tab)}
									className={`rounded-full px-3 py-1 capitalize ${
										leftDrawer === tab ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:text-foreground"
									}`}
								>
									{tab}
								</button>
							))}
							<button
								type="button"
								aria-label="Close inspector"
								onClick={() => setLeftDrawer("none")}
								className="ml-auto rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								×
							</button>
						</div>
						{leftDrawer === "layers" ? (
							<LayersDrawer
								imageId={image.id}
								segments={segments}
								segmentStatus={segmentStatus}
								selectedId={selectedSegmentId}
								showOnCanvas={showSegmentsOnCanvas}
								onToggleShowOnCanvas={() => setShowSegmentsOnCanvas((v) => !v)}
								onSelectSegment={async (seg) => {
									setSelectedSegmentId(seg.id);
									editorStore.set({ selectedIds: [seg.id] });
									setSelection({ x: seg.bboxX, y: seg.bboxY, w: seg.bboxW, h: seg.bboxH });
									if (seg.maskR2Key) {
										await canvasRef.current?.loadMaskFromUrl(segmentMaskUrl(seg.id)).catch(() => {});
									} else {
										canvasRef.current?.clearMask();
									}
								}}
								onSegmentsUpdated={loadSegmentsOnly}
								onSelectSubject={() => void extractSubject()}
								onResegment={() => void startJob(() => api.resegment(image.id))}
								onQuickErase={(seg) =>
									void regionEdit(
										`Remove the ${seg.label} cleanly and fill seamlessly with matching background`,
										{ x: seg.bboxX, y: seg.bboxY, w: seg.bboxW, h: seg.bboxH },
										seg.maskR2Key ? maskPngBase64 : null,
										seg.id,
									)
								}
								busy={busy}
								subjectBusy={subjectBusy}
							/>
						) : (
							<AdjustPanel
								adjustments={adjustments}
								onChange={handleAdjustChange}
								onReset={() => handleAdjustChange({})}
								onBakeToBranch={() => void bakeAdjustmentsToBranch()}
								onOpenCrop={() => editorStore.set({ tool: "crop" })}
								saving={savingAdj}
								busy={busy}
							/>
						)}
					</aside>
				)}

				{/* Center Viewport Column */}
				<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
					{/* Floating Compact Studio Toolbar */}
					<div className="flex flex-wrap items-center gap-1 border-b ed-hairline ed-panel px-3 py-1.5 text-xs">
						{TOOL_BUTTONS.map((t) => (
							<button
								key={t.id}
								type="button"
								title={`${t.label} (${t.key})`}
								aria-pressed={editor.tool === t.id}
								onClick={() => editorStore.set({ tool: t.id })}
								className={`rounded-lg px-2 py-1 transition ${
									editor.tool === t.id ? "bg-indigo-500/25 font-medium text-indigo-200" : "text-muted-foreground hover:bg-muted hover:text-foreground"
								}`}
							>
								{t.label}
							</button>
						))}

						<div className="mx-1 h-4 w-px bg-white/10" />

						<button
							type="button"
							disabled={!image || subjectBusy}
							onClick={() => void extractSubject()}
							className="rounded-lg bg-indigo-500/15 px-2.5 py-1 text-indigo-200 transition hover:bg-indigo-500/25 disabled:opacity-40"
						>
							{subjectBusy ? "Selecting…" : "✨ Subject"}
						</button>

						{(editor.tool === "brush" || editor.tool === "eraser") && (
							<label className="ml-2 flex items-center gap-1.5 text-muted-foreground">
								Size
								<input
									type="range"
									min={6}
									max={140}
									value={editor.brushRadiusPx}
									onChange={(e) => editorStore.set({ brushRadiusPx: Number(e.target.value) })}
									className="w-20 accent-indigo-400"
								/>
							</label>
						)}

						{editor.tool === "wand" && (
							<label className="ml-2 flex items-center gap-1.5 text-muted-foreground">
								Tol
								<input
									type="range"
									min={8}
									max={80}
									value={editor.wandTolerance}
									onChange={(e) => editorStore.set({ wandTolerance: Number(e.target.value) })}
									className="w-20 accent-indigo-400"
								/>
							</label>
						)}

						{editor.tool === "outpaint" && outpaintTotal > 0 && image && (
							<button
								type="button"
								disabled={busy}
								onClick={() => void submit(draft.trim() || "Extend borders seamlessly")}
								className="ml-2 rounded-full bg-indigo-500 px-3 py-1 font-medium text-white hover:bg-indigo-400"
							>
								Extend (+{outpaintPad.left + outpaintPad.right}×+{outpaintPad.top + outpaintPad.bottom}px)
							</button>
						)}

						<div className="ml-auto flex items-center gap-1">
							<button
								type="button"
								aria-pressed={leftDrawer === "layers"}
								onClick={() => setLeftDrawer((d) => (d === "layers" ? "none" : "layers"))}
								className={`rounded-lg px-2 py-1 ${leftDrawer === "layers" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"}`}
							>
								Layers ({segments.length})
							</button>
							<button
								type="button"
								aria-pressed={leftDrawer === "adjust"}
								onClick={() => setLeftDrawer((d) => (d === "adjust" ? "none" : "adjust"))}
								className={`rounded-lg px-2 py-1 ${leftDrawer === "adjust" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"}`}
							>
								Adjust
							</button>
							<button
								type="button"
								onClick={() => canvasRef.current?.fit()}
								className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								Fit
							</button>
						</div>
					</div>

					{/* Text overlay popover when Text tool placed */}
					{textDraftPoint && (
						<div className="z-20 flex items-center gap-2 border-b ed-hairline bg-card px-4 py-2 text-xs">
							<input
								autoFocus
								placeholder="Overlay caption text…"
								value={textInput}
								onChange={(e) => setTextInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") void saveNewAnnotation();
									if (e.key === "Escape") setTextDraftPoint(null);
								}}
								className="flex-1 rounded-lg border ed-hairline bg-background px-2.5 py-1 outline-none focus:border-ring"
							/>
							<input
								type="color"
								aria-label="Text color"
								value={textColor}
								onChange={(e) => setTextColor(e.target.value)}
								className="size-7 cursor-pointer rounded border-0 bg-transparent"
							/>
							<button
								type="button"
								onClick={() => void saveNewAnnotation()}
								className="rounded-full bg-foreground px-3 py-1 font-medium text-background"
							>
								Place
							</button>
							<button
								type="button"
								onClick={() => setTextDraftPoint(null)}
								className="text-muted-foreground hover:text-foreground"
							>
								Cancel
							</button>
						</div>
					)}

					{image ? (
						<EditorCanvas
							ref={canvasRef}
							image={image}
							adjustments={adjustments}
							onAdjustmentsChange={handleAdjustChange}
							selection={selection}
							onSelectionChange={(box) => {
								setSelection(box);
								if (!box) setSelectedSegmentId(null);
							}}
							onMaskChange={({ maskPngBase64: b64, bbox }) => {
								setMaskPngBase64(b64);
								if (bbox) setSelection(bbox);
							}}
							outpaintPad={outpaintPad}
							onOutpaintChange={setOutpaintPad}
							segments={segments}
							showSegments={showSegmentsOnCanvas || editor.tool === "select"}
							onSelectSegment={(seg) => {
								setSelectedSegmentId(seg.id);
								editorStore.set({ selectedIds: [seg.id] });
							}}
							annotations={annotations}
							onPlaceAnnotation={(pt) => {
								setTextDraftPoint(pt);
								setTextInput("");
							}}
							onDeleteAnnotation={(id) => void removeAnnotation(id)}
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
				</div>

				{/* Right Rail: History + Presets + Composer */}
				<aside className="ed-panel flex w-[375px] shrink-0 flex-col border-l ed-hairline">
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
							<button type="button" disabled={busy} onClick={() => void applyFilter("bw", "Black & white")} className={quick}>
								Black & white
							</button>
							<button type="button" disabled={busy} onClick={() => void applyFilter("golden", "Golden hour")} className={quick}>
								Golden hour
							</button>
							<button
								type="button"
								disabled={busy || !image}
								onClick={() => image && startJob(() => api.enhanceImage(image.id))}
								title="AI upscale + sharpen. Keeps the photo exactly as it is."
								className={quick}
							>
								✦ Enhance (AI)
							</button>
							<button
								type="button"
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
								onClearSelection={() => {
									setSelection(null);
									setSelectedSegmentId(null);
									canvasRef.current?.clearMask();
								}}
								value={draft}
								onChange={setDraft}
								onSubmit={(t) => void submit(t)}
								busy={busy}
								lastPrompt={lastPrompt}
								wantsRegion={wantsRegion}
								hasMask={!!maskPngBase64}
								onInvertMask={() => canvasRef.current?.invertMask()}
								outpaintActive={editor.tool === "outpaint" && outpaintTotal > 0}
								selectedSegmentLabel={selectedSegment?.label ?? null}
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
								palettes={palettes}
								selectedPaletteIds={selectedPaletteIds}
								onTogglePalette={(id) =>
									setSelectedPaletteIds((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
								}
								onExtractPalette={() => void extractPaletteFromPhoto()}
								pendingChips={pendingChips}
								batchMode={batchMode}
								onToggleBatchMode={() => setBatchMode((v) => !v)}
								onDeleteChip={(id) => void deleteChip(id)}
								onApplyBatch={() => void applyBatchChips()}
								onEnhancePrompt={() => void enhancePromptText()}
								enhancingPrompt={enhancingPrompt}
								onQuickErase={() => {
									if (!selection) return;
									const box = selection;
									const label = selectedSegment?.label ?? "selected object";
									setSelection(null);
									setSelectedSegmentId(null);
									const maskB64 = maskPngBase64;
									canvasRef.current?.clearMask();
									void regionEdit(
										`Remove the ${label} cleanly and fill seamlessly with surrounding background textures`,
										box,
										maskB64,
										selectedSegment?.id ?? null,
									);
								}}
							/>
						)}
					</div>
				</aside>
			</div>

			{image && <ShareDialog imageId={image.id} open={shareOpen} onClose={() => setShareOpen(false)} />}
		</div>
	);
}
