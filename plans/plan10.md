# Plan 10 — Element Tree + Selection, Boxes, Lock/Delete + Prompt Card (Screen D)

**Depends on:** Plan 9 · **Screens:** C–D (the killer interaction)

## Goal

Wire the segmentation data into the two selection surfaces (sidebar tree + canvas) and build the
floating **Prompt card**. Clicking the tree region in the reference photo shows a blue handled
bounding box, a floating label chip, a caption card with Color Palette, and highlights the
matching tree row — we replicate that interaction loop exactly.

## Sidebar element tree (right panel)

- Section header: thumbnail + `Generated image` + collapse chevron.
- Rows (indent by depth): segment crop thumbnail (24px rounded) + label; hover reveals
  **lock 🔒** and **trash 🗑** icons + expand chevron `›` (children: man › head › eyes/mouth;
  booth › parts).
- Row states: selected = indigo fill (like `tree` in the screenshot); **"A" sparkle badge** on
  rows that own an active prompt (`segment_prompts`); locked rows show padlock persistently and
  are excluded from editing ops; deleted = soft-deleted, hidden unless "Show deleted" toggle.
- Interactions: click = select (syncs canvas); double-click label = inline rename; drag to
  reorder siblings (`orderIdx`); chevron toggles children.

## Canvas overlay (shares plan 8's transform layer)

- Selected segment → **blue bounding box** with 8 drag handles (resize = update bbox) + move by
  drag; thin inner accent box for the "focus region" look.
- **Label chip**: small dark rounded chip with the segment label anchored near the box top-right
  (the "booth" chip in the screenshot).
- Hover (no selection): faint box + chip on hover for discoverability.
- Marquee tool (plan 8) selects every intersecting segment (multi-select: shift+click adds).
- Pointer tool click-testing order: deepest child first (eyes before man before composite).

## Floating Prompt card (the money shot)

- Anchored beside the selection (flips to stay in viewport), dark card `rounded-xl` shadow:
  - Header `Prompt` (small bold).
  - Body: segment caption (editable textarea on click — saves to `segment_prompts`, activates
    the row's "A" badge).
  - `Color Palette` section: swatch row (from plan 12 extraction) + `+` button (attach/create
    palette popover).
  - Footer actions: `Regenerate region` (plan 11) + lock + delete icons mirroring the tree row.
- Selection state lives in a Zustand/editor store: `{selectedSegmentIds, hoveredId}` single
  source for canvas + tree + card.

## API

- `PATCH /api/segments/:id` `{label?, bbox?, locked?, orderIdx?}`
- `DELETE /api/segments/:id` (soft)
- `GET/POST /api/segments/:id/prompts` (history of user prompts, isActive flag)

## Acceptance

- Reproduce Screen D with seeded data: click `tree` row → blue box with handles appears over the
  tree area, chip renders, Prompt card shows its caption + Color Palette with `+`, row highlights
  indigo with "A" badge; click `booth` row shows lock/trash on hover and expands to children.
- Move/resize the box persists normalized bbox (reload keeps it); marquee multi-selects;
  rename, lock, delete all reflect across tree + canvas instantly.
- 60fps box dragging (transform-layer math, no re-render of the image itself).
