import { useState } from "react";

import { api, describeError, segmentCropUrl, type SegmentDto } from "../lib/api";

/** Collapsible detected & custom mask layers panel with lock, hide, erase & BiRefNet subject mask. */
export function LayersDrawer({
	imageId,
	segments,
	segmentStatus,
	selectedId,
	showOnCanvas,
	onToggleShowOnCanvas,
	onSelectSegment,
	onSegmentsUpdated,
	onSelectSubject,
	onResegment,
	onQuickErase,
	busy,
	subjectBusy,
}: {
	imageId: string;
	segments: SegmentDto[];
	segmentStatus: string;
	selectedId: string | null;
	showOnCanvas: boolean;
	onToggleShowOnCanvas: () => void;
	onSelectSegment: (seg: SegmentDto) => void;
	onSegmentsUpdated: () => Promise<void>;
	onSelectSubject: () => void;
	onResegment: () => void;
	onQuickErase: (seg: SegmentDto) => void;
	busy?: boolean;
	subjectBusy?: boolean;
}) {
	const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
	const [promptDraft, setPromptDraft] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function toggleLock(seg: SegmentDto) {
		try {
			await api.patchSegment(seg.id, { locked: !seg.lockedAt });
			await onSegmentsUpdated();
		} catch (err) {
			setError(describeError(err));
		}
	}

	async function toggleHidden(seg: SegmentDto) {
		try {
			await api.patchSegment(seg.id, { hidden: !seg.hiddenAt });
			await onSegmentsUpdated();
		} catch (err) {
			setError(describeError(err));
		}
	}

	async function removeSeg(seg: SegmentDto) {
		try {
			await api.deleteSegment(seg.id);
			await onSegmentsUpdated();
		} catch (err) {
			setError(describeError(err));
		}
	}

	async function savePrompt(segId: string) {
		const trimmed = promptDraft.trim();
		if (!trimmed) return;
		try {
			await api.segmentPrompt(segId, trimmed);
			setEditingPromptId(null);
			setPromptDraft("");
			await onSegmentsUpdated();
		} catch (err) {
			setError(describeError(err));
		}
	}

	const visible = segments.filter((s) => !s.deletedAt);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3 text-xs">
			<div className="mb-2 flex items-center justify-between gap-2">
				<span className="text-sm font-semibold">Layers & Regions</span>
				<label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
					<input
						type="checkbox"
						checked={showOnCanvas}
						onChange={onToggleShowOnCanvas}
						className="accent-indigo-400"
					/>
					Show boxes
				</label>
			</div>

			<div className="mb-3 flex flex-wrap gap-1.5">
				<button
					type="button"
					disabled={busy || subjectBusy}
					onClick={onSelectSubject}
					className="rounded-full bg-indigo-500/20 px-3 py-1 font-medium text-indigo-200 transition hover:bg-indigo-500/30 disabled:opacity-40"
				>
					{subjectBusy ? "Extracting subject…" : "✨ Select subject"}
				</button>
				<button
					type="button"
					disabled={busy || segmentStatus === "pending"}
					onClick={onResegment}
					className="rounded-full border ed-hairline px-2.5 py-1 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
				>
					{segmentStatus === "pending" ? "Recognizing…" : "Re-recognize"}
				</button>
			</div>

			{error && (
				<p role="alert" className="mb-2 text-red-300">
					{error}
				</p>
			)}

			{visible.length === 0 ? (
				<p className="py-6 text-center text-muted-foreground">
					{segmentStatus === "pending"
						? "Detecting objects and regions…"
						: "No regions detected yet. Use Select Subject, Lasso, or Magic Wand."}
				</p>
			) : (
				<ul className="space-y-2" data-image-id={imageId}>
					{visible.map((seg) => {
						const isSelected = seg.id === selectedId;
						const isChild = Boolean(seg.parentSegmentId);
						return (
							<li
								key={seg.id}
								className={`rounded-xl border p-2 transition ${
									isChild ? "ml-4" : ""
								} ${isSelected ? "border-indigo-400 bg-indigo-500/10" : "ed-hairline bg-secondary/35"}`}
							>
								<div className="flex items-start gap-2">
									<button
										type="button"
										onClick={() => onSelectSegment(seg)}
										className="flex min-w-0 flex-1 items-start gap-2 text-left"
									>
										<img
											src={segmentCropUrl(seg.id)}
											alt=""
											onError={(e) => {
												e.currentTarget.style.display = "none";
											}}
											className="size-9 shrink-0 rounded-md bg-black/40 object-cover"
										/>
										<div className="min-w-0 flex-1">
											<p className="truncate font-medium capitalize">
												{seg.label}
												{seg.maskR2Key ? " · mask" : ""}
											</p>
											{seg.caption && (
												<p className="line-clamp-2 text-[11px] text-muted-foreground">{seg.caption}</p>
											)}
										</div>
									</button>
									<div className="flex shrink-0 items-center gap-0.5">
										<button
											type="button"
											title={seg.lockedAt ? "Unlock layer" : "Lock layer"}
											aria-label={`${seg.lockedAt ? "Unlock" : "Lock"} ${seg.label}`}
											aria-pressed={!!seg.lockedAt}
											onClick={() => void toggleLock(seg)}
											className="rounded p-1 hover:bg-muted"
										>
											{seg.lockedAt ? "🔒" : "🔓"}
										</button>
										<button
											type="button"
											title={seg.hiddenAt ? "Show box" : "Hide box"}
											aria-label={`${seg.hiddenAt ? "Show" : "Hide"} ${seg.label}`}
											aria-pressed={!!seg.hiddenAt}
											onClick={() => void toggleHidden(seg)}
											className="rounded p-1 hover:bg-muted"
										>
											{seg.hiddenAt ? "🚫" : "👁"}
										</button>
										<button
											type="button"
											title="Remove layer"
											aria-label={`Remove ${seg.label}`}
											onClick={() => void removeSeg(seg)}
											className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-300"
										>
											×
										</button>
									</div>
								</div>

								{isSelected && (
									<div className="mt-2 flex flex-wrap items-center gap-1.5 border-t ed-hairline pt-2">
										<button
											type="button"
											disabled={busy || !!seg.lockedAt}
											onClick={() => onQuickErase(seg)}
											className="rounded-full border ed-hairline px-2.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-40"
										>
											🧽 Generative erase
										</button>
										<button
											type="button"
											onClick={() => setEditingPromptId((v) => (v === seg.id ? null : seg.id))}
											className="rounded-full border ed-hairline px-2.5 py-0.5 text-[11px] hover:bg-muted"
										>
											Save note
										</button>
									</div>
								)}
								{editingPromptId === seg.id && (
									<div className="mt-2 flex gap-1">
										<input
											value={promptDraft}
											onChange={(e) => setPromptDraft(e.target.value)}
											placeholder="Pinned edit prompt…"
											className="min-w-0 flex-1 rounded-lg border ed-hairline bg-card px-2 py-1 text-[11px] outline-none focus:border-ring"
										/>
										<button
											type="button"
											onClick={() => void savePrompt(seg.id)}
											className="rounded-lg bg-foreground px-2 py-1 text-[11px] text-background"
										>
											Save
										</button>
									</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
