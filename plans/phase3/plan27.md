# Plan 27 — Live Verification on the Deployment

**Goal:** prove the whole promise on the deployed URL with a real photo:
real recognition, real region edit, real branch.

## Checks (browser, on the deployed URL)

1. Upload a real photograph (the "Man Drinking Juice" style portrait).
2. Recognition: element tree fills with regions the models actually found
   (person + parts where the VLM finds them; scene bands; detected objects).
   Each row traces to a model pass; "Live" recognizer badge shows.
3. Select a region → edit prompt → Regenerate:
   - job runs the real SD-inpainting model;
   - result **branches into a new photo**; editor navigates to it;
   - filmstrip shows source → branch; album canvas shows both adjacent.
4. Enhance from chat → new photo, visibly crisper, lineage chip present.
5. Version dropdown on the branched photo shows its operation root; undo
   within the branch works.
6. Credits: balance debited per operation; ledger entries correct.

## Failure budgets

- Model 429/5xx → queue retry → visible error + refund (already built).
- VLM garbage JSON → JSON-repair pass; falls back to DETR-only tree with
  `partial` status (never a fabricated tree).

## Acceptance

All checks pass on `https://editorium.<subdomain>.workers.dev` with real
models; screenshots archived; usage visible on the Cloudflare dashboard.
