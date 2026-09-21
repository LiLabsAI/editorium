# Plan 20 — Every Tool Does Something Real

**Fixes:** #11 · **Depends on:** Plan 15

## Goal

No decorative controls. Each tool in the bottom pill performs its function or
is removed until it can. Order: keep pointer + marquee + fullscreen, build
the rest, hide anything not shipped.

## Tools

1. **Pointer** — done in plan 15.
2. **Marquee** — normalized rubber band (plan 15) + **multi-select ops
   toolbar**: when ≥2 segments are selected show a floating mini-bar:
   Regenerate all (queues region edits in order with per-item progress),
   Lock all, Delete all.
3. **Duplicate** — `POST /api/images/:id/duplicate`: copies the image row +
   R2 objects (original/variants under a new image id, `kind='upload'`,
   label `"{label} copy"`), inserts after the source in the album; canvas
   reflects immediately. Keyboard `Ctrl/Cmd+D` on a selected *image card*
   context — scoped to editor route as "duplicate image" action in the `…`
   menu (the pill tool switches to an explicit "Duplicate image" click
   target mode with a one-time hint).
4. **Text** — canvas text annotations: click with T active → contentEditable
   box on the transformed plane; new `image_annotations` table
   (imageId, text, normX/Y, size, color); render on canvas; include in
   **download export**: flatten annotations onto the image via the Images
   binding `.draw()` (or client-canvas export fallback) when downloading.
   Delete via Backspace when selected; drag to move.
5. **Pen (lasso-to-segment)** — freehand path → closed polygon (normalized
   points) → `POST /api/images/:id/segments` `{ label: "custom region",
   polygon }` creates a segment with `polygonJson` + feathered polygon mask
   written to R2 (server PNG-mask builder from plan 16 generalized to
   polygons). It appears in the tree, is selectable, promptable, and
   regenerable exactly like detected segments — this is the reference
   product's "draw anywhere and prompt it" magic, in minimal form.
6. **Compose** — honest v1: layer **visibility toggles** in the element tree
   (eye icon; `PATCH /segments/:id { hidden }`, overlay + export respect
   hidden regions by excluding them from regeneration targets). Rename the
   tool "Layers" and have it toggle the tree's visibility column mode.
   (Full compositing is a phase-3 idea; do not fake it.)
7. **Image** — opens the album switcher overlay (grid of album images with
   search); selecting swaps the editor to that image route.
8. **Fullscreen** — keep; add Esc handling and hide the hint chip with the
   chrome.

## Acceptance (browser-verified)

- Marquee-select 3 regions → bulk bar appears → Regenerate all processes
  sequentially with per-region progress; lock/delete-all reflect in the tree.
- Duplicate creates a visible copy in the album canvas with its own tree.
- T → type text → it persists after reload and appears in the downloaded
  PNG; lasso around an arbitrary area → custom segment appears, accepts a
  prompt, and regenerates that shape; hidden layers are excluded from bulk
  regeneration and marked in the tree.
- Any tool still unimplementable is hidden from the pill (none expected).
