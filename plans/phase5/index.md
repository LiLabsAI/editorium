# Editorium — Phase 5: Editor history and context-aware composer

## Why (user report, 2026-09-25)

The editor's right rail showed only static tips. While chatting, running
presets and editing selected regions, the user could not see what they asked,
what came back, what failed, or which photo/region the next message targets.
Example: "add eye contact lenses" (Reimagine, whole photo) also turned the red
drink green — nothing in the panel recorded the request or suggested a region
edit instead.

Root cause: editor actions (Enhance, Remove background, region edits, Reimagine,
B&W / Golden hour) create jobs and branch photos but write **no chat messages**;
only the album page chat persisted a conversation. The facts exist (jobs,
image_versions audit, lineage) but are scattered and never shown.

## Decisions

- **One history per photo family** (the original plus every branch — what the
  filmstrip shows). Implemented as a chat thread keyed by `(album, root image)`.
- **Chat can trigger edits.** The composer is the single entry point: with a
  drawn box it runs a region edit; without one, the agent answers questions or
  runs the operation the message asks for.

## Design

1. **Server-side record.** Every action writes a request message and a reply
   message (linked by `reply_to_id`) at job creation; the queue links the
   result on completion. Entry state (pending / running / done / error,
   refund) is derived from the job row, so reloads, other tabs and failures all
   show the truth. Legacy branches without messages are derived from
   `image_versions` so existing albums get history immediately.
   - `images.root_image_id` (backfilled with a recursive CTE)
   - `chat_threads.root_image_id` (+ unique `(album_id, root_image_id)`)
   - `chat_messages.image_id / root_image_id / op_class / bbox_json / reply_to_id`
2. **History panel.** Chronological turns: your request (text + class chip +
   region) and its reply (thumbnail, label, class, fidelity, credits;
   Open / Show region / Retry / Edit prompt). Failures stay visible with the
   reason and "credits refunded". Pending entries update in place. Filter:
   All / Edits / Chat.
3. **Context-aware composer.** Chips for the target photo and the selected box
   (×), a line stating what will happen and its cost, and a hint when a
   whole-photo prompt names one object: "draw a box to change only that".
   Selection is context only — the canvas popup is removed (phase-3 direction).
4. **One conversation.** Questions are answered in the same history; album
   page lists photo histories read-only with a link into the editor.
5. **Behaviour.** Pinned composer, stick-to-bottom autoscroll, `aria-live`
   status, click result → filmstrip, hover → outline region on canvas,
   ↑ recalls last prompt, tips become the empty state.

## Progress

- [x] Step 1 — server-side history: migration 0007 (`images.root_image_id`
      backfilled by recursive CTE; family threads; message history columns),
      `lib/history.ts` (record + timeline + legacy derivation), every route and
      the chat agent record request/reply pairs, `GET /images/:id/history`.
- [x] Step 2 — `HistoryPanel`: turns with class chip + region, live pending
      state, results (thumbnail, promise, fidelity, credits, Open / Retry /
      Redo on a region / Edit prompt), failures with reason + refund, filter,
      stick-to-bottom, `aria-live`, hover outlines the region on the canvas.
- [x] Step 3 — `EditComposer`: photo + box chips, mode/cost line, "draw a box
      to change only the X" hint, ↑ recall; the canvas popup is gone — a
      drawn box is context applied from the composer.
- [x] Step 4 — composer without a box talks to the agent in the family
      thread (questions answered in the same history); album page lists photo
      histories read-only with a link into the editor.
- [x] Verified on production (fe09acc0+): B&W → region edit → question →
      reimagine all recorded; persists across reload and across branches.
