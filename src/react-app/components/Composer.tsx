import { useRef, useState } from "react";

import { referenceFileUrl, type ReferenceDto } from "../lib/api";

export interface AttachedTarget {
	id: string;
	label: string;
	thumbUrl: string;
}

/** Album chat bar: attachment chip + optional @reference pills + prompt + send/stop. */
export function AskComposer({
	onSend,
	onAbort,
	disabled,
	streaming,
	placeholder = "Ask Editorium or describe an edit…",
	attachment,
	onClearAttachment,
	references = [],
	selectedRefIds = [],
	onToggleRef,
}: {
	onSend: (text: string) => void;
	onAbort?: () => void;
	disabled?: boolean;
	streaming?: boolean;
	placeholder?: string;
	attachment?: AttachedTarget | null;
	onClearAttachment?: () => void;
	references?: ReferenceDto[];
	selectedRefIds?: string[];
	onToggleRef?: (id: string) => void;
}) {
	const [text, setText] = useState("");
	const [refsOpen, setRefsOpen] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	function submit() {
		const value = text.trim();
		if (!value || disabled) return;
		onSend(value);
		setText("");
		inputRef.current?.focus();
	}

	return (
		<div className="rounded-2xl border ed-hairline bg-card p-3 shadow-lg">
			{(attachment || selectedRefIds.length > 0) && (
				<div className="mb-2 flex flex-wrap items-center gap-1.5">
					{attachment && (
						<span className="inline-flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pl-1 pr-2 text-xs">
							<img src={attachment.thumbUrl} alt="" className="size-4 rounded-full object-cover" />
							<span className="max-w-36 truncate">{attachment.label}</span>
							{onClearAttachment && (
								<button
									type="button"
									aria-label="Detach photo"
									onClick={onClearAttachment}
									className="text-muted-foreground hover:text-foreground"
								>
									×
								</button>
							)}
						</span>
					)}
					{selectedRefIds.map((rid) => {
						const ref = references.find((r) => r.id === rid);
						if (!ref) return null;
						return (
							<span key={rid} className="inline-flex items-center gap-1 rounded-full bg-indigo-500/20 py-0.5 pl-1 pr-2 text-xs text-indigo-200">
								<img src={referenceFileUrl(rid, "thumb")} alt="" className="size-4 rounded-full object-cover" />
								<span className="max-w-28 truncate">{ref.title}</span>
								<button
									type="button"
									aria-label={`Remove reference ${ref.title}`}
									onClick={() => onToggleRef?.(rid)}
									className="hover:text-white"
								>
									×
								</button>
							</span>
						);
					})}
				</div>
			)}

			{refsOpen && references.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-1.5 border-b ed-hairline pb-2">
					{references.map((ref) => {
						const active = selectedRefIds.includes(ref.id);
						return (
							<button
								key={ref.id}
								type="button"
								onClick={() => onToggleRef?.(ref.id)}
								aria-pressed={active}
								className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition ${
									active
										? "border-indigo-400 bg-indigo-500/20 text-foreground"
										: "ed-hairline bg-secondary/40 text-muted-foreground hover:text-foreground"
								}`}
							>
								<img src={referenceFileUrl(ref.id, "thumb")} alt="" className="size-5 rounded object-cover" />
								<span className="max-w-28 truncate">{ref.title}</span>
							</button>
						);
					})}
				</div>
			)}

			<textarea
				ref={inputRef}
				rows={2}
				value={text}
				placeholder={placeholder}
				aria-label={placeholder}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						submit();
					}
				}}
				className="w-full resize-none bg-transparent px-1 text-[15px] outline-none placeholder:text-muted-foreground"
			/>
			<div className="flex items-center justify-between pt-1">
				<div className="flex items-center gap-1.5">
					{references.length > 0 && onToggleRef && (
						<button
							type="button"
							onClick={() => setRefsOpen((v) => !v)}
							aria-expanded={refsOpen}
							className="rounded-full border ed-hairline px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
						>
							+ References {selectedRefIds.length > 0 ? `(${selectedRefIds.length})` : ""}
						</button>
					)}
				</div>
				<div className="flex items-center gap-2">
					{streaming && onAbort ? (
						<button
							type="button"
							aria-label="Stop response"
							onClick={onAbort}
							className="flex h-9 items-center rounded-full border ed-hairline px-3 text-xs font-medium transition hover:bg-muted"
						>
							Stop
						</button>
					) : (
						<button
							type="button"
							aria-label="Send message"
							title="Send"
							disabled={!text.trim() || disabled}
							onClick={submit}
							className="flex size-9 items-center justify-center rounded-full bg-foreground text-background transition hover:opacity-85 disabled:opacity-30"
						>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
								<path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
							</svg>
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
