import { useEffect, useRef } from "react";

import { fileUrl, type Box } from "../lib/api";
import { composerMode, regionWords, singleTarget } from "../lib/history";

/**
 * The editor's single entry point (phase 5). It always shows what the next
 * message acts on — which photo, which region — and what will happen, so a
 * whole-photo reimagine is never a surprise.
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
}) {
	const input = useRef<HTMLTextAreaElement>(null);
	const mode = composerMode(value, !!selection);
	const target = selection ? null : singleTarget(value);

	useEffect(() => {
		if (wantsRegion || selection) input.current?.focus();
	}, [wantsRegion, selection]);

	function submit() {
		const text = value.trim();
		if (!text || busy) return;
		onSubmit(text);
	}

	return (
		<div className="rounded-2xl border ed-hairline bg-card p-3 shadow-lg">
			<div className="mb-2 flex flex-wrap items-center gap-1.5">
				<span className="flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pl-0.5 pr-2 text-[11px] text-muted-foreground">
					<img src={fileUrl(imageId, "thumb")} alt="" className="size-5 rounded-full object-cover" />
					<span className="max-w-[140px] truncate">{imageLabel}</span>
				</span>
				{selection ? (
					<span className="flex items-center gap-1 rounded-full bg-[rgba(99,120,255,0.18)] px-2 py-0.5 text-[11px] text-[rgb(170,180,255)]">
						Box · {regionWords(selection)}
						<button onClick={onClearSelection} aria-label="Clear selected region" className="ml-0.5 hover:text-white">
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
			</div>
			<textarea
				ref={input}
				rows={2}
				value={value}
				placeholder={selection ? "Describe the change to the selected area…" : "Describe a change or ask about this photo…"}
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
					<span className="text-foreground/90">{mode.label}</span> · {mode.detail}
				</p>
				<button
					aria-label="Send"
					title="Send (Enter)"
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
