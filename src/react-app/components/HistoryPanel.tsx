import { useEffect, useRef, useState } from "react";

import { fileUrl, type Box, type HistoryTurn } from "../lib/api";
import {
	canRetry,
	CLASS_LABEL,
	CLASS_PROMISE,
	isPending,
	matchesFilter,
	PENDING_LABEL,
	regionWords,
	type HistoryFilter,
} from "../lib/history";

/** A reply still streaming in (chat answers) before it is persisted. */
export interface LiveTurn {
	text: string;
	reply: string;
}

/**
 * The photo family's history (phase 5): every request and its reply, oldest
 * first, newest pinned to the bottom. State comes from the server, so it is
 * the same after a reload or in another tab.
 */
export function HistoryPanel({
	turns,
	live,
	currentImageId,
	onOpen,
	onRetry,
	onEditPrompt,
	onRegionize,
	onHighlight,
}: {
	turns: HistoryTurn[];
	live: LiveTurn | null;
	currentImageId: string;
	onOpen: (imageId: string) => void;
	onRetry: (turn: HistoryTurn) => void;
	onEditPrompt: (text: string) => void;
	onRegionize: (text: string) => void;
	onHighlight: (boxes: Box[]) => void;
}) {
	const [filter, setFilter] = useState<HistoryFilter>("all");
	const scroller = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);
	const visible = turns.filter((t) => matchesFilter(t, filter));
	const onlyOriginal = turns.every((t) => t.derived && t.request.opClass === "upload");

	// Stick to the bottom only if the user hasn't scrolled up to read.
	useEffect(() => {
		const el = scroller.current;
		if (el && atBottom.current) el.scrollTop = el.scrollHeight;
	}, [turns, live, filter]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center justify-between px-4 pb-2 pt-4">
				<h2 className="text-sm font-semibold">History</h2>
				<div className="flex gap-1" role="group" aria-label="Filter history">
					{(["all", "edits", "chat"] as const).map((f) => (
						<button
							key={f}
							aria-pressed={filter === f}
							onClick={() => setFilter(f)}
							className={`rounded-full px-2.5 py-0.5 text-xs capitalize transition ${
								filter === f ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"
							}`}
						>
							{f}
						</button>
					))}
				</div>
			</div>
			<div
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
				}}
				className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-3"
				role="log"
				aria-live="polite"
				aria-label="Edit history"
			>
				{onlyOriginal && <Tips />}
				{visible.map((turn) => (
					<TurnView
						key={turn.id}
						turn={turn}
						currentImageId={currentImageId}
						onOpen={onOpen}
						onRetry={onRetry}
						onEditPrompt={onEditPrompt}
						onRegionize={onRegionize}
						onHighlight={onHighlight}
					/>
				))}
				{live && (
					<div className="space-y-1.5">
						<RequestBubble text={live.text} chip={null} />
						<p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
							{live.reply || <Pending label="Thinking…" />}
						</p>
					</div>
				)}
				{visible.length === 0 && !onlyOriginal && (
					<p className="py-6 text-center text-xs text-muted-foreground">Nothing here yet for this filter.</p>
				)}
			</div>
		</div>
	);
}

function Tips() {
	return (
		<div className="rounded-xl border ed-hairline px-3 py-3 text-xs leading-relaxed text-muted-foreground">
			<p className="mb-2 text-sm text-foreground">Every result is a new photo beside the original.</p>
			<ul className="space-y-1.5">
				<li>
					<span className="text-foreground">Drag a box</span> on the photo, then describe the change — everything outside it stays pixel-for-pixel.
				</li>
				<li>
					<span className="text-foreground">Enhance</span> and <span className="text-foreground">Remove background</span> keep the photo as it is.
				</li>
				<li>
					<span className="text-foreground">Type without a box</span> to reimagine the whole photo, or ask a question about it.
				</li>
			</ul>
		</div>
	);
}

function RequestBubble({ text, chip }: { text: string; chip: string | null }) {
	return (
		<div className="ml-8 rounded-2xl bg-secondary px-3 py-2 text-sm">
			<p className="whitespace-pre-wrap break-words">{text}</p>
			{chip && <p className="mt-1 text-[11px] text-muted-foreground">{chip}</p>}
		</div>
	);
}

function Pending({ label }: { label: string }) {
	return (
		<span className="inline-flex items-center gap-2 text-xs text-muted-foreground" role="status">
			<span className="size-3 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
			{label}
		</span>
	);
}

function TurnView({
	turn,
	currentImageId,
	onOpen,
	onRetry,
	onEditPrompt,
	onRegionize,
	onHighlight,
}: {
	turn: HistoryTurn;
	currentImageId: string;
	onOpen: (imageId: string) => void;
	onRetry: (turn: HistoryTurn) => void;
	onEditPrompt: (text: string) => void;
	onRegionize: (text: string) => void;
	onHighlight: (boxes: Box[]) => void;
}) {
	const { request, reply } = turn;
	const cls = request.opClass;

	if (cls === "upload") {
		return (
			<ResultRow
				imageId={reply.result?.imageId ?? null}
				current={reply.result?.imageId === currentImageId}
				title="Original photo"
				meta="Uploaded"
				onOpen={onOpen}
			/>
		);
	}

	const region = request.bboxes.length ? ` · ${request.bboxes.map(regionWords).join(", ")}` : "";
	const chip = cls && cls !== "answer" ? `${CLASS_LABEL[cls]}${region}` : null;

	return (
		<div
			className="space-y-1.5"
			onMouseEnter={() => request.bboxes.length && onHighlight(request.bboxes)}
			onMouseLeave={() => request.bboxes.length && onHighlight([])}
		>
			<RequestBubble text={request.text} chip={chip} />
			{isPending(turn) ? (
				<Pending label={(cls && PENDING_LABEL[cls]) ?? "Working…"} />
			) : reply.status === "error" ? (
				<div className="rounded-xl border border-red-400/40 px-3 py-2 text-xs">
					<p className="text-sm text-red-300">{reply.error}</p>
					{reply.refunded && <p className="mt-0.5 text-muted-foreground">{reply.credits} credits refunded</p>}
					<Actions>
						{canRetry(turn) && <Action onClick={() => onRetry(turn)}>Retry</Action>}
						<Action onClick={() => onEditPrompt(request.text)}>Edit prompt</Action>
					</Actions>
				</div>
			) : reply.result ? (
				<ResultRow
					imageId={reply.result.exists ? reply.result.imageId : null}
					current={reply.result.imageId === currentImageId}
					title={reply.result.exists ? reply.result.label : "Photo deleted"}
					meta={[
						cls ? CLASS_PROMISE[cls] : null,
						reply.result.fidelity !== null ? `fidelity ${reply.result.fidelity.toFixed(2)}` : null,
						reply.credits ? `${reply.credits} credits` : null,
					]
						.filter(Boolean)
						.join(" · ")}
					onOpen={onOpen}
				>
					{canRetry(turn) && <Action onClick={() => onRetry(turn)}>Retry</Action>}
					{cls === "reimagine" && <Action onClick={() => onRegionize(request.text)}>Redo on a region</Action>}
					{!turn.derived && cls !== "adjust" && <Action onClick={() => onEditPrompt(request.text)}>Edit prompt</Action>}
				</ResultRow>
			) : (
				<p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{reply.text}</p>
			)}
		</div>
	);
}

function ResultRow({
	imageId,
	current,
	title,
	meta,
	onOpen,
	children,
}: {
	imageId: string | null;
	current: boolean;
	title: string;
	meta: string;
	onOpen: (imageId: string) => void;
	children?: React.ReactNode;
}) {
	return (
		<div className={`flex gap-3 rounded-xl border px-2.5 py-2 ${current ? "border-[rgba(99,120,255,0.7)]" : "ed-hairline"}`}>
			{imageId ? (
				<button onClick={() => onOpen(imageId)} className="shrink-0 overflow-hidden rounded-lg" aria-label={`Open ${title}`}>
					<img src={fileUrl(imageId, "thumb")} alt="" loading="lazy" className="size-12 object-cover" />
				</button>
			) : (
				<div className="size-12 shrink-0 rounded-lg bg-secondary" aria-hidden />
			)}
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm">{title}</p>
				<p className="text-[11px] text-muted-foreground">{current ? `Viewing · ${meta}` : meta}</p>
				<Actions>
					{imageId && !current && <Action onClick={() => onOpen(imageId)}>Open</Action>}
					{children}
				</Actions>
			</div>
		</div>
	);
}

function Actions({ children }: { children: React.ReactNode }) {
	return <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">{children}</div>;
}

function Action({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
	return (
		<button onClick={onClick} className="text-xs text-[rgb(140,155,255)] hover:underline">
			{children}
		</button>
	);
}
