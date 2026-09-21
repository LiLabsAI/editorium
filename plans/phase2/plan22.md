# Plan 22 — Browser E2E Harness + Release Checklist

**Depends on:** all phase-2 plans · **The phase-1 lesson institutionalized**

## Goal

Phase 1 passed unit tests while the editor was unusable — jsdom can't catch
geometry or interaction bugs. Phase 2 requires a **real-browser** gate that
exercises the actual user flows, plus a release runbook for live-AI mode.

## E2E harness

1. **Tooling:** browser automation via the `browser-use` control-browser /
   web-gui-tester skills against `pnpm dev` (miniflare runtime, mock AI for
   determinism). Scenario scripts live in `e2e/` as plain, replayable
   instruction files so any agent (or human) can run them.
2. **Critical-path scenarios** (each ends with an explicit visual assertion):
   - `e2e/select-and-edit.txt` — upload → wait for tree → hover shows box →
     click region → handled box + prompt card at the box → edit prompt →
     Regenerate → progress → pixels change → undo restores.
   - `e2e/enhance-chat.txt` — album → chat enhance request → progress →
     result thumbnail → adjacent canvas card → version list updated.
   - `e2e/tools.txt` — marquee multi-select, lasso custom segment, text
     annotation, duplicate, fullscreen Esc.
   - `e2e/share.txt` — share link works logged out; revoke kills it.
3. **CI integration:** a `pnpm e2e` script runs the harness in headed mode
   locally; wire it into `check` as a separate (non-blocking-by-default)
   script so the core gate stays fast, and make it blocking once stable.
   Screenshots from each run stored under `e2e/artifacts/` for diffing.
4. **Visual regression (light):** golden screenshots of dashboard / album /
   editor at 1440×900; flag diffs >2% for human review rather than
   auto-failing (dark-theme rendering noise).

## Release checklist (live AI)

5. Create remote resources: D1 (`editorium-db`), R2 (`editorium-media`),
   queue `editorium-ai-jobs`, workflow `editorium-segment`; apply remote
   migrations.
6. `wrangler secret put AUTH_SECRET`; set `AI_MOCK=false`; verify each
   `MODEL_*` ID against the live Workers AI catalog (record date + IDs in
   the PR); confirm plan limits for the models in use.
7. Deploy to staging first; run the same `e2e/` scenarios against staging
   with real models (assertions on captions relax to "non-empty + mentions a
   color or position word").
8. Smoke the money path with real credits: upload → recognition debunks the
   demo label → region edit → enhance → share.
9. Rollback plan: previous deployment tag; `AI_MOCK=true` hot-flip var if a
   model degrades.

## Acceptance

- All four E2E scenarios pass in a real browser against local dev with the
  fixes from plans 15–21; screenshots archived.
- `pnpm check` green; `pnpm e2e` green; release checklist committed as
  `plans/phase2/release.md` with checkboxes filled for staging.
- No deployment to production without the user's explicit go.
