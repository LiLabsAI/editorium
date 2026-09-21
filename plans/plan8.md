# Plan 8 — Editor Shell: Canvas, Tools, Top Bar, Side Tabs (Screen C)

**Depends on:** Plan 3 · **Screens:** C (idle editor)

## Goal

The editor route `/albums/:albumId/images/:imageId`: image canvas with zoom/pan, the floating
tool pill, the full top bar (breadcrumb, undo/redo, download, Share), and the right sidebar
skeleton (Create | Edit tabs, Reference-image row, "Generated image" section, Ask composer).

## UI spec (from Screen C)

- **Top bar:** breadcrumb `{project} / {album} / {image label}` (current segment bold, truncate
  with ellipsis) · `…` menu · **undo ↶ / redo ↷** icon buttons (disabled states wired in plan 11)
  · **download** icon (serves current version original) · **Share** pill (plan 13 stub menu).
- **Canvas:** `#161616` area, centered image fitted to viewport; wheel = zoom to cursor,
  space-drag / two-finger = pan; double-click = fit. Keyboard: `0` fit, `+/-` zoom. Render with a
  transformed `<div>` layer (CSS matrix) so DOM overlays (boxes in plan 10) share the transform.
- **Tool pill** (bottom-center, dark rounded-full, hairline border, ~44px buttons):
  | Tool | Behavior this plan | Full behavior |
  |---|---|---|
  | Pointer (arrow) | active default, blue tint | click-select segments (plan 10) |
  | Marquee (dashed box) | draws selection rectangle | intersects segments (plan 10) |
  | Pen/lasso | freehand path UI | custom region prompt (plan 11) |
  | Cube | placeholder tooltip "Compose" | layers compose (plan 11) |
  | Text `T` | click adds text annotation to canvas UI only | exported overlay (plan 14) |
  | Duplicate | copies selected image card into album | — |
  | Image | opens album-image switcher overlay | — |
  | Fullscreen | hides chrome (Esc restores) | — |
- **Right sidebar (~380px):**
  - Tabs row: `Create` | `Edit` — Edit active on this route; Create shows generation composer
    (plan 7 form).
  - Edit tab contents:
    - `Reference image` row: camera-off toggle + mode dropdown **Literal** (options: Literal /
      Balanced / Creative → maps to i2i strength 0.9/0.6/0.3 in plan 11).
    - `Generated image` section: header thumbnail + collapse chevron; beneath it the **element
      tree** (empty state this plan: "Recognizing objects…" once plan 9 lands; before that a
      muted "No layers yet").
  - Bottom: same **Ask** composer component reused from plan 5, context = this image.

## API

- `GET /api/images/:id` (full detail: versions, segments when ready, thread context).
- `GET /api/images/:id/versions`; `POST /api/images/:id/versions/:vid/activate` (plan 11).

## Acceptance

- Route renders matching Screen C: breadcrumb, tools pill (pointer active/blue), sidebar with
  Reference-image row + Literal dropdown + empty Generated-image section, composer bottom-right.
- Zoom/pan/fit smooth at 60fps on a 4K image (transform layer, image decoded once);
  fullscreen toggle + keyboard shortcuts work.
- Tab switch Create/Edit keeps composer; share + undo/redo disabled-but-visible.
