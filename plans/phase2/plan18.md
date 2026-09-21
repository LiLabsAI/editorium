# Plan 18 — Version & Cache Integrity (Undo That Changes Pixels)

**Fixes:** #9 · **Depends on:** Plan 16 (more version producers exist)

## Goal

Phase 1 stores versions correctly but *shows* the wrong pixels after undo:
`variant=web` is only derived for the newest operation and served under an
immutable cache key, so activating an older version leaves the canvas
unchanged. Make version switching visually truthful and instant.

## Backend

1. **Version-aware variant derivation** — on `POST …/versions/:vid/activate`:
   - If the activated version lacks `web`/`thumb` derivatives, run
     `deriveVariants` from **that version's full object** (store per-version
     variant keys: `…/v/{vid}/web.webp` and `…/v/{vid}/thumb.webp`).
   - Add `versions` columns `r2KeyWeb`, `r2KeyThumb` (Drizzle migration).
2. **Cache-busting URLs** — `GET /api/images/:id/file` accepts
   `?variant=web&v={versionId}`; when a versionId is supplied, serve that
   version's variant key. Keep immutable caching (keys are now
   version-scoped, so immutability is safe).
3. **Segments per version** — segment rows are shared across versions today;
   that's acceptable (regions persist across edits), but a version switch
   after a *region edit* must keep boxes aligned: store
   `image_versions.basedOnSegmentIds` no-op for now and document that boxes
   reference the composite geometry (revisit only if misalignment shows).

## Frontend

4. `fileUrl(imageId, variant, versionId?)` — append `&v=versionId`; editor
   canvas and sidebar thumbnails all pass the **current version id**, so
   switching versions swaps pixels immediately (no stale immutable cache).
5. Undo/redo buttons walk the version chain and update canvas + thumbnails +
   the version dropdown in one refresh; disabled states correct at both ends.
6. Reload persistence: opening an editor route with `currentVersionId = v5`
   renders v5 (already true via `/file` fallback — now visually consistent).
7. "Region updated · Undo" toast from plan 16 uses the same activation path.

## Acceptance (browser-verified)

- Enhance an image (v2), click undo → canvas **pixels visibly change** back
  to v1; redo returns to v2; hard-reload keeps the correct version rendered.
- Devtools network: version switch fetches `…file?variant=web&v={vid}` and a
  second switch to a previously-seen version is served from cache (200 from
  disk) — correctness without losing caching.
- Migration applies cleanly; per-version variants exist in R2 for both
  versions.
