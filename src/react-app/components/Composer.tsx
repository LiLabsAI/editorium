import { useRef, useState } from "react";

/** The chat bar: text + send. The single control surface of the editor. */
export function AskComposer({
	onSend,
	disabled,
	placeholder = "Ask Editorium",
}: {
	onSend: (text: string) => void;
	disabled?: boolean;
	placeholder?: string;
}) {
	const [text, setText] = useState("");
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
			<div className="flex items-center justify-end pt-1">
				<button
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
			</div>
		</div>
	);
}
