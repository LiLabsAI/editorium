# Editorium

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Built on Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

An open-source, non-destructive **WebGL2 + AI photo editor and creative studio** running end-to-end on the Cloudflare Developer Platform. Upload a photo, adjust lighting and tone live on the GPU, isolate objects with brush/lasso/edge-aware magic wand or one-click BiRefNet subject extraction, and describe edits in plain language — every AI operation creates a **new branch beside the original**, never overwriting your source image.

🌐 **Live App**: [https://editorium.aliahad.workers.dev](https://editorium.aliahad.workers.dev)

---

## Core Design Principles

1. **Non-destructive by default** — Originals live immutably in R2 (`u/<user>/a/<album>/i/<image>/...`). Every edit branches alongside its parent with full `Cmd+Z` / `Cmd+Shift+Z` lineage navigation and before/after comparisons (`Split wipe`, `Side-by-side`, and hold `\` to peek).
2. **Fidelity-guarded AI models** — Every operation uses a model matched to its contract (`IMAGES` ESRGAN/segmentation vs `FLUX.2` / `Pruna`) and runs through [`src/worker/lib/fidelity.ts`](src/worker/lib/fidelity.ts) before persisting. If a model drifts too far from your photo, it is rejected and credits are refunded atomically.
3. **Zero polling lag** — Per-user Durable Objects ([`UserEventsDO`](src/worker/events.ts)) stream queued/running/completed/refunded job updates over hibernating WebSockets (`/api/events`).

---

## Features

### Real-Time WebGL2 Studio & Non-Destructive Grading
- **GPU Fragment Shader Pipeline** ([`src/react-app/editor/webgl.ts`](src/react-app/editor/webgl.ts)): Live adjustments with zero AI credit cost for **Exposure**, **Contrast**, **Highlights**, **Shadows**, **Warmth**, **Tint**, **Vibrance**, **Saturation**, **Clarity** (micro-contrast), and **Vignette**, plus **90° Rotation**, **Horizontal/Vertical Flip**, **Straighten (±45°)**, and interactive **Crop** handles.
- **Progressive Streaming Viewport** ([`src/react-app/editor/Canvas.tsx`](src/react-app/editor/Canvas.tsx)): Instant `web` preview upgraded asynchronously to full `original` resolution, cursor-anchored zoom (`0` to fit, `+`/`-`, pinch/trackpad), `Space + drag` panning, and full-resolution client baking on download/branching.
- **Text Annotation Overlays**: Place styled text captions on the canvas; baked into PNG overlays (`overlay.png`) for lossless compositing on downloads and shared links.

### Precision Selection & 4-Channel Masking
- **Box (`V`) & Layer Pick (`A`)**: Drag normalized regions or click auto-recognized objects.
- **Brush (`B`) & Eraser (`E`)**: Live translucent indigo selection painting (`[` / `]` brush sizing), exported as 4-channel RGBA masks.
- **Lasso (`L`)**: Freehand closed polygon selection.
- **Edge-Aware Magic Wand (`W`)**: Off-thread Sobel gradient + color flood-fill inside a Web Worker ([`src/react-app/editor/magicWand.worker.ts`](src/react-app/editor/magicWand.worker.ts)).
- **One-Click `✨ Subject` Cutout**: Calls Cloudflare Images BiRefNet (`segment: "foreground"`) to isolate the main subject as an editable RGBA layer mask (with one-click **Invert** to target the background).

### Deep AI Editing & Natural-Language Agent
- **Region Inpainting & Multi-Chip Batching**: Queue up to 5 masked or boxed edits into one combined AI generation pass (`edit_instructions` atomic locking).
- **One-Click Generative Erase**: Remove selected objects cleanly with surrounding texture fill.
- **Generative Outpainting (`Extend` / `O`)**: Drag canvas borders outward up to `4096×4096`; preserves original inner pixels cleanly through a feathered preservation mask.
- **References & Color Palettes (`Style Transfer`)**: Upload reusable style/product references (`POST /api/references`, max 3 per edit via `input_image_0..3`) and extract color swatches from photos to guide generations.
- **Two-Tier Chat Agent** ([`src/worker/agent.ts`](src/worker/agent.ts)): Fast deterministic routing + structured LLM JSON-schema intent classification across editing, enhancing, background removal, outpainting, visual Q&A, and text-to-image generation.
- **Auto Object & Scene Recognition** ([`SegmentWorkflow`](src/worker/workflows.ts), [`segmentation.ts`](src/worker/lib/segmentation.ts)): Combines DETR object detection, VLM person/face detail backstops, semantic scene bands, and cropped region captions.

### Workspaces, Metering & Sharing
- **Credit Ledger & Atomicity**: Atomic single-transaction D1 credit debits and idempotent refunds (`jobs`, `credit_events`), per-minute D1 + Cloudflare Rate Limiter enforcement (`AI_LIMITER`, `AUTH_LIMITER`, `MEDIA_LIMITER`), and Dead Letter Queue recovery (`editorium-ai-jobs-dlq`).
- **Token-Scoped Public Shares**: Configurable full-resolution download toggle, expiration timer, non-destructive grade preview, and instant revocation ([`ShareDialog.tsx`](src/react-app/components/ShareDialog.tsx), [`SharePage.tsx`](src/react-app/pages/SharePage.tsx)).

---

## Architecture

| Layer | Implementation |
|---|---|
| **Frontend SPA** | React 19, React Router 8, Tailwind CSS 4, WebGL2, Web Workers (`src/react-app/`) |
| **API & Auth** | Hono on Cloudflare Workers (`src/worker/routes/api.ts`, `auth.ts`), HMAC-SHA256 sessions |
| **Database** | Cloudflare D1 (SQLite) + Drizzle ORM (`database/schema.ts`, `drizzle/`) |
| **Object Storage** | Cloudflare R2 (`MEDIA` bucket) with ETag / `If-None-Match` (`304`) conditional caching |
| **Queues & DLQ** | `editorium-ai-jobs` + `editorium-ai-jobs-dlq` (`src/worker/queue.ts`) |
| **Realtime Events** | Durable Object WebSocket Hibernation API (`UserEventsDO` in `src/worker/events.ts`) |
| **Workflows** | `SegmentWorkflow` durable multi-step recognition (`src/worker/workflows.ts`) |
| **Media & AI** | Cloudflare Images binding (`env.IMAGES`) + Workers AI (`DETR`, `Moondream`, `Llama 3.2/3.3`, `Gemma 4`, `GLM 4.7`, `FLUX.2`, `Pruna`) |

### AI Operation Contracts

| Operation | Tooling / Models | Fidelity / Cost |
|---|---|---|
| **Enhance** | `IMAGES` ESRGAN upscale + sharpen | Same subject & composition · `3 credits` |
| **Remove background** | `IMAGES` BiRefNet foreground segmentation | Subject kept pixel-faithful on alpha · `1 credit` |
| **Region / Batch edit** | `FLUX.2 Klein` on padded crop + 4-ch mask composite | Pixels outside selection preserved · `2 credits` |
| **Outpaint** | `IMAGES` border pad + `FLUX.2` + inner feather mask | Original inner frame preserved · `2 credits` |
| **Reimagine / Style** | `Pruna P-Image-Edit` / `FLUX.2` multi-reference | Guarded against subject/structure drift · `2 credits` |
| **Generate** | `FLUX.2 Klein 4B` text-to-image | New image from prompt · `1 credit` |

---

## Local Development

### Prerequisites
- Node.js `>= 22.22.0`
- pnpm `>= 11.5.0`
- Cloudflare account (only needed for remote bindings or deploy; tests run offline via mock AI + Miniflare)

### Setup

```bash
pnpm install
pnpm cf-typegen       # sync Worker binding types from wrangler.json
pnpm db:migrate       # apply Drizzle migrations to local D1 (.wrangler/)
```

Create a git-ignored `.dev.vars` file for local secrets (min 32-char `AUTH_SECRET`):

```bash
AUTH_SECRET="replace-with-a-random-64-char-hex-secret"
OWNER_CLAIM_KEY="replace-with-your-owner-claim-key"
```

Start the Vite + Cloudflare Workers dev server:

```bash
pnpm dev
```

> **Note:** `wrangler.json` configures `AI_MOCK="false"` so `pnpm dev` calls live Workers AI / Images when remote bindings are active. Automated tests always run against the deterministic offline mock provider and local PixelOps.

---

## Verification & Testing

Run the full quality gate before opening a PR:

```bash
pnpm check
```

This runs:
1. `pnpm run db:check` — Drizzle schema & migration consistency check
2. `pnpm run lint` — ESLint (`--max-warnings 0`) across worker, client, and tests
3. `pnpm run test:app` — Vitest + Testing Library unit/UI tests ([`src/react-app/`](src/react-app/))
4. `pnpm run test:worker` — Vitest + `@cloudflare/vitest-pool-workers` integration tests with isolated D1, R2, Queues, and Durable Objects ([`test/worker/`](test/worker/))
5. `pnpm run build` — `tsc -b && vite build`
6. `wrangler deploy --dry-run` — Bundle & trigger verification

When modifying AI model adapters, you can validate against live Cloudflare Workers AI + Images models with:

```bash
pnpm probe:models
```

---

## Production Deployment

Secrets are declared in [`wrangler.json`](wrangler.json) under `secrets.required` and must never be placed in plaintext `vars`:

```bash
openssl rand -hex 32 | pnpm exec wrangler secret put AUTH_SECRET
openssl rand -hex 24 | pnpm exec wrangler secret put OWNER_CLAIM_KEY
```

Provision the queues if deploying to a fresh Cloudflare account, then migrate remote D1 and deploy:

```bash
pnpm exec wrangler queues create editorium-ai-jobs
pnpm exec wrangler queues create editorium-ai-jobs-dlq
pnpm run build
pnpm run deploy       # applies remote D1 migrations + runs wrangler deploy
```

Inspect or roll back deployments:

```bash
pnpm exec wrangler versions list
pnpm exec wrangler rollback
```

---

## Contributing

Contributions, bug reports, forks, and pull requests are welcome!
1. Fork [LiLabsAI/editorium](https://github.com/LiLabsAI/editorium) and create a feature branch.
2. Keep changes covered by unit or Worker integration tests (`pnpm test:app` / `pnpm test:worker`).
3. Ensure `pnpm check` exits cleanly with zero warnings before submitting your PR.

---

## License

Copyright (C) 2026 Ali Ahad / [LiLabsAI](https://github.com/LiLabsAI).

Editorium is free software licensed under the **GNU General Public License v3.0 (GPL-3.0)** — see [`LICENSE`](./LICENSE) for the full license text.

Under the terms of GPLv3:
- You may freely study, fork, modify, and redistribute the software.
- Any distributed modified versions or derivative works must also be licensed under GPLv3 with complete source code made available.
- Attribution and copyright notices must be preserved.
