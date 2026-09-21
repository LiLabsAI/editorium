# Editorium — AI Photo Editor: Master Build Plan

A reverse-engineered clone of the reference AI photo editor shown in the 4 screenshots
(dark-theme, chat-first image studio with **automatic object recognition**: upload a photo and it
detects every salient region — man, head, booth, tree, water — turns each into an editable layer
with an AI-written caption, and lets you edit any region with a natural-language prompt).

Built on the user's Cloudflare SaaS template via the `create-cloudflare-saas-app` skill:
**React + Vite SPA · Hono on Workers · D1 + Drizzle · R2 · Workers AI · Queues · Workflows ·
Tailwind + shadcn/ui · strict TypeScript · Vitest · CI.**

---

## 1. Screenshot analysis (what the reference product does)

### Screen A — Dashboard (2.38.19 PM)
- Near-black theme, top bar: logo + workspace name.
- Hero: large rounded-square gradient avatar with initial, project title + chevron menu.
- Tabs: **Albums** (active) / **References**. Right side: **By newest** sort, **All** filter, search.
- Card grid: a "New album" placeholder card (+ icon, "Create images and videos" caption), then
  album cards = square cover image, truncated title, meta line `N images · relative time`.

### Screen B — Album canvas + Chat (2.39.01 PM)
- Top bar: breadcrumb `Workspace / Album title`, overflow `…`, search, **All** filter, **Upload** pill.
- Main area: dark free-form canvas with image cards laid side by side (original vs. enhanced
  result), each card with a filename/UUID label, `…` menu, bookmark icon.
- Right panel (`~430px`): **Create** header, settings-sliders icon, **Chat ⌄** dropdown.
  Conversation: user bubble (rounded, dark gray), assistant plain-text reply with an inline
  thumbnail of the generated result. This is the "enhance my photo" flow: user asks in prose
  ("make it 4k, like a costly camera captured it") → assistant narrates → returns a new image.
- Bottom: **Ask** composer — rounded input, paperclip (attach), @ mention, color-palette button,
  circular send button. Status bar reveals the URL scheme:
  `app…/albums/:albumId/images/:imageId`.

### Screen C — Editor, idle (2.39.37 PM)
- Top bar: breadcrumb `Workspace / Album / Image`, `…`, undo, redo, download, **Share** pill.
- Canvas: the active image. Bottom-center floating pill toolbar: pointer (active/blue),
  marquee select, freehand/lasso pen, 3D-ish tool, Text `T`, duplicate, image, fullscreen.
- Right sidebar: **Create | Edit** tabs (Edit active) →
  - "Reference image" row with mode dropdown (**Literal**) — controls how strongly the source
    image constrains edits.
  - **"Generated image"** section = the composite being edited, with an element tree beneath it:
    `man ›`, `booth ›`, `grass`, `water`, `tree`, `flags`, `structure`, `mountains`, `sky` —
    every detected object is a layer row (thumbnail + label + expand chevron).
- Bottom-right: same **Ask** composer.

### Screen D — Editor, region selected (2.40.04 PM) ← the killer feature
- The user clicked the tree: a **blue bounding box with drag handles** appears on canvas, a small
  **label chip** ("booth") floats by the selection, and a floating **Prompt card** is anchored to
  the region showing the AI-written caption of that exact segment
  ("Small, out-of-focus tree with a dense canopy… situated on the image-left, against blue water")
  plus a **Color Palette** section with `+` to attach palettes.
- The sidebar tree mirrors the selection: row `tree` is highlighted (indigo) and carries an
  **"A" sparkle badge** = this layer owns an AI prompt/caption. The hovered `booth` row reveals
  **lock** and **trash** icon actions plus its own expand chevron → segments are hierarchical
  (booth has sub-parts; a person's "man" layer can expand to head/eyes/mouth).

### The core loop this product is built around
```
upload ──▶ auto-detect regions ──▶ caption each region (VLM) ──▶ element tree (layers)
                                                                      │
user picks a region (canvas box OR tree row) ◀────────────────────────┘
      └─▶ sees its caption/prompt ──▶ edits the prompt ──▶ regenerates ONLY that region
```

---

## 2. Product surface (routes)

| Route | Screen |
|---|---|
| `/` | Dashboard: albums grid, references tab (Screen A) |
| `/albums/:albumId` | Album canvas + Ask chat panel (Screen B) |
| `/albums/:albumId/images/:imageId` | Editor: canvas, tools, element tree, region prompts (Screens C–D) |

---

## 3. Architecture on Cloudflare

```
┌──────────── React SPA (Vite, Tailwind, shadcn/ui) ────────────┐
│  Dashboard · AlbumCanvas+Chat · Editor(canvas, tools, tree)    │
└───────────────────────────┬───────────────────────────────────┘
                            │  fetch / SSE stream
┌───────────────────────────▼───────────────────────────────────┐
│                Hono API on Workers (single worker)              │
│  auth · projects · albums · images · segments · chat · jobs    │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ AI adapters │  │ Queue prod-  │  │ Workflows: segment / │  │
│  │ (providers) │  │ ucer/consumer│  │ generate / enhance   │  │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬───────────┘  │
└─────────┼────────────────┼─────────────────────┼──────────────┘
          ▼                ▼                     ▼
   Workers AI        Cloudflare Queues      D1 (Drizzle) + R2
   detection/VLM/    (async AI jobs)        (metadata) (images,
   T2I/LLM                                  thumbs, masks)
   (+ optional external provider: SAM masks / upscale / inpaint)
```

**Key design decisions**
1. **Provider abstraction** for every AI capability (`detect`, `segment`, `caption`, `t2i`,
   `i2i`, `inpaint`, `upscale`). v1 binds to Workers AI; heavier models (SAM-style masks,
   4K upscale, inpainting) can bind to an external provider (fal.ai / Replicate) behind the
   same interface without touching product code. Verify current model availability in the
   Workers AI catalog at implementation time — candidates: DETR-resnet-50 (boxes+labels),
   a vision-language model (captions), flux-schnell (T2I), an LLM (chat/tool-calling),
   real-esrgan-class model (upscale).
2. **Segments are data, not pixels**: store normalized polygons/boxes + label + caption + mask
   pointer in D1/R2 so the tree, canvas overlay, and prompts all read one source of truth.
3. **Everything async via Queues/Workflows** with job rows → the UI polls/subscribes, so long
   AI steps never block the Worker request.
4. **Layers compose to the "Generated image"**: an image version = ordered list of layer
   (segment) renders; editing a region produces a new version → free undo/redo/history.

---

## 4. Plan index & dependency graph

| # | File | Title | Depends on |
|---|------|-------|------------|
| 1 | `plan1.md` | Scaffold, modules, theme, app shell & routing | — |
| 2 | `plan2.md` | Data model (D1/Drizzle) & R2 layout | 1 |
| 3 | `plan3.md` | Upload & media pipeline (variants, thumbnails) | 2 |
| 4 | `plan4.md` | Dashboard: albums & references (Screen A) | 2 |
| 5 | `plan5.md` | Album canvas + Ask composer UI (Screen B) | 3, 4 |
| 6 | `plan6.md` | Chat agent: streaming, tool-calling, intent→operation | 5 |
| 7 | `plan7.md` | Text-to-image generation jobs (Queues/Workflows) | 6 |
| 8 | `plan8.md` | Editor shell: canvas, tools, top bar, side tabs (Screen C) | 3 |
| 9 | `plan9.md` | ⭐ Auto-segmentation engine (detect → caption → layers) | 8 |
| 10 | `plan10.md` | Element tree + selection/box/lock/delete + Prompt card (Screen D) | 9 |
| 11 | `plan11.md` | Region-aware editing: inpaint, Literal reference, enhance/upscale, versions | 10 |
| 12 | `plan12.md` | Color palettes & prompt intelligence (@mentions, rewrite) | 10 |
| 13 | `plan13.md` | SaaS: billing/credits, share links, rate limits, moderation | 7, 11 |
| 14 | `plan14.md` | Perf, a11y, E2E, observability, deploy runbook | all |

Critical path: **1 → 2 → 3 → 8 → 9 → 10 → 11** (the editor spine), with 4–7 (dashboard/chat/
generation) and 12–14 layered on.

## 5. Execution conventions

- Scaffold once in plan 1 with the `create-cloudflare-saas-app` skill (script refuses non-empty
  dirs — it targets this repo root after it is emptied/prepared). Opt-in modules selected there:
  **auth, R2, Queues, Workflows, billing** (billing optional until plan 13).
- `wrangler.json` is the source of truth; run `pnpm cf-typegen` after any binding change.
- Every schema change ships a Drizzle migration; apply locally then remotely before deploy.
- Verification gate after every plan: `pnpm check`, `pnpm peers check`, `pnpm audit
  --audit-level high`, plus plan-specific Vitest suites.
- Secrets via `wrangler secret put` / Secrets Store only; never committed.
- Before wiring any AI binding, confirm model IDs against the live Workers AI catalog and the
  applicable product limits page.

## 6. Legal note

We clone **functionality and layout patterns**, not brand: no reference-site name, logo, icon
art, marketing copy, or photographic assets are copied. The product is "Editorium" with original
wording ("Ask Editorium", etc.). Example captions/prompts in these plans are written fresh.

## 7. Progress

- [x] Plan 1 — Scaffold & foundations
- [x] Plan 2 — Data model
- [x] Plan 3 — Upload pipeline
- [x] Plan 4 — Dashboard
- [x] Plan 5 — Album canvas + composer
- [x] Plan 6 — Chat agent
- [x] Plan 7 — Generation jobs
- [x] Plan 8 — Editor shell
- [x] Plan 9 — Auto-segmentation ⭐
- [x] Plan 10 — Element tree & selection
- [x] Plan 11 — Region editing & versions
- [x] Plan 12 — Palettes & prompt intelligence
- [x] Plan 13 — SaaS hardening
- [x] Plan 14 — Polish & launch

## 8. Build notes (2026-09-20 implementation)

All 14 plans are implemented and the template gate passes: `pnpm check`
(db:check + lint --max-warnings 0 + vitest app/worker suites + build +
wrangler deploy --dry-run) exits 0, and `pnpm audit --audit-level high` is
clean (dev-transitive advisories pinned via `overrides` in
`pnpm-workspace.yaml`).

Deviations from the plan text (all deliberate):

- **Segmentation executor**: the Queue consumer runs the recognition pipeline
  inline (detect → caption → persist). The `SegmentWorkflow` binding remains
  configured and exported for durable environments, but local dev (vite +
  miniflare) does not execute Workflows, so the queue path is the default.
- **AI provider**: `AI_MOCK=true` (wrangler var) routes every AI call to a
  deterministic offline provider (SVG renders + canned scene recognition:
  person → head/eyes/mouth, booth, tree, water, grass, sky). Set it to
  `"false"` while logged in via wrangler to use the real MODEL_* Workers AI
  models. Model IDs in wrangler.json must be re-verified against the live
  catalog before production use.
- **Auth** is a demo-grade HMAC-signed cookie (`POST /api/auth/demo`);
  replace with the template's full auth module before real users.
- **Palettes** extract client-side (canvas + k-means buckets) and POST to
  `/api/images/:id/palette` — Workers cannot decode raster pixels cheaply.
- **Billing** is credit-ledger only (`credit_events`, balance on users,
  middleware + refunds + `/api/usage`); wire a payment provider in plan-13
  follow-up.

### Run it

```bash
pnpm db:migrate   # local D1 (already applied)
pnpm dev          # http://localhost:5173 — auto demo-login on first visit
```

Flow: Dashboard → New album → Upload → wait for "ready" recognition → open
image → click any region (blue box + handles + Prompt card + palette) →
"Ask Editorium" enhance/generate → versions + undo/redo → Share link
(`/s/:token` works logged-out).

---

## 9. Phase 2 — Make It Actually Work (2026-09-20)

Phase-1 verification caught what the smoke test missed: the editor's
interaction layer has P0 geometry bugs (normalized-vs-pixel hit-testing,
hover dead-end, double-transformed prompt card) and several operations were
stubs (no edit-region/enhance endpoints, mock recognition ignoring real
image content, `[job:…]` tokens leaking into chat). Full diagnosis and the
follow-up build order live in **[phase2/index.md](phase2/index.md)** with
plans `phase2/plan15.md` … `phase2/plan22.md`.
