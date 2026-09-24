import { useCallback, useEffect, useRef, useState } from "react";

import { fileUrl, type ImageDto } from "../lib/api";
import { editorStore, useEditorState } from "../lib/store";
import { toNorm, type Bbox, type Rect } from "./geometry";

const FALLBACK = { width: 800, height: 1000 };
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

interface Rects {
	container: Rect;
	img: Rect;
}

/** The photo plane: fit/zoom/pan, nothing else. Input math runs through the
 * measured, transform-inclusive image rect (editor/geometry.ts). */
export function EditorCanvas({
	image,
	onRegionEdit,
	sourceUrl,
}: {
	image: ImageDto;
	onRegionEdit?: (rect: { x: number; y: number; w: number; h: number }, text: string) => void;
	/** Branch source photo URL — enables the before/after wipe (step 2). */
	sourceUrl?: string;
}) {
	const editor = useEditorState();
	const containerRef = useRef<HTMLDivElement>(null);
	const imgRef = useRef<HTMLImageElement>(null);
	const rectsRef = useRef<Rects>({
		container: { left: 0, top: 0, width: 0, height: 0 },
		img: { left: 0, top: 0, width: 0, height: 0 },
	});
	const [imgRect, setImgRect] = useState<Rect>({ left: 0, top: 0, width: 0, height: 0 });
	const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
	const panning = useRef(false);
	const [rect, setRect] = useState<Bbox | null>(null);
	const [text, setText] = useState("");
	const [compare, setCompare] = useState(false);
	const [wipe, setWipe] = useState(50);
	const drawing = useRef<{ x: number; y: number } | null>(null);

	const naturalWidth = image.widthPx || FALLBACK.width;
	const naturalHeight = image.heightPx || FALLBACK.height;

	useEffect(() => {
		const el = imgRef.current;
		const container = containerRef.current;
		if (!el || !container) return;
		const measure = () => {
			const r = el.getBoundingClientRect();
			const c = container.getBoundingClientRect();
			const img = { left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height };
			const cont = { left: c.left, top: c.top, width: c.width, height: c.height };
			rectsRef.current = { container: cont, img };
			setContainerSize((prev) =>
				prev.width === c.width && prev.height === c.height ? prev : { width: c.width, height: c.height },
			);
			setImgRect((prev) =>
				prev.left === img.left && prev.top === img.top && prev.width === img.width && prev.height === img.height
					? prev
					: img,
			);
		};
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		observer.observe(container);
		const unsubscribe = editorStore.subscribe(measure);
		return () => {
			observer.disconnect();
			unsubscribe();
		};
	}, []);

	const fit = useCallback(() => {
		const container = containerRef.current;
		if (!container) return;
		const scale = Math.max(
			Math.min(
				(container.clientWidth - 96) / naturalWidth,
				(container.clientHeight - 96) / naturalHeight,
				1,
			),
			MIN_ZOOM,
		);
		editorStore.set({
			zoom: scale,
			offset: {
				x: (container.clientWidth - naturalWidth * scale) / 2,
				y: (container.clientHeight - naturalHeight * scale) / 2,
			},
		});
	}, [naturalWidth, naturalHeight]);

	useEffect(() => {
		fit();
		const onResize = () => fit();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [fit]);

	// Wheel zoom anchored at the cursor.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const { container: cont, img } = rectsRef.current;
			if (img.width <= 0) return;
			const nx = (e.clientX - cont.left - img.left) / img.width;
			const ny = (e.clientY - cont.top - img.top) / img.height;
			const current = editorStore.get();
			const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
			const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor));
			editorStore.set({
				zoom,
				offset: {
					x: e.clientX - cont.left - nx * naturalWidth * zoom,
					y: e.clientY - cont.top - ny * naturalHeight * zoom,
				},
			});
		};
		container.addEventListener("wheel", onWheel, { passive: false });
		return () => container.removeEventListener("wheel", onWheel);
	}, [naturalWidth, naturalHeight]);

	// Left drag = draw an edit region. Alt/middle drag = pan.
	const onPointerDown = (e: React.PointerEvent) => {
		if (e.button !== 0 || e.altKey) {
			(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
			panning.current = true;
			const start = { x: e.clientX, y: e.clientY, ox: editorStore.get().offset.x, oy: editorStore.get().offset.y };
			const move = (ev: PointerEvent) => {
				if (!panning.current) return;
				editorStore.set({ offset: { x: start.ox + (ev.clientX - start.x), y: start.oy + (ev.clientY - start.y) } });
			};
			const up = () => {
				panning.current = false;
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			return;
		}
		const pt = normFromClient(e.clientX, e.clientY);
		if (!pt) return;
		(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
		drawing.current = pt;
		setRect({ x: pt.x, y: pt.y, w: 0.005, h: 0.005 });
	};

	/** Pointer → normalized image space, clamped to the photo so a drag past
	 * the edge still yields a valid 0..1 region. */
	function normFromClient(clientX: number, clientY: number) {
		const pt = toNorm(clientX, clientY, rectsRef.current.container, rectsRef.current.img);
		if (!pt) return null;
		const clamp = (v: number) => Math.min(1, Math.max(0, v));
		return { x: clamp(pt.x), y: clamp(pt.y) };
	}

	const onRegionPointerMove = (e: React.PointerEvent) => {
		if (!drawing.current) return;
		const pt = normFromClient(e.clientX, e.clientY);
		if (!pt) return;
		setRect({
			x: Math.min(drawing.current.x, pt.x),
			y: Math.min(drawing.current.y, pt.y),
			w: Math.abs(pt.x - drawing.current.x),
			h: Math.abs(pt.y - drawing.current.y),
		});
	};

	const onRegionPointerUp = () => {
		if (!drawing.current) return;
		drawing.current = null;
		setRect((r) => (r && r.w > 0.015 && r.h > 0.015 ? r : null));
	};

	async function submitRegion() {
		if (!rect || !text.trim()) return;
		onRegionEdit?.(rect, text.trim());
		setRect(null);
		setText("");
	}

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
			if (e.key === "0") fit();
			if (e.key === "+" || e.key === "=") editorStore.set({ zoom: Math.min(MAX_ZOOM, editorStore.get().zoom * 1.2) });
			if (e.key === "-") editorStore.set({ zoom: Math.max(MIN_ZOOM, editorStore.get().zoom / 1.2) });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [fit]);

	return (
		<div
			ref={containerRef}
			className="ed-canvas-bg relative min-h-0 flex-1 select-none overflow-hidden"
			style={{ cursor: "crosshair", touchAction: "none" }}
			onPointerDown={onPointerDown}
			onPointerMove={onRegionPointerMove}
			onPointerUp={onRegionPointerUp}
			role="application"
			aria-label="Photo viewer"
		>
			<div
				style={{
					transform: `translate(${editor.offset.x}px, ${editor.offset.y}px) scale(${editor.zoom})`,
					transformOrigin: "0 0",
					position: "absolute",
				}}
			>
				{rect && (
					<svg
						className="pointer-events-none absolute left-0 top-0"
						style={{ width: naturalWidth, height: naturalHeight }}
						viewBox="0 0 1 1"
						preserveAspectRatio="none"
					>
						<rect
							x={rect.x}
							y={rect.y}
							width={rect.w}
							height={rect.h}
							fill="rgba(99,120,255,0.10)"
							stroke="rgba(99,120,255,0.9)"
							strokeWidth={2}
							vectorEffect="non-scaling-stroke"
						/>
					</svg>
				)}
				<img
					ref={imgRef}
					src={fileUrl(image.id, "web", image.currentVersionId ?? undefined)}
					alt={image.filenameLabel}
					draggable={false}
					style={{ width: naturalWidth, height: naturalHeight, maxWidth: "none" }}
					className="rounded-sm shadow-2xl"
				/>
				{compare && sourceUrl && (
					<img
						src={sourceUrl}
						alt="Before"
						draggable={false}
						style={{
							width: naturalWidth,
							height: naturalHeight,
							maxWidth: "none",
							clipPath: `inset(0 ${100 - wipe}% 0 0)`,
						}}
						className="pointer-events-none absolute left-0 top-0 select-none"
					/>
				)}
				{compare && sourceUrl && (
					<div
						className="pointer-events-none absolute top-0 h-full w-0.5 bg-white shadow"
						style={{ left: `${wipe}%` }}
					/>
				)}
			</div>
			{/* Describe input at the drawn region */}
			{rect && (
				<div
					className="absolute z-20 w-72 rounded-xl border ed-hairline bg-card p-2 shadow-2xl"
					style={{
						// Anchor at the selection's bottom-right, clamped to the
						// visible container (not the possibly-zoomed image).
						left: Math.max(8, Math.min((rect.x + rect.w) * imgRect.width + imgRect.left, containerSize.width - 296)),
						top: Math.max(8, Math.min((rect.y + rect.h) * imgRect.height + imgRect.top + 8, containerSize.height - 140)),
					}}
					onPointerDown={(e) => e.stopPropagation()}
				>
					<textarea
						autoFocus
						rows={2}
						value={text}
						placeholder="Describe edits"
						aria-label="Describe edits"
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								submitRegion();
							}
							if (e.key === "Escape") {
								setRect(null);
								setText("");
							}
						}}
						className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
					/>
					<div className="flex items-center justify-end gap-1.5 pt-1">
						<button
							aria-label="Cancel region edit"
							onClick={() => {
								setRect(null);
								setText("");
							}}
							className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
						>
							Cancel
						</button>
						<button
							aria-label="Apply region edit"
							title="Apply"
							disabled={!text.trim()}
							onClick={submitRegion}
							className="flex size-7 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-30"
						>
							↑
						</button>
					</div>
				</div>
			)}
			{sourceUrl && (
				<div
					className="absolute bottom-4 right-4 flex items-center gap-2 rounded-full bg-black/65 px-3 py-1.5"
					// Controls sit over the canvas: don't let a click here start
					// a region draw (pointer capture would swallow the click).
					onPointerDown={(e) => e.stopPropagation()}
				>
					<button
						aria-pressed={compare}
						onClick={() => setCompare((v) => !v)}
						className={`rounded-full px-3 py-1 text-xs font-medium transition ${
							compare ? "bg-foreground text-background" : "text-white/85 hover:text-white"
						}`}
					>
						Compare
					</button>
					{compare && (
						<input
							aria-label="Before after wipe"
							type="range"
							min={0}
							max={100}
							value={wipe}
							onChange={(e) => setWipe(Number(e.target.value))}
							className="w-32 accent-[rgba(99,120,255,0.95)]"
						/>
					)}
				</div>
			)}
			<div className="pointer-events-none absolute bottom-4 left-4 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white/85">
				{Math.round(editor.zoom * 100)}% · drag to select a region · scroll to zoom · Alt+drag to pan
			</div>
			{imgRect.width === 0 && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
					Loading photo…
				</div>
			)}
		</div>
	);
}
