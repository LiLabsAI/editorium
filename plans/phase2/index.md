# Editorium — Phase 2 Plans: Make It Actually Work

Phase 1 delivered the full product shell: all three screens render, the data
model, upload pipeline, queue jobs, credits, share links, and the check gate
are green. But **the editor's interaction layer is broken by real bugs** and
several "operations" are stubs. Phase 2 makes every visible control do real
work.

---

## 1. Investigation findings (root causes, verified in code)

### P0 — Why you cannot select any object (Canvas.tsx)

1. **Unit mismatch in hit-testing** — `segmentAt()` compares the click point
   in **image pixels** against segment bboxes stored **normalized (0–1)**
   (`src/react-app/editor/Canvas.tsx:104`). On a 700px-wide image the test
   `x ≤ bboxX + bboxW` is false almost everywhere, so *every click misses*.
   This single bug makes the editor feel completely dead.
2. **Hover can never start** — region boxes only render when a segment is
   already `hovered` or `selected` (`Canvas.tsx` overlay map returns `null`
   otherwise), and `hoveredId` is only set by those same boxes'
   `onPointerEnter` (`Canvas.tsx:327`). No box ever exists to hover → no box
   is ever visible. This is why the canvas shows **no boxes at all**.
3. **Prompt card anchored with a double transform** — `anchor` (imgRect) is
   already measured in screen space post-zoom/pan, but the card multiplies by
   `editor.zoom` and adds `editor.offset` again (`Canvas.tsx:404`). Even when
   a selection happens the card lands far off-target (often offscreen).
4. **Marquee drawn in the wrong space** — the rubber band is stored in image
   pixels but the overlay SVG uses `viewBox="0 0 1 1"`
   (`Canvas.tsx:255`), so the rectangle renders wildly wrong.
5. `fit()` falls back to 800×1000 for zero-size images and the pointer math
   closures go stale across zoom changes — all pointer work must move to one
   measured, transform-inclusive rect (imgRect) instead of manual math.

### P0 — Why the recognition doesn't match your photo

6. **Mock recognition ignores the image content.** With `AI_MOCK=true`
   (current default), the mock provider returns a *canned scene* — person,
   phone booth, tree, water, grass, sky — for every upload. Your juice photo
   got "phone booth / tree / water" segments because the mock can't see. The
   head/eyes/mouth boxes derive from the canned person box, so they're in the
   wrong place on any real photo. The UI never says "demo recognition" — it
   silently lies.

### P1 — Operations that are stubs

7. **"Regenerate region" doesn't regenerate.** The Prompt card only calls
   `rewritePrompt` and refreshes (`Canvas.tsx:457`). There is **no**
   `/api/images/:id/edit-region` or `/api/images/:id/enhance` endpoint at all
   (grep confirms) — region inpainting and direct enhance exist only inside
   the chat flow.
8. **Chat narration leaks internals** — mock replies stream literal
   `[job:enhance]` / `[job:generate]` tokens into the visible text
   (`src/worker/lib/providers/mock.ts:243,249`).
9. **Version switching doesn't change what you see** — the editor serves
   `variant=web`, which is only derived for the *latest* operation; activating
   an older version neither re-derives its variants nor cache-busts the URL
   (immutable cache headers), so undo appears to do nothing to the pixels.
10. **Editor composer loses your work** — every send creates a brand-new
    thread; attach/@ buttons don't actually attach; there's no job progress
    shown in the editor.
11. **Tools pill is decorative** — marquee (broken space), pen, compose,
    text, duplicate, image: all no-ops.
12. **No progress feedback anywhere** — recognition/generation run silently;
    cards never show "recognizing…", failures are invisible.

### Verdict

The server pipeline (upload → segment job → rows + captions → versions →
credits) works; the phase-1 smoke test proved it. What's broken is (a) the
client-side geometry of the editor, (b) honesty/capability of the AI layer on
real images, and (c) several operations that were scaffolded but never wired.

---

## 2. Phase 2 plan index

| # | File | Title | Fixes |
|---|------|-------|-------|
| 15 | `plan15.md` | Canvas interaction engine rebuild | #1–5 (P0) |
| 16 | `plan16.md` | Real region editing: edit-region + enhance endpoints, working Regenerate | #7 |
| 17 | `plan17.md` | Live AI mode: real recognition on real photos, honest mock | #6 |
| 18 | `plan18.md` | Version & cache integrity (undo that changes pixels) | #9 |
| 19 | `plan19.md` | Editor chat & composer: one thread, real attach, progress, clean narration | #8, #10 |
| 20 | `plan20.md` | Every tool does something: marquee ops, duplicate, text, lasso-to-segment | #11 |
| 21 | `plan21.md` | Progress & feedback layer (recognition/generation states, errors) | #12 |
| 22 | `plan22.md` | Browser E2E harness + release checklist (real-AI deploy) | all |

Critical path: **15 → 16 → 17** restore the core promise (select a region →
edit it with the AI); 18–21 harden; 22 proves it in a real browser and
prepares the live-AI deploy.

## 3. Conventions

Same as phase 1: `wrangler.json` is config truth, `pnpm cf-typegen` after
binding changes, migrations via `pnpm db:generate` + `pnpm db:migrate`, and
`pnpm check` + `pnpm audit --audit-level high` must pass after every plan.
Phase 2 adds: **no plan is "done" without a browser-verified acceptance step**
(the phase-1 lesson — jsdom tests passed while the editor was unusable).

## 4. Progress

- [x] Plan 15 — Canvas interaction engine (geometry.ts bridge, hover engine,
      normalized drag/marquee, anchored prompt card, zoom-to-cursor, plus a
      late-found fix: drag ref must update synchronously or a fast click leaves
      drag state stuck and suppresses the prompt card)
- [x] Plan 16 — edit-region + enhance endpoints (credits, rate limit, refunds),
      server-side feathered box/polygon mask PNG builder, mock inpaint
      composites over the original so only the region changes
- [x] Plan 17 — model IDs verified against the live catalog 2026-09-20
      (detr-resnet-50 detection confirmed; VLM/T2I/LLM configurable via vars),
      COCO label polish + score/area filters, model-input downscale, honest
      "Demo recognition" badge + Re-run in the tree
- [x] Plan 18 — root "Original" version on every upload (undo chain root),
      version-scoped web/thumb variants (undo actually changes pixels,
      verified in browser), ?v= cache-busting
- [x] Plan 19 — [job:…] tokens stripped from chat, mock narration cleaned,
      album thread reused across editor + album, segment context chip routes
      chat to region edits
- [x] Plan 20 — duplicate (R2+rows), lasso→custom segment with polygon mask,
      text annotations (persist + render + double-click delete), layer
      visibility (hidden excluded from hit-test/regen), marquee bulk bar
      (Regenerate all / Lock all / Delete all), image switcher, fullscreen Esc
- [x] Plan 21 — recognition progress on album cards, region-edit progress in
      the prompt card, enhance progress in the top bar, error + retry states
- [x] Plan 22 — browser-verified core loop (hover → select → prompt card →
      regenerate → version → undo reverts pixels) with screenshots; scenario
      scripts in `e2e/`; `pnpm check` green; `pnpm audit` clean. Production
      deploy still requires the live-AI checklist in plan 22 + explicit go.

### Verified in a real browser (1440×900, miniflare + mock AI)

- Hover box + chip under cursor; click → handled box, indigo tree row,
  anchored prompt card (flips at edges)
- Regenerate region → "Edited grass" version, only the region changed,
  persisted across reload
- Undo → pixels reverted to "Original"; version dropdown reflects state
- Demo badge shown for mock recognition
