# Plan 24 — Branch Photo: AI Outputs Are New Images + Filmstrip

**Goal:** the user's missing feature (and the reference screenshot): when AI
edits or regenerates anything, the photo is **copied and generated as a new
one**. The original never changes.

## Backend

1. `storeOperationResult`: `edit`/`enhance` outputs now create a **new image
   row** (`kind: 'edited'`, `sourceImageId` = source) with a root version
   labeled by the operation, instead of a version on the source. The source
   image's pixels and versions are never touched.
2. Lineage query: `GET /api/images/:id/branch` → source + all sibling
   branches (images sharing the same root source, ordered by creation) with
   thumbs.
3. Keep `?source=` adjacency on the album canvas (existing lineage grouping).

## Frontend

4. **Editor filmstrip rail** (left edge, like the reference screenshot):
   vertical thumbnails — the source photo first, then each branch newest-last,
   active one outlined. Click = navigate to that editor route.
5. After a region edit or enhance completes, the app **navigates to the new
   branched image** (the user sees the result become "their current photo"),
   with a toast: "Branched from <original label> · Undo = go back" (Undo =
   navigate back to the source; version undo remains within an image).
6. Album canvas: branched cards show a small "branch" glyph + sit adjacent to
   their source (lineage grouping already does adjacency).
7. Segments: branched images re-run recognition automatically (existing
   `segmentStatus: 'pending'` hook) so the new photo has its own live tree.

## Acceptance

- Edit a region on photo A → editor navigates to photo B ("Edited grass"),
  filmstrip shows A → B; album canvas shows B adjacent to A; A's pixels and
  versions unchanged; B re-recognizes automatically.
- Enhance branches the same way. Chat-initiated edits also branch.
