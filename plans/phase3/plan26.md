# Plan 26 — Deploy to the User's Cloudflare Account

**Goal:** the user explicitly asked why nothing is deployed. Wrangler is
authenticated (account `aliahad`). Deploy the real stack with live AI.

## Remote resources

1. `wrangler d1 create editorium-db` → write the real database_id into
   `wrangler.json` (placeholder replaced per template guidance now that the
   user requested remote resources).
2. `wrangler r2 bucket create editorium-media`.
3. `wrangler queues create editorium-ai-jobs`.
4. `pnpm db:migrate:remote` (apply Drizzle migrations).
5. Secrets/vars: `wrangler secret put AUTH_SECRET` (generated, not committed);
   set `AI_MOCK=false`; keep `MODEL_*` vars pointing at the verified catalog
   IDs (incl. `MODEL_INPAINT`).
6. `wrangler deploy` → workers.dev URL.

## Configuration checks before deploy

- Compatibility date fine for Queues + Workflows; queue consumer wired.
- Observability stays on; logpush note for job events.
- Staging/production split deferred (single worker for now) — documented.

## Acceptance

- `https://editorium.<subdomain>.workers.dev` serves the app; health check
  green against remote D1; upload lands in remote R2; segmentation job runs
  through the remote queue with real models (AI_MOCK=false); chat enhance
  produces real pixels.
