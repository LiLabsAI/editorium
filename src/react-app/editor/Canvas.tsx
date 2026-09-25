import { useCallback, useEffect, useRef, useState } from "react";

import { fileUrl, type ImageDto } from "../lib/api";
import { editorStore, useEditorState } from "../lib/store";
import { toNorm, type Bbox, type Rect } from "./geometry";

const FALLBACK = { width: 800, height: 1000 };
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
/** Drags smaller than this (normalized) are clicks: they clear the selection. */
const MIN_SELECTION = 0.015;

interface Rects {
	container: Rect;
	img: Rect;
}

/**
 * The photo plane: fit/zoom/pan and region selection. A drawn box is context
 * only — it is shown in the composer and applied from there (phase 5); the
 * canvas never asks for text itself. `highlights` outline regions of a
 * history entry the user is hovering.
 */
export function EditorCanvas({
	image,
	selection,
	onSelectionChange,
	highlights = [],
	sourceUrl,
}: {
	image: ImageDto;
	selection: Bbox | null;
	onSelectionChange: (box: Bbox | null) => void;
	highlights?: Bbox[];
	/** Branch source photo URL — enables the before/after wipe. */
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
	const [draft, setDraft] = useState<Bbox | null>(null);
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
			rectsRef.current = { container: { left: c.left, top: c.top, width: c.width, height: c.height }, img };
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
			Math.min((container.clientWidth - 96) / naturalWidth, (container.clientHeight - 96) / naturalHeight, 1),
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
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
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
			const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
			const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, editorStore.get().zoom * factor));
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

	/** Pointer → normalized image space, clamped to the photo. */
	function normFromClient(clientX: number, clientY: number) {
		const pt = toNorm(clientX, clientY, rectsRef.current.container, rectsRef.current.img);
		if (!pt) return null;
		const clamp = (v: number) => Math.min(1, Math.max(0, v));
		return { x: clamp(pt.x), y: clamp(pt.y) };
	}

	// Left drag = select a region. Alt / middle / right drag = pan.
	const onPointerDown = (e: React.PointerEvent) => {
		if (e.button !== 0 || e.altKey) {
			(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
			const start = { x: e.clientX, y: e.clientY, ox: editorStore.get().offset.x, oy: editorStore.get().offset.y };
			const move = (ev: PointerEvent) =>
				editorStore.set({ offset: { x: start.ox + (ev.clientX - start.x), y: start.oy + (ev.clientY - start.y) } });
			const up = () => {
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
		setDraft({ x: pt.x, y: pt.y, w: 0, h: 0 });
	};

	const onPointerMove = (e: React.PointerEvent) => {
		if (!drawing.current) return;
		const pt = normFromClient(e.clientX, e.clientY);
		if (!pt) return;
		setDraft({
			x: Math.min(drawing.current.x, pt.x),
			y: Math.min(drawing.current.y, pt.y),
			w: Math.abs(pt.x - drawing.current.x),
			h: Math.abs(pt.y - drawing.current.y),
		});
	};

	const onPointerUp = () => {
		if (!drawing.current) return;
		drawing.current = null;
		onSelectionChange(draft && draft.w > MIN_SELECTION && draft.h > MIN_SELECTION ? draft : null);
		setDraft(null);
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
			if (e.key === "Escape") onSelectionChange(null);
			if (e.key === "0") fit();
			if (e.key === "+" || e.key === "=") editorStore.set({ zoom: Math.min(MAX_ZOOM, editorStore.get().zoom * 1.2) });
			if (e.key === "-") editorStore.set({ zoom: Math.max(MIN_ZOOM, editorStore.get().zoom / 1.2) });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [fit, onSelectionChange]);

	const shown = draft ?? selection;

	return (
		<div
			ref={containerRef}
			className="ed-canvas-bg relative min-h-0 flex-1 select-none overflow-hidden"
			style={{ cursor: "crosshair", touchAction: "none" }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			role="application"
			aria-label="Photo viewer. Drag to select a region."
		>
			<div
				style={{
					transform: `translate(${editor.offset.x}px, ${editor.offset.y}px) scale(${editor.zoom})`,
					transformOrigin: "0 0",
					position: "absolute",
				}}
			>
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
					<div className="pointer-events-none absolute top-0 h-full w-0.5 bg-white shadow" style={{ left: `${wipe}%` }} />
				)}
				{(shown || highlights.length > 0) && (
					<svg
						className="pointer-events-none absolute left-0 top-0"
						style={{ width: naturalWidth, height: naturalHeight }}
						viewBox="0 0 1 1"
						preserveAspectRatio="none"
						aria-hidden
					>
						{highlights.map((h, i) => (
							<rect
								key={i}
								x={h.x}
								y={h.y}
								width={h.w}
								height={h.h}
								fill="rgba(255,196,64,0.16)"
								stroke="rgba(255,196,64,1)"
								strokeWidth={3}
								strokeDasharray="8 5"
								vectorEffect="non-scaling-stroke"
							/>
						))}
						{shown && (
							<rect
								x={shown.x}
								y={shown.y}
								width={shown.w}
								height={shown.h}
								fill="rgba(99,120,255,0.10)"
								stroke="rgba(99,120,255,0.95)"
								strokeWidth={2}
								vectorEffect="non-scaling-stroke"
							/>
						)}
					</svg>
				)}
			</div>
			{sourceUrl && (
				<div
					className="absolute bottom-4 right-4 flex items-center gap-2 rounded-full bg-black/65 px-3 py-1.5"
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
				{Math.round(editor.zoom * 100)}% · drag to select a region · Esc clears · scroll to zoom · Alt+drag to pan
			</div>
			{imgRect.width === 0 && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
					Loading photo…
				</div>
			)}
		</div>
	);
}
