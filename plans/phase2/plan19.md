# Plan 19 — Editor Chat & Composer: One Thread, Real Attach, Clean Narration

**Fixes:** #8, #10 · **Depends on:** Plan 16

## Goal

The editor's "Ask Editorium" box currently creates a throwaway thread per
message (work vanishes), attaches nothing, and the mock narration streams
internal tokens like `[job:enhance]` into visible text. Make chat a coherent,
context-aware surface in both album and editor.

## Backend — narration hygiene

1. **Agent output contract:** the agent — never the provider — decides what
   is user-visible. Tool references move to structured SSE events only
   (`event: tool`); any `[job:…]`-style tokens are stripped from text deltas
   before enqueue (`text.replace(/\[job:[^\]]*\]/g, "")` in the stream pipe).
2. **Mock narration** returns clean prose (no bracket tokens); the canned
   "closing line" is dropped — the real result card is the closing line.
3. **Describe operation** streams the VLM caption for the attached image as
   the assistant reply (works in mock with the canned caption).

## Backend — thread & context model

4. **One thread per album** (v1 semantics): `POST /albums/:id/threads`
   returns the existing latest thread instead of always creating; "New chat"
   in the dropdown explicitly creates one. Editor and album share the album's
   thread, so work done in the editor is visible in the album panel.
5. **Editor context:** messages sent from the editor automatically carry
   `attachedImageId = current image` and, when a segment is selected,
   `segmentId` + active prompt (add optional `segmentId` to the message
   schema + agent input). The agent routes "make this tree golden" with a
   selected tree segment to `edit-region` (plan 16 endpoint) instead of a
   whole-image op — the chat becomes a second way to drive region editing.

## Frontend

6. **Album page** — unchanged layout; thread dropdown lists real threads
   with "New chat" action; streamed narration is clean prose; tool events
   render as a subtle inline status chip ("Enhancing image…" with spinner)
   that resolves into the result thumbnail card.
7. **Editor sidebar** — the composer area gains a collapsible mini-thread
   (last ~4 messages + result thumbs) so responses are visible without
   leaving the editor; selection context chip appears above the input
   ("Editing: tree — 'make it golden'") with an × to drop the segment
   context.
8. **Composer attach buttons do real work:** paperclip opens the album-image
   picker (grid popover, multi-select → attachment chips); `@` mentions keep
   the existing type-to-filter; palette chips (plan 12) pass `paletteIds`
   through to the agent (already wired in the API contract).
9. Job progress chips: message with a `jobId` polls its job and shows a
   determinate/indeterminate progress inline; completion swaps in the result
   thumbnail and refreshes the album canvas.

## Acceptance (browser-verified)

- In the editor with the tree selected, type "make it golden autumn" → the
  status chip shows region edit progress → the canvas region updates (mock
  tint) and the *same* thread shows the exchange from the album page too.
- No `[job:…]` text ever appears; every send shows progress then a result;
  attachments/mentions produce chips and influence the target image.
