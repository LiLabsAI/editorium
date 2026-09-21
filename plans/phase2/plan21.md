# Plan 21 — Progress & Feedback Layer

**Fixes:** #12 · **Depends on:** Plans 16–17 (producers exist)

## Goal

Every async AI operation must be *visible*: queued → running (with progress)
→ done/error. Today they run silently, so the app feels inert even when the
pipeline is working.

## Shared client primitives

1. **`useJob(jobId)` hook** — polls `GET /api/jobs/:id` with backoff
   (1s → 2s → 4s, cap 5s), returns `{ job, result }`, stops on terminal
   state; shared by cards, prompt card, chat chips, editor canvas.
2. **Toast system** — adopt the template's `sonner` dependency (already in
   package.json): success ("Region updated · Undo"), error (with Retry
   action), info (credits charged, share link copied). Dark-themed.

## Surfaces

3. **Upload & recognition:** album image cards show a shimmer + "Recognizing
   45%" overlay while the segment job runs (album page already receives the
   `segmentJobId` from upload — thread it through React state); on failure:
   red badge + retry icon. Editor route shows the same via sidebar status.
4. **Generation:** chat result card and album canvas both show progress
   (generate jobs report coarse progress; indeterminate spinner until the
   provider returns). Generated card appears *before* pixels arrive as a
   skeleton tile in lineage position (adjacent to source), then fades in.
5. **Enhance / region edit:** determinate progress on the enhance toast and
   the prompt card button; canvas dims slightly with "Enhancing…" pill while
   running.
6. **Errors:** every job surface renders the job's `error` string with a
   Retry button (re-enqueue via the original endpoint with the same
   parameters); `insufficient_credits` renders the upsell dialog (plan 13
   copy) instead of a generic failure.
7. **Empty/edge states:** album with zero images (existing), zero segments
   after a failed run (retry), references tab (kept as an honest "coming
   soon" panel until a later phase ships it).

## Acceptance (browser-verified)

- Upload → card shows recognition progress %, then the tree populates;
  force a provider failure (mock flag) → visible error + working Retry.
- Generate from the Create tab → skeleton card in lineage position → image
  fades in; chat shows the same progress; credits toast appears.
- All of it visible with CPU throttling (progress states last long enough to
  be seen at 4× slowdown).
