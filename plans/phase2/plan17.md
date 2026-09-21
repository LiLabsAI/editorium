# Plan 17 — Live AI Mode: Real Recognition on Real Photos

**Fixes:** #6 · **Depends on:** — (can run parallel to 15/16)

## Goal

Make real Workers AI the primary path and demote the mock to an explicit,
labeled demo mode. Today `AI_MOCK=true` silently returns a canned scene for
any photo — the user's juice photo got "phone booth / tree / water" segments.
Recognition must describe *the actual image*.

## Backend

1. **Provider selection stays automatic but honest:**
   - `AI_MOCK=false` (live): detect → `MODEL_DETECT` on the uploaded image
     bytes; captions → `MODEL_VLM` per crop; hierarchy + face-band children
     per the phase-1 design.
   - `AI_MOCK=true` (demo): keep canned output **but label it** — segments
     API responses include `"recognizer": "demo"`, and the element tree
     header shows a small "Demo recognition" badge with a tooltip explaining
     how to enable live models. No silent pretending.
2. **Verify model IDs against the live catalog before shipping** (the
   phase-1 guardrail, never actually executed): check DETR-family object
   detection, a vision-language captioner, flux/schnell T2I, an instruct LLM.
   Update `MODEL_*` vars in `wrangler.json` to the current IDs; record the
   checked date in a comment.
3. **Robustness for real photos:**
   - Pre-resize inputs server-side (Images binding → ≤1024px JPEG) before
     model calls; skip tiny/corrupt images with a clear `segment` job error.
   - Map DETR COCO labels → friendly display labels (`person` stays `person`,
     `dining table` → `table`, etc.); drop score <0.45 and boxes >90% of the
     image area (background classes pollute the tree).
   - Batch captioning with limited concurrency (2) to respect model rate
     limits; per-region failures degrade to `partial` with box+label only.
4. **On-demand re-recognition UI** — the "Demo recognition" badge and the
   failed state both offer "Run live recognition" which calls the existing
   `POST /api/images/:id/resegment`; the button is disabled with a tooltip
   when the deployment is mock-only.
5. **Optional external provider seam (stretch):** implement the
   `ExternalProvider` adapter shape (env: `PROVIDER_URL`, `PROVIDER_KEY`)
   behind the same interface so SAM-class masks/upscalers can attach without
   product changes. No credentials in repo.

## Frontend

6. Editor sidebar: recognition source badge (`Live` / `Demo` / `Failed`) with
   re-run affordance; the loading state ("Recognizing objects…") shows live
   job progress from `GET /api/jobs/:id` (segment jobs already report 0–100).
7. Album cards: tiny spinner overlay while `segmentStatus === 'pending'`,
   subtle "recognized ✓" fade on ready (ties into plan 21's feedback layer
   but ship the minimal version here).

## Acceptance (browser-verified, live mode)

- With `AI_MOCK=false` + valid login: upload a portrait → the tree contains
  regions that actually exist in *that* photo (person + face children at
  correct positions, real background objects), captions mention real colors
  and placement. Verified on at least two different photos.
- Mock mode still fully works and is visibly labeled "Demo recognition".
- Forced provider failure → `partial` status with boxes retained and a retry
  path; no silent empty trees.
