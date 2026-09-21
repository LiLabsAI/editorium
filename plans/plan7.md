# Plan 7 — Text-to-Image Generation Jobs

**Depends on:** Plan 6 · **Screens:** B (result thumbnails), A (generated images in albums)

## Goal

The `generate_image` tool behind the chat: enqueue an async text-to-image job, run it on Workers
AI, store the result as a first-class `images` row (kind `generated`) in the album, surface it on
the canvas next to its thread and in the chat as a thumbnail.

## Backend

- **Queue pipeline:** producer (API tool handler) → `AI_JOBS` queue → consumer Worker:
  1. Mark `jobs` row `running`, report progress events.
  2. Call Workers AI T2I (candidate: `@cf/black-forest-labs/flux-1-schnell` — 4-step fast
     model; verify ID + steps/limits in the live catalog; abstract behind
     `providers.t2i(prompt, opts)`).
  3. Write PNG to R2 (`…/i/{imageId}/original.png`), create `images` row kind `generated`,
     run plan-3 thumbnail pass, link `chat_messages.resultImageId`.
  4. Mark job `done`; enqueue `segment` job (plan 9 hook — generated images get recognized too,
     matching how the reference editor shows element trees on generated images).
- **Workflows alternative:** `GenerateWorkflow` (Workflows binding) if retries/sleep
  orchestration is preferred over a raw queue consumer; both shapes defined, pick one at build.
- **API:**
  - `POST /api/albums/:id/generations` `{prompt, aspect, count}` (also used by editor Create tab)
  - `GET /api/jobs/:id` → status/progress/result
  - `GET /api/images/:id/lineage` → thread + source links for canvas adjacency.
- **Failure paths:** model 429/5xx → exponential retry ×3 in consumer → job `error` → chat shows
  retryable error card with "Retry" action (re-enqueue, same message row).

## Frontend

- Chat result card (plan 6) goes live: shows progress bar from job polling → swaps to thumbnail.
- Canvas: generated image cards appear with a small "Generated" badge + lineage adjacency.
- Album card counts update (`2 images · last month` pattern).

## Acceptance

- Prompt via chat → job lifecycle visible (queued→running→done, progress ticks) → new image card
  on canvas + inline chat thumbnail within ~10s locally (mock provider for tests).
- Provider mock in Vitest covers success/retry/error; consumer test asserts R2 objects + rows.
- Concurrency: 3 simultaneous generations don't starve the consumer (batch=1 or per-user lock).
