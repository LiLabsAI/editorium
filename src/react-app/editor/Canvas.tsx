import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import {
	fileUrl,
	type AnnotationDto,
	type ImageAdjustments,
	type ImageDto,
	type SegmentDto,
} from "../lib/api";
import { editorStore, useEditorState } from "../lib/store";
import { toNorm, type Bbox, type NormPoint, type Rect } from "./geometry";
import { runMagicWand } from "./magicWand";
import { GlImageRenderer, hasNonZeroAdjustments } from "./webgl";

const FALLBACK = { width: 800, height: 1000 };
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const MIN_SELECTION = 0.015;
const MAX_MASK_SIDE = 1024;
const WORKING_MAX_PX = 4096;

export type OutpaintPad = { top: number; bottom: number; left: number; right: number };

export interface CanvasHandle {
	clearMask: () => void;
	invertMask: () => void;
	loadMaskFromUrl: (url: string) => Promise<Bbox | null>;
	getColorSampleSource: () => HTMLImageElement | null;
	fit: () => void;
}

interface Rects {
	container: Rect;
	img: Rect;
}

function clamp01(v: number): number {
	return Math.min(1, Math.max(0, v));
}

function maskDimensions(w: number, h: number): { width: number; height: number } {
	const scale = Math.min(1, MAX_MASK_SIDE / Math.max(1, w, h));
	return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function computeMaskBbox(canvas: HTMLCanvasElement): Bbox | null {
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;
	const { width, height } = canvas;
	const data = ctx.getImageData(0, 0, width, height).data;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	const step = width * height > 300_000 ? 2 : 1;
	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			if ((data[(y * width + x) * 4 + 3] ?? 0) > 12) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < minX || maxY < minY) return null;
	return {
		x: minX / width,
		y: minY / height,
		w: Math.max(MIN_SELECTION, Math.min(1 - minX / width, (maxX - minX + step) / width)),
		h: Math.max(MIN_SELECTION, Math.min(1 - minY / height, (maxY - minY + step) / height)),
	};
}

/**
 * Interactive WebGL2 + Mask Canvas viewport: progressive web->original streaming,
 * non-destructive shader adjustments, transform/crop/outpaint handles, Brush/Eraser/
 * Lasso/Magic Wand masks, clickable AI segments, and 4 compare modes.
 */
export function EditorCanvas({
	ref: handleRef,
	image,
	adjustments,
	onAdjustmentsChange,
	selection,
	onSelectionChange,
	onMaskChange,
	onLassoPolygon,
	outpaintPad,
	onOutpaintChange,
	segments = [],
	showSegments = false,
	onSelectSegment,
	annotations = [],
	onPlaceAnnotation,
	onDeleteAnnotation,
	highlights = [],
	sourceUrl,
}: {
	ref?: React.Ref<CanvasHandle>;
	image: ImageDto;
	adjustments: ImageAdjustments;
	onAdjustmentsChange?: (adj: ImageAdjustments) => void;
	selection: Bbox | null;
	onSelectionChange: (box: Bbox | null) => void;
	onMaskChange?: (out: { maskPngBase64: string | null; bbox: Bbox | null }) => void;
	onLassoPolygon?: (pts: NormPoint[]) => void;
	outpaintPad?: OutpaintPad;
	onOutpaintChange?: (pad: OutpaintPad) => void;
	segments?: SegmentDto[];
	showSegments?: boolean;
	onSelectSegment?: (segment: SegmentDto) => void;
	annotations?: AnnotationDto[];
	onPlaceAnnotation?: (pt: NormPoint) => void;
	onDeleteAnnotation?: (id: string) => void;
	highlights?: Bbox[];
	sourceUrl?: string;
}) {
	const editor = useEditorState();
	const containerRef = useRef<HTMLDivElement>(null);
	const imgRef = useRef<HTMLImageElement>(null);
	const glCanvasRef = useRef<HTMLCanvasElement>(null);
	const maskCanvasRef = useRef<HTMLCanvasElement>(null);
	const rendererRef = useRef<GlImageRenderer | null>(null);
	const loadedImgRef = useRef<HTMLImageElement | null>(null);
	const wandCacheRef = useRef<{ rgba: Uint8ClampedArray; width: number; height: number } | null>(null);
	const rectsRef = useRef<Rects>({
		container: { left: 0, top: 0, width: 0, height: 0 },
		img: { left: 0, top: 0, width: 0, height: 0 },
	});

	const [imgRect, setImgRect] = useState<Rect>({ left: 0, top: 0, width: 0, height: 0 });
	const [glPainted, setGlPainted] = useState(false);
	const [spaceDown, setSpaceDown] = useState(false);
	const [peekingKey, setPeekingKey] = useState(false);
	const [draft, setDraft] = useState<Bbox | null>(null);
	const draftRef = useRef<Bbox | null>(null);
	const [lassoPts, setLassoPts] = useState<NormPoint[]>([]);
	const lassoRef = useRef<NormPoint[]>([]);
	const [hasMaskPixels, setHasMaskPixels] = useState(false);
	const [wipe, setWipe] = useState(50);

	const drawingOrigin = useRef<NormPoint | null>(null);
	const brushLast = useRef<NormPoint | null>(null);
	const panCleanupRef = useRef<(() => void) | null>(null);
	const activeTouchesRef = useRef(new Map<number, { x: number; y: number }>());
	const pinchStartRef = useRef<{ dist: number; zoom: number } | null>(null);
	const [cropDraft, setCropDraft] = useState<Bbox | null>(null);
	const cropHandleRef = useRef<{
		mode: "nw" | "ne" | "sw" | "se" | "move";
		startPt: NormPoint;
		startBox: Bbox;
	} | null>(null);

	const naturalWidth = image.widthPx || FALLBACK.width;
	const naturalHeight = image.heightPx || FALLBACK.height;
	const mDims = maskDimensions(naturalWidth, naturalHeight);

	// Progressive WebGL2 source loading: fast web variant -> full original background swap.
	useEffect(() => {
		let cancelled = false;
		const glCanvas = glCanvasRef.current;
		if (glCanvas && !rendererRef.current) {
			rendererRef.current = new GlImageRenderer(glCanvas);
		}
		wandCacheRef.current = null;
		setGlPainted(false);

		const webUrl = fileUrl(image.id, "web", image.currentVersionId ?? undefined);
		const origUrl = fileUrl(image.id, "original", image.currentVersionId ?? undefined);

		const uploadToGl = (loaded: HTMLImageElement) => {
			if (cancelled || !rendererRef.current) return;
			loadedImgRef.current = loaded;
			rendererRef.current.setSource(loaded);
			rendererRef.current.render(peekingKey ? {} : adjustments, naturalWidth, naturalHeight);
			setGlPainted(true);

			// Cache <=512px RGBA buffer for sub-15ms edge-aware Magic Wand fills.
			try {
				const scale = Math.min(1, 512 / Math.max(1, loaded.naturalWidth, loaded.naturalHeight));
				const w = Math.max(1, Math.round(loaded.naturalWidth * scale));
				const h = Math.max(1, Math.round(loaded.naturalHeight * scale));
				const off = document.createElement("canvas");
				off.width = w;
				off.height = h;
				const ctx = off.getContext("2d", { willReadFrequently: true });
				if (ctx) {
					ctx.drawImage(loaded, 0, 0, w, h);
					wandCacheRef.current = { rgba: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
				}
			} catch {
				// Ignore canvas readback failures.
			}
		};

		const webImg = new Image();
		webImg.crossOrigin = "anonymous";
		webImg.onload = () => {
			uploadToGl(webImg);
			if (origUrl !== webUrl) {
				const origImg = new Image();
				origImg.crossOrigin = "anonymous";
				origImg.onload = () => uploadToGl(origImg);
				origImg.src = origUrl;
			}
		};
		webImg.src = webUrl;

		return () => {
			cancelled = true;
		};
		// Re-run only when photo or version changes; adjustment updates re-render without reloading textures.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [image.id, image.currentVersionId, naturalWidth, naturalHeight]);

	useEffect(() => {
		if (!rendererRef.current || !loadedImgRef.current) return;
		rendererRef.current.render(peekingKey ? {} : adjustments, naturalWidth, naturalHeight);
	}, [adjustments, peekingKey, naturalWidth, naturalHeight]);

	useEffect(() => {
		return () => {
			rendererRef.current?.dispose();
			rendererRef.current = null;
			panCleanupRef.current?.();
		};
	}, []);

	const emitMask = useCallback(() => {
		const c = maskCanvasRef.current;
		if (!c) return;
		const bbox = computeMaskBbox(c);
		setHasMaskPixels(Boolean(bbox));
		if (!onMaskChange) return;
		onMaskChange(bbox ? { maskPngBase64: c.toDataURL("image/png"), bbox } : { maskPngBase64: null, bbox: null });
	}, [onMaskChange]);

	const clearMask = useCallback(() => {
		const c = maskCanvasRef.current;
		if (c) {
			c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
		}
		setHasMaskPixels(false);
		onMaskChange?.({ maskPngBase64: null, bbox: null });
	}, [onMaskChange]);

	const invertMask = useCallback(() => {
		const c = maskCanvasRef.current;
		if (!c) return;
		const ctx = c.getContext("2d", { willReadFrequently: true });
		if (!ctx) return;
		const imgData = ctx.getImageData(0, 0, c.width, c.height);
		const d = imgData.data;
		for (let i = 0; i < d.length; i += 4) {
			const a = 255 - (d[i + 3] ?? 0);
			d[i] = 110;
			d[i + 1] = 128;
			d[i + 2] = 255;
			d[i + 3] = a;
		}
		ctx.putImageData(imgData, 0, 0);
		emitMask();
	}, [emitMask]);

	const loadMaskFromUrl = useCallback(
		async (url: string): Promise<Bbox | null> => {
			const c = maskCanvasRef.current;
			if (!c) return null;
			const ctx = c.getContext("2d", { willReadFrequently: true });
			if (!ctx) return null;
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.src = url;
			await new Promise<void>((res, rej) => {
				img.onload = () => res();
				img.onerror = () => rej(new Error("Could not load mask"));
			});
			ctx.clearRect(0, 0, c.width, c.height);
			ctx.drawImage(img, 0, 0, c.width, c.height);
			// Re-tint loaded PNG alpha pixels in crisp mask indigo for consistent UI overlay.
			const data = ctx.getImageData(0, 0, c.width, c.height);
			const px = data.data;
			for (let i = 0; i < px.length; i += 4) {
				if ((px[i + 3] ?? 0) > 8) {
					px[i] = 110;
					px[i + 1] = 128;
					px[i + 2] = 255;
				}
			}
			ctx.putImageData(data, 0, 0);
			const bbox = computeMaskBbox(c);
			setHasMaskPixels(Boolean(bbox));
			onMaskChange?.(bbox ? { maskPngBase64: c.toDataURL("image/png"), bbox } : { maskPngBase64: null, bbox: null });
			return bbox;
		},
		[onMaskChange],
	);

	// Layout observer using rAF to batch store-triggered measurements smoothly.
	useEffect(() => {
		const el = imgRef.current;
		const container = containerRef.current;
		if (!el || !container) return;
		let rafId: number | null = null;
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
		const schedule = () => {
			if (rafId !== null) return;
			rafId = window.requestAnimationFrame(() => {
				rafId = null;
				measure();
			});
		};
		measure();
		const observer = new ResizeObserver(schedule);
		observer.observe(el);
		observer.observe(container);
		const unsubscribe = editorStore.subscribe(schedule);
		return () => {
			if (rafId !== null) window.cancelAnimationFrame(rafId);
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

	useImperativeHandle(
		handleRef,
		() => ({
			clearMask,
			invertMask,
			loadMaskFromUrl,
			getColorSampleSource: () => loadedImgRef.current,
			fit,
		}),
		[clearMask, invertMask, loadMaskFromUrl, fit],
	);

	useEffect(() => {
		fit();
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, [fit]);

	// Wheel zoom / trackpad pan anchored smoothly at cursor.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const { container: cont, img } = rectsRef.current;
			if (img.width <= 0) return;
			if (e.ctrlKey || Math.abs(e.deltaX) < 1) {
				const nx = (e.clientX - cont.left - img.left) / img.width;
				const ny = (e.clientY - cont.top - img.top) / img.height;
				const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
				const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, editorStore.get().zoom * factor));
				editorStore.set({
					zoom,
					offset: {
						x: e.clientX - cont.left - nx * naturalWidth * zoom,
						y: e.clientY - cont.top - ny * naturalHeight * zoom,
					},
				});
			} else {
				const { offset } = editorStore.get();
				editorStore.set({ offset: { x: offset.x - e.deltaX, y: offset.y - e.deltaY } });
			}
		};
		container.addEventListener("wheel", onWheel, { passive: false });
		return () => container.removeEventListener("wheel", onWheel);
	}, [naturalWidth, naturalHeight]);

	// Keyboard helpers (Space to pan, \ to peek before/after, Escape, 0/+/-).
	useEffect(() => {
		const isTyping = (target: EventTarget | null) => {
			const el = target as HTMLElement | null;
			return el?.tagName === "TEXTAREA" || el?.tagName === "INPUT" || el?.isContentEditable;
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (isTyping(e.target)) return;
			if (e.code === "Space") {
				e.preventDefault();
				setSpaceDown(true);
			}
			if (e.key === "\\") setPeekingKey(true);
			if (e.key === "Escape") {
				onSelectionChange(null);
				clearMask();
			}
			if (e.key === "0") fit();
			if (e.key === "+" || e.key === "=") editorStore.set({ zoom: Math.min(MAX_ZOOM, editorStore.get().zoom * 1.2) });
			if (e.key === "-") editorStore.set({ zoom: Math.max(MIN_ZOOM, editorStore.get().zoom / 1.2) });
			if (e.key === "[") editorStore.set({ brushRadiusPx: Math.max(6, editorStore.get().brushRadiusPx - 6) });
			if (e.key === "]") editorStore.set({ brushRadiusPx: Math.min(140, editorStore.get().brushRadiusPx + 6) });
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.code === "Space") setSpaceDown(false);
			if (e.key === "\\") setPeekingKey(false);
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
		};
	}, [fit, onSelectionChange, clearMask]);

	function normFromClient(clientX: number, clientY: number): NormPoint | null {
		const pt = toNorm(clientX, clientY, rectsRef.current.container, rectsRef.current.img);
		if (!pt) return null;
		return { x: clamp01(pt.x), y: clamp01(pt.y) };
	}

	function paintStroke(from: NormPoint, to: NormPoint, erase: boolean) {
		const c = maskCanvasRef.current;
		if (!c) return;
		const ctx = c.getContext("2d");
		if (!ctx) return;
		const radius = Math.max(2, (editor.brushRadiusPx / naturalWidth) * c.width);
		ctx.save();
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.lineWidth = radius * 2;
		if (erase) {
			ctx.globalCompositeOperation = "destination-out";
			ctx.strokeStyle = "rgba(0,0,0,1)";
		} else {
			ctx.globalCompositeOperation = "source-over";
			ctx.strokeStyle = "rgba(110, 128, 255, 1)";
		}
		ctx.beginPath();
		ctx.moveTo(from.x * c.width, from.y * c.height);
		ctx.lineTo(to.x * c.width, to.y * c.height);
		ctx.stroke();
		ctx.restore();
	}

	const startPan = (e: React.PointerEvent) => {
		panCleanupRef.current?.();
		(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
		const start = { x: e.clientX, y: e.clientY, ox: editorStore.get().offset.x, oy: editorStore.get().offset.y };
		const move = (ev: PointerEvent) => {
			editorStore.set({ offset: { x: start.ox + (ev.clientX - start.x), y: start.oy + (ev.clientY - start.y) } });
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			panCleanupRef.current = null;
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		panCleanupRef.current = up;
	};

	const onPointerDown = async (e: React.PointerEvent) => {
		if (e.pointerType === "touch") {
			activeTouchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (activeTouchesRef.current.size === 2) {
				drawingOrigin.current = null;
				brushLast.current = null;
				const pts = [...activeTouchesRef.current.values()];
				pinchStartRef.current = {
					dist: Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y),
					zoom: editorStore.get().zoom,
				};
				return;
			}
		}

		if (e.button !== 0 || e.altKey || spaceDown || editor.tool === "pan") {
			startPan(e);
			return;
		}

		const pt = normFromClient(e.clientX, e.clientY);
		if (!pt) return;

		if (editor.tool === "text") {
			onPlaceAnnotation?.(pt);
			return;
		}

		if (editor.tool === "wand") {
			const src = wandCacheRef.current;
			if (!src) return;
			const res = await runMagicWand(src.rgba, src.width, src.height, pt.x, pt.y, editor.wandTolerance);
			const c = maskCanvasRef.current;
			if (!c) return;
			const ctx = c.getContext("2d");
			if (!ctx) return;
			const tmp = document.createElement("canvas");
			tmp.width = src.width;
			tmp.height = src.height;
			const tCtx = tmp.getContext("2d");
			if (tCtx) {
				const imgData = tCtx.createImageData(src.width, src.height);
				for (let i = 0; i < res.maskAlpha.length; i++) {
					const a = res.maskAlpha[i]!;
					imgData.data[i * 4] = 110;
					imgData.data[i * 4 + 1] = 128;
					imgData.data[i * 4 + 2] = 255;
					imgData.data[i * 4 + 3] = a;
				}
				tCtx.putImageData(imgData, 0, 0);
				if (!e.shiftKey) ctx.clearRect(0, 0, c.width, c.height);
				ctx.drawImage(tmp, 0, 0, c.width, c.height);
				emitMask();
				if (res.bbox) onSelectionChange(res.bbox);
			}
			return;
		}

		if (editor.tool === "brush" || editor.tool === "eraser") {
			(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
			brushLast.current = pt;
			paintStroke(pt, pt, editor.tool === "eraser");
			return;
		}

		if (editor.tool === "lasso") {
			(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
			lassoRef.current = [pt];
			setLassoPts([pt]);
			return;
		}

		if (editor.tool === "select" && showSegments && segments.length > 0) {
			const hit = [...segments]
				.filter((s) => !s.hiddenAt && pt.x >= s.bboxX && pt.x <= s.bboxX + s.bboxW && pt.y >= s.bboxY && pt.y <= s.bboxY + s.bboxH)
				.sort((a, b) => a.bboxW * a.bboxH - b.bboxW * b.bboxH)[0];
			if (hit) {
				onSelectSegment?.(hit);
				onSelectionChange({ x: hit.bboxX, y: hit.bboxY, w: hit.bboxW, h: hit.bboxH });
				return;
			}
		}

		(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
		drawingOrigin.current = pt;
		const emptyBox = { x: pt.x, y: pt.y, w: 0, h: 0 };
		draftRef.current = emptyBox;
		setDraft(emptyBox);
	};

	const onPointerMove = (e: React.PointerEvent) => {
		if (e.pointerType === "touch" && activeTouchesRef.current.has(e.pointerId)) {
			activeTouchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (activeTouchesRef.current.size === 2 && pinchStartRef.current) {
				const pts = [...activeTouchesRef.current.values()];
				const dist = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
				const scale = dist / Math.max(1, pinchStartRef.current.dist);
				editorStore.set({
					zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchStartRef.current.zoom * scale)),
				});
				return;
			}
		}

		const pt = normFromClient(e.clientX, e.clientY);
		if (!pt) return;

		if (cropHandleRef.current) {
			const { mode, startPt, startBox } = cropHandleRef.current;
			const dx = pt.x - startPt.x;
			const dy = pt.y - startPt.y;
			const next = { ...startBox };
			if (mode === "move") {
				next.x = Math.max(0, Math.min(1 - startBox.w, startBox.x + dx));
				next.y = Math.max(0, Math.min(1 - startBox.h, startBox.y + dy));
			} else {
				if (mode.includes("w")) {
					const nx = Math.max(0, Math.min(startBox.x + startBox.w - 0.05, startBox.x + dx));
					next.w = startBox.x + startBox.w - nx;
					next.x = nx;
				}
				if (mode.includes("e")) {
					next.w = Math.max(0.05, Math.min(1 - startBox.x, startBox.w + dx));
				}
				if (mode.includes("n")) {
					const ny = Math.max(0, Math.min(startBox.y + startBox.h - 0.05, startBox.y + dy));
					next.h = startBox.y + startBox.h - ny;
					next.y = ny;
				}
				if (mode.includes("s")) {
					next.h = Math.max(0.05, Math.min(1 - startBox.y, startBox.h + dy));
				}
			}
			setCropDraft(next);
			return;
		}

		if (brushLast.current) {
			paintStroke(brushLast.current, pt, editor.tool === "eraser");
			brushLast.current = pt;
			return;
		}

		if (lassoRef.current.length > 0) {
			const prev = lassoRef.current[lassoRef.current.length - 1]!;
			if (Math.hypot(pt.x - prev.x, pt.y - prev.y) > 0.004 && lassoRef.current.length < 180) {
				const next = [...lassoRef.current, pt];
				lassoRef.current = next;
				setLassoPts(next);
			}
			return;
		}

		if (!drawingOrigin.current) return;
		const nextBox: Bbox = {
			x: Math.min(drawingOrigin.current.x, pt.x),
			y: Math.min(drawingOrigin.current.y, pt.y),
			w: Math.abs(pt.x - drawingOrigin.current.x),
			h: Math.abs(pt.y - drawingOrigin.current.y),
		};
		draftRef.current = nextBox;
		setDraft(nextBox);
	};

	const onPointerUp = (e: React.PointerEvent) => {
		if (e.pointerType === "touch") {
			activeTouchesRef.current.delete(e.pointerId);
			if (activeTouchesRef.current.size < 2) pinchStartRef.current = null;
		}

		if (cropHandleRef.current) {
			cropHandleRef.current = null;
			if (cropDraft) onAdjustmentsChange?.({ ...adjustments, crop: cropDraft });
			return;
		}

		if (brushLast.current) {
			brushLast.current = null;
			emitMask();
			return;
		}

		if (lassoRef.current.length > 0) {
			const pts = lassoRef.current;
			lassoRef.current = [];
			setLassoPts([]);
			if (pts.length >= 3) {
				const c = maskCanvasRef.current;
				const ctx = c?.getContext("2d");
				if (c && ctx) {
					ctx.save();
					ctx.fillStyle = "rgba(110, 128, 255, 1)";
					ctx.beginPath();
					ctx.moveTo(pts[0]!.x * c.width, pts[0]!.y * c.height);
					for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x * c.width, pts[i]!.y * c.height);
					ctx.closePath();
					ctx.fill();
					ctx.restore();
					emitMask();
				}
				onLassoPolygon?.(pts);
			}
			return;
		}

		if (!drawingOrigin.current) return;
		drawingOrigin.current = null;
		const finalized = draftRef.current;
		draftRef.current = null;
		setDraft(null);
		onSelectionChange(finalized && finalized.w > MIN_SELECTION && finalized.h > MIN_SELECTION ? finalized : null);
	};

	const shown = draft ?? selection;
	const activeCrop = editor.tool === "crop" ? (cropDraft ?? adjustments.crop ?? { x: 0, y: 0, w: 1, h: 1 }) : null;
	const showCompareToggle = Boolean(sourceUrl) || hasNonZeroAdjustments(adjustments);
	const compareActive = editor.compareMode !== "off" && !peekingKey;
	const beforeSrc = sourceUrl ?? fileUrl(image.id, "web", image.currentVersionId ?? undefined);
	const stageDeg = (adjustments.rotate90 ?? 0) * 90 + (adjustments.straighten ?? 0);
	const cursorStyle =
		spaceDown || editor.tool === "pan"
			? "grab"
			: editor.tool === "text"
				? "text"
				: "crosshair";

	const croppedClip =
		editor.tool !== "crop" && adjustments.crop
			? `inset(${(adjustments.crop.y * 100).toFixed(2)}% ${((1 - adjustments.crop.x - adjustments.crop.w) * 100).toFixed(2)}% ${((1 - adjustments.crop.y - adjustments.crop.h) * 100).toFixed(2)}% ${(adjustments.crop.x * 100).toFixed(2)}%)`
			: undefined;

	return (
		<div
			ref={containerRef}
			className="ed-canvas-bg relative min-h-0 flex-1 select-none overflow-hidden"
			style={{ cursor: cursorStyle, touchAction: "none" }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			role="application"
			aria-label="Photo viewport"
		>
			{editor.compareMode === "side" && showCompareToggle ? (
				<div className="flex size-full items-center justify-center gap-4 p-6">
					<figure className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2">
						<span className="rounded-full bg-black/55 px-2.5 py-0.5 text-[11px] text-white/80">Before</span>
						<img src={beforeSrc} alt="Before" className="max-h-[85%] max-w-full rounded-sm object-contain shadow-xl" />
					</figure>
					<figure className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2">
						<span className="rounded-full bg-black/55 px-2.5 py-0.5 text-[11px] text-white/80">After</span>
						<img
							src={fileUrl(image.id, "web", image.currentVersionId ?? undefined)}
							alt={image.filenameLabel}
							className="max-h-[85%] max-w-full rounded-sm object-contain shadow-xl"
						/>
					</figure>
				</div>
			) : (
				<div
					style={{
						transform: `translate(${editor.offset.x}px, ${editor.offset.y}px) scale(${editor.zoom})`,
						transformOrigin: "0 0",
						position: "absolute",
					}}
				>
					{/* Outpaint preview frame when Outpaint tool is active */}
					{editor.tool === "outpaint" && outpaintPad && (
						<div
							className="pointer-events-none absolute border border-dashed border-indigo-400/70 bg-black/35"
							style={{
								left: -outpaintPad.left,
								top: -outpaintPad.top,
								width: naturalWidth + outpaintPad.left + outpaintPad.right,
								height: naturalHeight + outpaintPad.top + outpaintPad.bottom,
							}}
						/>
					)}

					<div
						style={{
							width: naturalWidth,
							height: naturalHeight,
							clipPath: peekingKey ? undefined : croppedClip,
							transform:
								peekingKey || (!stageDeg && !adjustments.flipH && !adjustments.flipV)
									? undefined
									: `rotate(${stageDeg}deg) scale(${adjustments.flipH ? -1 : 1}, ${adjustments.flipV ? -1 : 1})`,
						}}
						className="relative"
					>
						{/* Layout anchor img + fallback before WebGL2 uploads */}
						<img
							ref={imgRef}
							src={fileUrl(image.id, "web", image.currentVersionId ?? undefined)}
							alt={image.filenameLabel}
							draggable={false}
							style={{ width: naturalWidth, height: naturalHeight, maxWidth: "none" }}
							className={`rounded-sm shadow-2xl ${glPainted ? "opacity-0" : "opacity-100"}`}
						/>
						<canvas
							ref={glCanvasRef}
							width={naturalWidth}
							height={naturalHeight}
							style={{ width: naturalWidth, height: naturalHeight }}
							className={`pointer-events-none absolute left-0 top-0 rounded-sm shadow-2xl ${glPainted ? "opacity-100" : "opacity-0"}`}
						/>

						{/* Compare: Split Wipe or Peek */}
						{(peekingKey || (compareActive && editor.compareMode === "split")) && showCompareToggle && (
							<>
								<img
									src={beforeSrc}
									alt="Before"
									draggable={false}
									style={{
										width: naturalWidth,
										height: naturalHeight,
										maxWidth: "none",
										clipPath: peekingKey ? undefined : `inset(0 ${100 - wipe}% 0 0)`,
									}}
									className="pointer-events-none absolute left-0 top-0 select-none"
								/>
								{!peekingKey && (
									<div
										className="pointer-events-none absolute top-0 h-full w-0.5 bg-white shadow"
										style={{ left: `${wipe}%` }}
									/>
								)}
							</>
						)}

						{/* Editable selection Mask Canvas */}
						<canvas
							ref={maskCanvasRef}
							width={mDims.width}
							height={mDims.height}
							style={{
								width: naturalWidth,
								height: naturalHeight,
								opacity: editor.showMaskOverlay && hasMaskPixels ? 0.48 : 0,
							}}
							className="pointer-events-none absolute left-0 top-0 transition-opacity"
						/>

						{/* Placed Text Annotations */}
						{annotations.map((a) => (
							<div
								key={a.id}
								onPointerDown={(ev) => ev.stopPropagation()}
								style={{
									left: `${a.normX * 100}%`,
									top: `${a.normY * 100}%`,
									fontSize: `${Math.max(12, Math.round(a.fontSize * Math.min(naturalWidth, naturalHeight)))}px`,
									color: a.color,
									textShadow: "0 1px 4px rgba(0,0,0,0.75)",
								}}
								className="group/ann absolute -translate-x-1/2 -translate-y-1/2 font-semibold"
							>
								<span>{a.text}</span>
								{onDeleteAnnotation && (
									<button
										type="button"
										aria-label={`Remove text ${a.text}`}
										onClick={() => onDeleteAnnotation(a.id)}
										className="ml-1 hidden rounded-full bg-black/75 px-1.5 text-xs text-white group-hover/ann:inline"
									>
										×
									</button>
								)}
							</div>
						))}

						{/* Vector Overlays: segments + highlights + box selection + lasso + crop handles */}
						{(shown || highlights.length > 0 || lassoPts.length > 1 || showSegments || activeCrop) && (
							<svg
								className="pointer-events-none absolute left-0 top-0"
								style={{ width: naturalWidth, height: naturalHeight }}
								viewBox="0 0 1 1"
								preserveAspectRatio="none"
								aria-hidden
							>
								{showSegments &&
									segments
										.filter((s) => !s.hiddenAt)
										.map((s) => {
											const isSel = editor.selectedIds.includes(s.id);
											const isHov = editor.hoveredId === s.id;
											return (
												<rect
													key={s.id}
													x={s.bboxX}
													y={s.bboxY}
													width={s.bboxW}
													height={s.bboxH}
													fill={isSel ? "rgba(99,120,255,0.12)" : isHov ? "rgba(255,255,255,0.06)" : "transparent"}
													stroke={isSel ? "rgba(99,120,255,0.95)" : isHov ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.28)"}
													strokeWidth={isSel ? 2 : 1}
													vectorEffect="non-scaling-stroke"
												/>
											);
										})}
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
								{lassoPts.length > 1 && (
									<polyline
										points={lassoPts.map((p) => `${p.x},${p.y}`).join(" ")}
										fill="rgba(110,128,255,0.2)"
										stroke="rgba(165,180,255,0.95)"
										strokeWidth={2}
										vectorEffect="non-scaling-stroke"
									/>
								)}
								{activeCrop && (
									<g>
										<rect
											x={activeCrop.x}
											y={activeCrop.y}
											width={activeCrop.w}
											height={activeCrop.h}
											fill="rgba(255,255,255,0.04)"
											stroke="white"
											strokeWidth={2}
											vectorEffect="non-scaling-stroke"
										/>
									</g>
								)}
							</svg>
						)}

						{/* Crop corner drag handles */}
						{activeCrop && (
							<>
								{(["nw", "ne", "sw", "se"] as const).map((corner) => (
									<div
										key={corner}
										onPointerDown={(ev) => {
											ev.stopPropagation();
											const pt = normFromClient(ev.clientX, ev.clientY);
											if (!pt) return;
											(ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
											cropHandleRef.current = { mode: corner, startPt: pt, startBox: activeCrop };
											setCropDraft(activeCrop);
										}}
										style={{
											left: `${(corner.includes("w") ? activeCrop.x : activeCrop.x + activeCrop.w) * 100}%`,
											top: `${(corner.includes("n") ? activeCrop.y : activeCrop.y + activeCrop.h) * 100}%`,
										}}
										className="absolute size-4 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-full border-2 border-white bg-indigo-500 shadow"
									/>
								))}
							</>
						)}

						{/* Outpaint drag handles */}
						{editor.tool === "outpaint" && outpaintPad && onOutpaintChange && (
							<>
								{(["top", "bottom", "left", "right"] as const).map((edge) => (
									<button
										key={edge}
										type="button"
										aria-label={`Extend ${edge}`}
										onPointerDown={(ev) => {
											ev.stopPropagation();
											const startX = ev.clientX;
											const startY = ev.clientY;
											const basePad = { ...outpaintPad };
											const zoom = Math.max(0.1, editorStore.get().zoom);
											const move = (mv: PointerEvent) => {
												const next = { ...basePad };
												if (edge === "left") {
													next.left = Math.max(0, Math.min(WORKING_MAX_PX - naturalWidth - basePad.right, Math.round(basePad.left - (mv.clientX - startX) / zoom)));
												} else if (edge === "right") {
													next.right = Math.max(0, Math.min(WORKING_MAX_PX - naturalWidth - basePad.left, Math.round(basePad.right + (mv.clientX - startX) / zoom)));
												} else if (edge === "top") {
													next.top = Math.max(0, Math.min(WORKING_MAX_PX - naturalHeight - basePad.bottom, Math.round(basePad.top - (mv.clientY - startY) / zoom)));
												} else {
													next.bottom = Math.max(0, Math.min(WORKING_MAX_PX - naturalHeight - basePad.top, Math.round(basePad.bottom + (mv.clientY - startY) / zoom)));
												}
												onOutpaintChange(next);
											};
											panCleanupRef.current?.();
											const up = () => {
												window.removeEventListener("pointermove", move);
												window.removeEventListener("pointerup", up);
												panCleanupRef.current = null;
											};
											window.addEventListener("pointermove", move);
											window.addEventListener("pointerup", up);
											panCleanupRef.current = up;
										}}
										style={{
											left:
												edge === "left"
													? -outpaintPad.left
													: edge === "right"
														? naturalWidth + outpaintPad.right
														: naturalWidth / 2,
											top:
												edge === "top"
													? -outpaintPad.top
													: edge === "bottom"
														? naturalHeight + outpaintPad.bottom
														: naturalHeight / 2,
										}}
										className="absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-indigo-500 px-2 py-0.5 text-[10px] font-medium text-white shadow"
									>
										{edge}
									</button>
								))}
							</>
						)}
					</div>
				</div>
			)}

			{/* Compare controls overlay */}
			{showCompareToggle && (
				<div
					className="absolute bottom-4 right-4 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 backdrop-blur-sm"
					onPointerDown={(e) => e.stopPropagation()}
				>
					<button
						type="button"
						onClick={() =>
							editorStore.set({
								compareMode:
									editor.compareMode === "off"
										? "split"
										: editor.compareMode === "split"
											? "side"
											: "off",
							})
						}
						aria-pressed={editor.compareMode !== "off"}
						className={`rounded-full px-3 py-1 text-xs font-medium transition ${
							editor.compareMode !== "off" ? "bg-foreground text-background" : "text-white/85 hover:text-white"
						}`}
					>
						{editor.compareMode === "off"
							? "Compare"
							: editor.compareMode === "split"
								? "Split wipe"
								: "Side-by-side"}
					</button>
					{editor.compareMode === "split" && (
						<input
							aria-label="Before after wipe"
							type="range"
							min={0}
							max={100}
							value={wipe}
							onChange={(e) => setWipe(Number(e.target.value))}
							className="w-28 accent-[rgba(99,120,255,0.95)]"
						/>
					)}
					<button
						type="button"
						title="Hold or press \ to peek original"
						onPointerDown={() => setPeekingKey(true)}
						onPointerUp={() => setPeekingKey(false)}
						onPointerLeave={() => setPeekingKey(false)}
						className="rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-white/80 hover:text-white"
					>
						Hold \
					</button>
				</div>
			)}

			{/* Hint pill */}
			<div className="pointer-events-none absolute bottom-4 left-4 rounded-full bg-black/60 px-3 py-1 text-xs text-white/85">
				{Math.round(editor.zoom * 100)}% · {toolHint(editor.tool)} · Space+drag to pan · Esc clears
			</div>
			{imgRect.width === 0 && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
					Loading…
				</div>
			)}
		</div>
	);
}

function toolHint(tool: string): string {
	switch (tool) {
		case "brush":
			return "paint selection mask ([ / ] resizes)";
		case "eraser":
			return "erase selection mask";
		case "lasso":
			return "draw freehand selection polygon";
		case "wand":
			return "click object to edge-select (Shift adds)";
		case "crop":
			return "drag corners to crop";
		case "outpaint":
			return "drag edges outward to extend frame";
		case "text":
			return "click photo to place text overlay";
		case "pan":
			return "drag to pan";
		default:
			return "drag to select a region";
	}
}
