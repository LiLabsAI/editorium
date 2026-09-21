# Plan 4 — Dashboard: Albums & References (Screen A)

**Depends on:** Plan 2 (Plan 3 for cover images) · **Screen:** A

## Goal

Rebuild the dashboard: workspace hero, Albums/References tabs, sort/filter/search controls, and
the card grid including the "New album" placeholder card.

## UI spec (from Screen A)

- **Top bar:** logo mark + project name (small, secondary).
- **Hero row:** 72px rounded-2xl gradient avatar with the project initial (auto gradient from
  name hash), project title in large type + chevron ⌄ menu (rename, delete).
- **Tab row:** `Albums` (active = white) / `References` (gray), left; right cluster:
  `By newest ⌄` sort dropdown (newest/oldest/name), `All ⌄` filter (all/mine), search icon that
  expands to an inline search input filtering by title.
- **Grid:** responsive `auto-fill minmax(220px, 1fr)`; gap ~24px.
  - **New album card:** flat `#262626` square, centered `+` icon, caption below: bold
    "New album", secondary "Create images and videos" → opens create dialog (title input) or
    creates immediately with generated title.
  - **Album card:** square cover (thumb variant, `object-cover`, rounded-lg), title truncated to
    one line, meta line `{n} images · {relative time}` in secondary gray. Hover: subtle lift +
    show `…` menu (rename, delete). Click → `/albums/:id`.
- **References tab:** grid of reference thumbnails (plan 2 `references` table); v1 = empty state.

## API

- `GET /api/projects/current` → project + counts.
- `GET /api/albums?sort=&q=` → list with `imageCount`, `coverThumbUrl`, `updatedAt`.
- `POST /api/albums` `{title?}` → creates + navigates.
- `PATCH/DELETE /api/albums/:id`.
- `GET /api/references` (stub ok).

## State/data

React Query (or template convention) with optimistic create/rename/delete.

## Acceptance

- Matches Screen A structurally: hero, tabs, sort/filter/search, 4-card row renders from seed
  (one new-album card + three album cards with correct meta text pattern).
- Search filters client-side < 100ms for 500 albums (server search paginated).
- Empty states: zero albums → only the New album card.
- Vitest component tests for grid rendering + dialog flow.
