# Editorium

An AI photo editor on Cloudflare Workers. Upload a photo, describe a change (or draw a region and describe it), and every edit becomes a **new photo beside the original** — the original never changes.

## Architecture

- **SPA** — React 19 + React Router 8 + Tailwind 4 (`src/react-app`), served as Workers static assets.
- **API** — Hono on one Worker (`src/worker`): `routes/api.ts`, `routes/auth.ts`.
- **Data** — D1 via Drizzle (`database/schema.ts`, migrations in `drizzle/`); media in R2 under `u/<user>/a/<album>/i/<image>/…`.
- **AI jobs** — every model call runs on the `editorium-ai-jobs` Queue (`src/worker/queue.ts`); clients poll `/api/jobs/:id`.
- **Image operations** — each has a fidelity contract (see `plans/phase4/index.md`):
  - *Enhance* — Images binding ESRGAN upscale + sharpen (same content).
  - *Remove background* — Images binding `segment: "foreground"` (subject untouched).
  - *Region edit* — FLUX.2 on a padded crop, composited back through a feathered mask (outside the region is byte-identical).
  - *Reimagine* — free-text whole-photo edit: Pruna P-Image-Edit, else FLUX.2 with the photo as `input_image_0`.
  - Every result passes a fidelity guard (`src/worker/lib/fidelity.ts`) before it is saved; failures are refunded.
- **Images binding** — variants, EXIF-correct dimensions, crops, upscaling, segmentation, compositing (`src/worker/lib/pixels.ts`).

## Accounts

Every browser gets its own private **guest account** (`POST /api/auth/guest`, rate-limited per IP). Sessions are HMAC-signed cookies keyed by the `AUTH_SECRET` secret.

The pre-auth demo account (`OWNER_USER_ID` in `wrangler.json`) is restored by opening **`/claim`** and entering the `OWNER_CLAIM_KEY` secret.

## Secrets

Declared in `wrangler.json` under `secrets.required`; deploy fails if either is missing. Never put them in `vars`.

| Secret | Purpose |
|---|---|
| `AUTH_SECRET` | Signs sessions and short-lived image URLs (≥ 32 chars) |
| `OWNER_CLAIM_KEY` | Unlocks `/claim` for the owner account |

Local development reads them from `.dev.vars` (git-ignored). Production:

```bash
openssl rand -hex 32 | pnpm exec wrangler secret put AUTH_SECRET
```

## Development

```bash
pnpm install
pnpm db:migrate   # local D1 under .wrangler/
pnpm dev
```

`wrangler.json` sets `AI_MOCK="false"`, so local dev calls the real (billed) Workers AI models. Tests always use the offline mock provider.

## Verification

```bash
pnpm check   # drizzle check, lint, app + worker tests, build, deploy dry-run
```

Worker tests (`test/worker`) run in the Workers runtime with an isolated D1, R2 and Queue, including the queue consumer end to end. They use a mock AI provider, which cannot detect a real model ignoring its input — so after changing any model adapter, also run:

```bash
pnpm probe:models   # production pixel code vs live Images + Workers AI; outputs in .probe/
```

## Deploy

Schema before code: `pnpm deploy` applies remote D1 migrations, then deploys.

```bash
pnpm check
pnpm deploy
pnpm exec wrangler versions list
pnpm exec wrangler rollback
```

After changing bindings in `wrangler.json`, run `pnpm cf-typegen`.
