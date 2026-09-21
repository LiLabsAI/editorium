# Plan 5 — Album Canvas + Ask Composer UI (Screen B)

**Depends on:** Plans 3, 4 · **Screen:** B

## Goal

Build the album workspace: a dark free-form canvas where the album's images sit as cards, the
breadcrumb top bar with Upload, and the right-side chat panel shell with the **Ask** composer
(UI only — the AI brain arrives in plan 6).

## UI spec (from Screen B)

- **Top bar:** `logo  {project} / {album title}` breadcrumb (album segment editable via double-
  click), then right cluster: `…` overflow, search icon, `All ⌄` (type filter: all/uploads/
  generated), **Upload** pill button (white bg, dark text, `rounded-full`).
- **Canvas area (left, flexible):** dark `#161616`; images as draggable cards in a pannable,
  zoomable plane (start simple: CSS grid "flow" mode + zoom slider; free-form drag = stretch).
  - **Image card:** cover image, top-left check-select circle, top-left filename label chip
    (e.g. uppercased UUID head + `…`), `…` card menu (open in editor, bookmark, download,
    delete), bottom-right bookmark ribbon when saved. Click card → editor route.
  - Lineage grouping: a generated result renders adjacent (right of) its `sourceImageId`
    original — reproduces the "original next to enhanced" arrangement in the screenshot.
- **Right panel (fixed ~430px, border-l hairline):**
  - Header: `Create` (bold) · sliders icon (generation settings, placeholder) · `Chat ⌄` dropdown
    (switch threads / new thread).
  - Message list: user messages as rounded-2xl dark-gray bubbles (right-leaning); assistant
    messages as plain text on background (no bubble), inline `R2Image` thumbnails for results,
    clickable → editor.
  - **Composer (bottom, rounded-2xl `#1e1e1e`):** placeholder "Ask Editorium", row of icon
    buttons: paperclip (attach image from album/upload), `@` (mention an album image → chip),
    palette swatch (plan 12); right: circular send button (up-arrow) — disabled when empty.
    Enter sends, Shift+Enter newline; streaming assistant text renders progressively (plan 6).

## API

- `GET /api/albums/:id` → album + images (with lineage) + threads.
- `GET /api/albums/:id/images?filter=`
- `PATCH /api/images/:id` reuse from plan 3 (label/bookmark/position if free-form).
- Thread/message CRUD lands with plan 6; this plan ships the panel with local optimistic echo.

## Acceptance

- Seed album renders like Screen B: two adjacent image cards with labels, bookmark icon, Upload
  pill, chat panel with composer.
- Upload via the pill adds a card to the canvas live (React Query invalidation).
- Composer accepts text + attach + `@` mention chip and displays the outgoing bubble; sending
  stores a pending user message (assistant reply stub "…" until plan 6).
- Keyboard: Enter send, Shift+Enter newline; card menu actions work (delete removes card).
