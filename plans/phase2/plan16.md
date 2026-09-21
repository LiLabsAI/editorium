# Plan 16 — Real Region Editing: Endpoints + Working "Regenerate"

**Fixes:** #7 · **Depends on:** Plan 15 (selection must work first)

## Goal

Wire the product's core promise end to end: select a region, edit its prompt,
hit **Regenerate region**, and get new pixels *for that region only* — plus a
first-class enhance action. Phase 1 scaffolded neither endpoint.

## Backend

1. **`POST /api/images/:id/edit-region`** `{ segmentId, prompt, mode }`:
   - Auth + ownership; credit charge (2) with ledger + refund-on-fail (reuse
     plan-13 helpers); rate-limit check.
   - Enqueue `inpaint` job (`AI_JOBS`) with `chatMessageId: null`; return
     `{ jobId }` — the editor polls `GET /api/jobs/:id`.
   - Consumer path (`runInpaintJob`) already exists; upgrade it:
     - Load the mask if `segments.maskR2Key` exists; otherwise synthesize a
       feathered rectangular mask **client-side-quality** server-side: build
       an alpha PNG for the bbox (feather ≈ 4% of box size) with a tiny
       pure-TS PNG encoder (we only need gray+alpha, zlib via `CompressionStream`
       or a stored-mask fallback). Store it to R2 so later edits reuse it.
     - Crop-context i2i: crop box expanded 25% around the region, provider
       `imageToImage(prompt, strength=MODE_STRENGTH[mode])`, composite the
       generated crop back through the feathered mask onto the source — full
       composite becomes the new version (server-side canvas-free pixel work
       is only feasible for the SVG/mock path; for raster the *provider* must
       accept the crop+mask, so `WorkersAIProvider.inpaint` sends image+mask
       and falls back to crop-context i2i when the model rejects masks).
2. **`POST /api/images/:id/enhance`** `{ strength }` — same pattern as chat
   enhance but standalone (1 credit… keep 3 to match ledger costs).
3. **Job linkage** — both endpoints return jobId; jobs carry
   `resultImageId/resultVersionId` on completion (queue consumer already
   writes these into chat messages; add the same write onto the job row so
   non-chat callers can read the result).

## Frontend (Prompt card)

4. Regenerate button → `POST edit-region` → button becomes a **progress
   state** (0–100% from job polling, indeterminate until detect-style
   progress exists for inpaint: show "Editing region…" spinner).
5. On job done: swap the canvas image source (cache-busting, plan 18), keep
   the same selection, show a subtle "Region updated · Undo" toast (undo =
   activate parent version).
6. Error state: retryable error card in the prompt card ("Retry");
   `insufficient_credits` → upsell toast.
7. Reference-mode dropdown (Literal/Balanced/Creative) is passed through and
   visibly changes strength (assert in provider-mocked tests).

## Acceptance (browser-verified)

- Select the tree in a seeded image → edit prompt → Regenerate → progress →
  new version created, only the region visually changed (mock provider
  tint-composite makes this assertable), undo restores previous pixels.
- Direct enhance on an image from the editor top bar (new small ⬆ button
  beside undo/redo) → version "High-quality 4K enhance" appears.
- API tests: edit-region + enhance endpoints (auth, credits, job lifecycle,
  refund on forced provider failure).
