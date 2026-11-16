import { useEffect, useRef, useState } from "react";

import {
	fileUrl,
	referenceFileUrl,
	type Box,
	type EditInstructionDto,
	type PaletteDto,
	type ReferenceDto,
} from "../lib/api";
import { composerMode, regionWords, singleTarget } from "../lib/history";

function parseColors(json: string): string[] {
	try {
		const parsed = JSON.parse(json) as unknown;
		return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
	} catch {
		return [];
	}
}

/**
 * The editor's single entry point (phase 5 + depth upgrades): shows active
 * photo, region/mask selection, references, palette swatches, batch chip queue,
 * prompt enhance, generative erase, and honest mode + credit cost preview.
 */
export function EditComposer({
	imageId,
	imageLabel,
	selection,
	onClearSelection,
	value,
	onChange,
	onSubmit,
	busy,
	lastPrompt,
	wantsRegion,
	hasMask = false,
	onInvertMask,
	outpaintActive = false,
	selectedSegmentLabel,
	references = [],
	selectedRefIds = [],
	onToggleRef,
	palettes = [],
	selectedPaletteIds = [],
	onTogglePalette,
	onExtractPalette,
	pendingChips = [],
	batchMode = false,
	onToggleBatchMode,
	onDeleteChip,
	onApplyBatch,
	onEnhancePrompt,
	enhancingPrompt = false,
	onQuickErase,
}: {
	imageId: string;
	imageLabel: string;
	selection: Box | null;
	onClearSelection: () => void;
	value: string;
	onChange: (text: string) => void;
	onSubmit: (text: string) => void;
	busy: boolean;
	lastPrompt: string | null;
	/** Set by "Redo on a region": nudge to draw a box before sending. */
	wantsRegion: boolean;
	hasMask?: boolean;
	onInvertMask?: () => void;
	outpaintActive?: boolean;
	selectedSegmentLabel?: string | null;
	references?: ReferenceDto[];
	selectedRefIds?: string[];
	onToggleRef?: (id: string) => void;
	palettes?: PaletteDto[];
	selectedPaletteIds?: string[];
	onTogglePalette?: (id: string) => void;
	onExtractPalette?: () => void;
	pendingChips?: EditInstructionDto[];
	batchMode?: boolean;
	onToggleBatchMode?: () => void;
	onDeleteChip?: (id: string) => void;
	onApplyBatch?: () => void;
	onEnhancePrompt?: () => void;
	enhancingPrompt?: boolean;
	onQuickErase?: () => void;
}) {
	const input = useRef<HTMLTextAreaElement>(null);
	const [toolsOpen, setToolsOpen] = useState(false);

	const mode = composerMode(value, !!selection, {
		hasMask,
		hasOutpaint: outpaintActive,
		hasRefs: selectedRefIds.length > 0,
	});
	const target = selection || hasMask || outpaintActive ? null : singleTarget(value);

	useEffect(() => {
		if (wantsRegion || selection) input.current?.focus();
	}, [wantsRegion, selection]);

	function submit() {
		const text = value.trim();
		if (!text || busy) return;
		onSubmit(text);
	}

	const regionBadgePrefix = hasMask ? "Mask" : selectedSegmentLabel ? selectedSegmentLabel : "Box";

	return (
		<div className="rounded-2xl border ed-hairline bg-card p-3 shadow-lg">
			{/* Context pills */}
			<div className="mb-2 flex flex-wrap items-center gap-1.5">
				<span className="flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pl-0.5 pr-2 text-[11px] text-muted-foreground">
					<img src={fileUrl(imageId, "thumb")} alt="" className="size-5 rounded-full object-cover" />
					<span className="max-w-[140px] truncate">{imageLabel}</span>
				</span>
				{selection ? (
					<span className="flex items-center gap-1 rounded-full bg-[rgba(99,120,255,0.18)] px-2 py-0.5 text-[11px] text-[rgb(170,180,255)]">
						{regionBadgePrefix} · {regionWords(selection)}
						{hasMask && onInvertMask && (
							<button
								type="button"
								onClick={onInvertMask}
								title="Invert selection mask"
								className="ml-1 rounded px-1 text-[10px] hover:bg-white/15 hover:text-white"
							>
								Invert
							</button>
						)}
						<button
							type="button"
							onClick={onClearSelection}
							aria-label="Clear selected region"
							className="ml-0.5 hover:text-white"
						>
							×
						</button>
					</span>
				) : (
					wantsRegion && (
						<span className="rounded-full bg-[rgba(255,196,64,0.15)] px-2 py-0.5 text-[11px] text-amber-200">
							Draw a box on the photo first
						</span>
					)
				)}
				{selectedRefIds.map((rid) => {
					const ref = references.find((r) => r.id === rid);
					if (!ref) return null;
					return (
						<span key={rid} className="inline-flex items-center gap-1 rounded-full bg-indigo-500/20 py-0.5 pl-1 pr-2 text-[11px] text-indigo-200">
							<img src={referenceFileUrl(rid, "thumb")} alt="" className="size-4 rounded-full object-cover" />
							<span className="max-w-24 truncate">{ref.title}</span>
							<button type="button" onClick={() => onToggleRef?.(rid)} className="hover:text-white">
								×
							</button>
						</span>
					);
				})}
			</div>

			{/* Pending batch chips */}
			{pendingChips.length > 0 && (
				<div className="mb-2 space-y-1.5 rounded-xl border ed-hairline bg-secondary/40 p-2">
					<div className="flex items-center justify-between text-[11px]">
						<span className="font-medium text-foreground/90">Queued edits ({pendingChips.length}/5)</span>
						{onApplyBatch && (
							<button
								type="button"
								disabled={busy}
								onClick={onApplyBatch}
								className="rounded-full bg-indigo-500 px-2.5 py-0.5 font-medium text-white transition hover:bg-indigo-400 disabled:opacity-40"
							>
								Apply all (2 credits)
							</button>
						)}
					</div>
					<div className="flex flex-wrap gap-1">
						{pendingChips.map((chip) => (
							<span key={chip.id} className="inline-flex items-center gap-1 rounded-full border ed-hairline bg-card px-2 py-0.5 text-[11px]">
								<span className="max-w-44 truncate">{chip.text}</span>
								<button
									type="button"
									aria-label={`Remove chip ${chip.text}`}
									onClick={() => onDeleteChip?.(chip.id)}
									className="text-muted-foreground hover:text-foreground"
								>
									×
								</button>
							</span>
						))}
					</div>
				</div>
			)}

			{/* Quick creative bar: References + Palette + Erase + Enhance + Batch toggle */}
			{(onEnhancePrompt || onQuickErase || onToggleBatchMode || references.length > 0 || onExtractPalette) && (
				<div className="mb-1.5 flex flex-wrap items-center gap-1">
					{(selection || hasMask) && onQuickErase && (
						<button
							type="button"
							disabled={busy}
							onClick={onQuickErase}
							title="Remove selected object cleanly (2 credits)"
							className="rounded-full border ed-hairline px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
						>
							🧽 Erase object
						</button>
					)}
					{selection && onToggleBatchMode && (
						<button
							type="button"
							aria-pressed={batchMode}
							onClick={onToggleBatchMode}
							title="Queue multiple region chips before running 1 AI pass"
							className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
								batchMode
									? "border-indigo-400 bg-indigo-500/20 text-indigo-200"
									: "ed-hairline text-muted-foreground hover:bg-muted hover:text-foreground"
							}`}
						>
							{batchMode ? "Batch queue ON" : "+ Queue chip"}
						</button>
					)}
					{onEnhancePrompt && value.trim().length >= 3 && (
						<button
							type="button"
							disabled={busy || enhancingPrompt}
							onClick={onEnhancePrompt}
							title="Rewrite prompt for higher fidelity AI results"
							className="rounded-full border ed-hairline px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
						>
							{enhancingPrompt ? "Refining…" : "✨ Enhance prompt"}
						</button>
					)}
					{(references.length > 0 || palettes.length > 0 || onExtractPalette) && (
						<button
							type="button"
							aria-expanded={toolsOpen}
							onClick={() => setToolsOpen((v) => !v)}
							className="ml-auto rounded-full border ed-hairline px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
						>
							Style & Colors
						</button>
					)}
				</div>
			)}

			{toolsOpen && (
				<div className="mb-2 space-y-2 rounded-xl border ed-hairline bg-secondary/35 p-2 text-[11px]">
					{references.length > 0 && onToggleRef && (
						<div>
							<p className="mb-1 text-muted-foreground">Attach reference (max 3)</p>
							<div className="flex flex-wrap gap-1">
								{references.map((ref) => {
									const active = selectedRefIds.includes(ref.id);
									return (
										<button
											key={ref.id}
											type="button"
											onClick={() => onToggleRef(ref.id)}
											aria-pressed={active}
											className={`flex items-center gap-1 rounded-lg border px-1.5 py-0.5 ${
												active ? "border-indigo-400 bg-indigo-500/20" : "ed-hairline bg-card/60"
											}`}
										>
											<img src={referenceFileUrl(ref.id, "thumb")} alt="" className="size-4 rounded object-cover" />
											<span className="max-w-24 truncate">{ref.title}</span>
										</button>
									);
								})}
							</div>
						</div>
					)}
					{(palettes.length > 0 || onExtractPalette) && (
						<div>
							<div className="mb-1 flex items-center justify-between">
								<span className="text-muted-foreground">Color palettes</span>
								{onExtractPalette && (
									<button type="button" onClick={onExtractPalette} className="text-indigo-300 hover:underline">
										Extract from photo
									</button>
								)}
							</div>
							<div className="flex flex-wrap gap-1.5">
								{palettes.map(({ palette }) => {
									const active = selectedPaletteIds.includes(palette.id);
									const colors = parseColors(palette.colorsJson);
									return (
										<button
											key={palette.id}
											type="button"
											onClick={() => onTogglePalette?.(palette.id)}
											aria-pressed={active}
											className={`flex items-center gap-0.5 rounded-full border px-1.5 py-1 ${
												active ? "border-indigo-400 bg-indigo-500/20" : "ed-hairline bg-card/60"
											}`}
										>
											{colors.map((hex) => (
												<span key={hex} className="size-3 rounded-full" style={{ backgroundColor: hex }} title={hex} />
											))}
										</button>
									);
								})}
							</div>
						</div>
					)}
				</div>
			)}

			<textarea
				ref={input}
				rows={2}
				value={value}
				placeholder={
					outpaintActive
						? "Optional: describe what to generate in the extended border…"
						: selection
							? batchMode
								? "Add change for this region as a chip…"
								: "Describe the change to the selected area…"
							: "Describe a change or ask about this photo…"
				}
				aria-label="Describe a change or ask a question"
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						submit();
					} else if (e.key === "ArrowUp" && !value && lastPrompt) {
						e.preventDefault();
						onChange(lastPrompt);
					} else if (e.key === "Escape" && selection) {
						onClearSelection();
					}
				}}
				className="w-full resize-none bg-transparent px-1 text-[15px] outline-none placeholder:text-muted-foreground"
			/>
			{target && (
				<p className="mb-1 rounded-lg bg-[rgba(255,196,64,0.12)] px-2 py-1.5 text-[11px] leading-snug text-amber-100">
					This reimagines the whole photo. To change only {target}, draw a box around it first.
				</p>
			)}
			<div className="flex items-center justify-between gap-2 pt-1">
				<p className="min-w-0 text-[11px] leading-snug text-muted-foreground">
					<span className="text-foreground/90">{batchMode && selection ? "Queue edit chip" : mode.label}</span> ·{" "}
					{batchMode && selection ? "batched into 1 pass (2 credits total)" : mode.detail}
				</p>
				<button
					type="button"
					aria-label="Send"
					title={batchMode && selection ? "Add chip (Enter)" : "Send (Enter)"}
					disabled={!value.trim() || busy}
					onClick={submit}
					className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition hover:opacity-85 disabled:opacity-30"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
						<path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</button>
			</div>
		</div>
	);
}
