# Plan 1 — Scaffold, Modules, Theme & App Shell

**Depends on:** nothing (first plan) · **Screens:** all (foundations)

## Goal

Create the Editorium project from the `create-cloudflare-saas-app` skill template, opt in to the
Cloudflare modules the whole build needs, and lay the visual foundation: the near-black theme,
app chrome (top bar, side panel skeleton) and client routing seen in all four screenshots.

## Steps

1. **Scaffold** — run the skill (`create-cloudflare-saas-app`) targeting this repo root:
   - Name: `editorium`.
   - The script copies the template, renames worker + D1 database, installs with locked pnpm,
     regenerates types, applies local migrations, and runs `pnpm check`.
2. **Opt-in modules** — add from the template's module set:
   - **auth** (required by everything user-scoped),
   - **R2** binding `MEDIA` (plan 3),
   - **Queues** binding `AI_JOBS` + consumer (plans 7/9/11),
   - **Workflows** bindings for `SegmentWorkflow`, `GenerateWorkflow`, `EnhanceWorkflow`
     (plans 7/9/11),
   - defer **billing** to plan 13 but reserve the module seam now.
   After each binding addition to `wrangler.json`: `pnpm cf-typegen`.
3. **Design tokens** — Tailwind theme matching the screenshots:
   - `--background` near-black (`#141414`-ish), panels `#1e1e1e`, elevated cards `#262626`,
   - hairline borders `rgba(255,255,255,0.08)`, text white/`#a3a3a3` secondary,
   - accent indigo-blue (`#3b4bd8`-ish) for selection highlight + active tool,
   - radius scale: `rounded-xl` cards/composer, `rounded-full` pills & send button,
   - font: clean grotesk sans (system stack or Inter), sizes ~13–15px UI.
   Build as shadcn/ui CSS variables so all later components inherit.
4. **App shell + routing** (React Router or template's router):
   - `/` → Dashboard (placeholder page, plan 4),
   - `/albums/:albumId` → AlbumCanvas (placeholder, plan 5),
   - `/albums/:albumId/images/:imageId` → Editor (placeholder, plan 8),
   - auth-gated layout with a persistent dark top bar slot (breadcrumb region, right actions slot)
     since all three screens share that chrome shape.
5. **TopBar component** (shared skeleton, slots filled per screen): left = logo mark + breadcrumb
   slot; right = contextual actions slot (search / filter / Upload / undo-redo / download / Share).
6. **CI** — confirm the template's CI runs the check gate on PRs.

## Acceptance

- `pnpm check`, `pnpm peers check`, `pnpm audit --audit-level high` all pass locally and in CI.
- Visiting the three routes (logged in) renders dark placeholder pages with the shared top bar.
- `wrangler dev` serves the SPA + API; D1 and R2 bindings typecheck in worker code.

## Notes

- The scaffold script refuses non-empty directories — ensure the repo root is clean of a previous
  attempt before running it.
- Do not deploy; remote resources stay uncreated until plan 14.
