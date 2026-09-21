# Plan 14 — Performance, A11y, E2E, Observability & Launch

**Depends on:** all · **Screens:** all

## Goal

Make it fast, accessible, tested end-to-end, observable in production — then ship staging → prod.

## Performance

- Images: long-cache R2 responses (`immutable`, 1y, keyed by content hash), `thumb` everywhere
  in lists (tree thumbnails 24px, cards 512px), `web` only in editor viewport; lazy-decode
  below fold; `srcset` on cards.
- Editor: transform-layer renders image once; segment overlay is SVG (boxes) + cached crop
  bitmaps — no React re-render per pointermove (rAF + refs).
- SPA: route-level code splitting (editor + heavy canvas libs lazy chunks); target LCP < 2.0s
  on dashboard, TTI < 3.5s on editor (Lighthouse CI gate).
- Workers: parallel D1 reads where independent; SSE heartbeat to dodge idle timeouts.

## Accessibility

- Full keyboard map: editor tools (V/M/P…), arrow-key segment cycling, Esc deselect, Enter open
  prompt card, tab order through tree; focus-visible rings tuned for dark theme.
- Canvas overlay: boxes get `role="button"` + aria-labels from segment labels; tree is a real
  treeview pattern; Prompt card = labelled dialog semantics.
- Contrast: secondary gray ≥ 4.5:1 on panel backgrounds; axe CI check on 3 routes.

## Testing (template's Vitest browser tests + unit)

- E2E happy paths: signup → create album → upload → segments appear (mocked providers) → select
  segment → edit prompt → regenerate → version undo → share link. Album chat: enhance flow.
- Golden-image tests for mask compositing (fixture masks, pixel-diff threshold).
- Load: consumer handles 50 queued jobs (miniflare queue emulation) without drops.

## Observability & runbook

- Workers Logpush/observability on; structured logs (jobId, userId, op, latency, provider cost).
- Analytics Engine events: `image_uploaded`, `segmentation_completed{count}`, `region_edited`,
  `enhanced`, `shared` — funneled to a simple internal dashboard route (`/admin`, owner-only).
- Alerts: job failure rate > 5%, queue depth > 100, provider 5xx spike.
- **Launch runbook:** create remote D1 + R2 + Queues + Workflows, `wrangler secret put` for
  provider keys, apply remote migrations, deploy worker + pages/custom domain, smoke-test
  checklist (upload → segment → edit → share on prod), rollback = previous deployment tag.

## Acceptance

- Lighthouse ≥ 90 perf / ≥ 95 a11y on dashboard + editor (prod build, local).
- E2E suite green in CI; axe clean; alerts wired to a test firing.
- Staging deployment completes the runbook; production deploy happens only on explicit request.
