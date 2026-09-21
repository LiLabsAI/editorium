# Plan 15 — Canvas Interaction Engine Rebuild

**Fixes:** P0 #1–5 · **Priority:** highest (this is why the editor feels dead)

## Goal

Rebuild all pointer geometry in `src/react-app/editor/Canvas.tsx` around one
measured, transform-inclusive image rect, so hit-testing, hover, drag,
resize, marquee, and the prompt card all land exactly where the user's cursor
is — at any zoom/pan.

## Design: one coordinate bridge

```ts
// imgRect = <img>.getBoundingClientRect() relative to the container.
// It already includes zoom + pan (CSS transform), so it is the ONLY
// conversion layer we need:
function toNorm(clientX, clientY): { x: number; y: number } | null {
  // client pixels → normalized 0..1 image space
  return {
    x: (clientX - imgRect.left) / imgRect.width,
    y: (clientY - imgRect.top) / imgRect.height,
  };
}
function toScreen(nx: number, ny: number): { left: number; top: number } {
  return { left: imgRect.left + nx * imgRect.width, top: imgRect.top + ny * imgRect.height };
}
```

Rules:
- Segment bboxes are **always normalized**; pointer positions convert to
  normalized immediately; screen positions are only produced by `toScreen`.
- Delete the manual `offset/zoom` inverse math (`toImage`) from hit-testing
  and drag paths — those caused the P0 unit mismatch (#1).
- `fit()` keeps zoom/pan for rendering only, never for input math.

## Changes

1. **Hit-testing** — `segmentAt(nx, ny)` compares against normalized bbox
   directly; order deepest-first via `orderIdx` reverse scan (children before
   parents before composite).
2. **Hover engine** — add `onPointerMove` on the canvas container: compute
   normalized point, set `hoveredId` from `segmentAt`, clear when null. Remove
   the chicken-and-egg `onPointerEnter` overlay approach (#2): boxes now
   appear on mere hover, exactly like the reference product.
3. **Selection** — pointerdown: `segmentAt` → single-select; shift+click
   toggles multi-select; empty-area click clears. Cursor: `pointer` over a
   region, `default` elsewhere (derive from hoveredId).
4. **Move/resize** — drag state stores startBox (normalized) + start point
   (normalized); deltas computed as `toNorm(now) - toNorm(start)` so zoom
   cancels out. 8 handles positioned with % (already correct). On pointerup:
   clamp to 0..1, `PATCH /api/segments/:id { bbox }` if moved >0.002, refresh.
5. **Marquee** — store and draw the rubber band in normalized coordinates;
   the SVG keeps `viewBox="0 0 1 1"`, so the rect now renders correctly;
   on release select all intersecting segments (#4).
6. **Prompt card anchor** — `toScreen(bboxX + bboxW, bboxY)` + 16px gap,
   flipped left when it would overflow the container; recompute on zoom/pan
   via the existing ResizeObserver + store subscription (#3).
7. **Zoom/pan hardening** — wheel zoom to cursor keeps the normalized point
   under the cursor fixed (solve offset from `toScreen` invariance);
   space-drag and middle-drag pan; `0` fit, `+/-` zoom keys.
8. **Keyboard** — Esc clears selection AND closes the prompt card; arrow keys
   cycle top-level segments; Enter re-opens the prompt card.

## Acceptance (browser-verified)

- Hover anywhere over a recognized region → box + label chip appear under the
  cursor; click → blue handled selection + prompt card anchored at the box
  (never offscreen); verified on a real 3:4 JPEG at 40% and 120% zoom.
- Drag a box 200px → bbox persists after reload; resize via each of the 8
  handles works; marquee rubber band is visible and selects intersecting
  regions; zoom-to-cursor keeps the point under the wheel fixed.
- Unit tests (jsdom): toNorm/toScreen round-trip, segmentAt ordering,
  marquee intersection — with a mocked imgRect.
