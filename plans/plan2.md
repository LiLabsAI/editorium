# Plan 2 — Data Model (D1/Drizzle) & R2 Layout

**Depends on:** Plan 1 · **Screens:** all (metadata backbone)

## Goal

Define every table the product needs, mirroring the reference product's domain: workspaces →
albums → images → versions → **segments (the auto-recognized objects)** → chat threads → jobs →
usage. Plus the R2 key layout for binaries.

## Schema (Drizzle, D1)

```ts
users            // from template auth module
projects         // "Md Ahad Ali's Project" — one per user in v1
  id, ownerId, name, avatarSeed (gradient initial), createdAt

albums           // "Enhanced Portrait of a Man by a Pink Telephone Booth"
  id, projectId, title, coverImageId?, createdAt, updatedAt

images           // any image in an album (upload OR generation result)
  id, albumId, kind: 'upload'|'generated'|'edited',
  r2KeyOriginal, r2KeyThumb, widthPx, heightPx, mime, sizeBytes,
  sourceImageId? (for enhanced-of / edited-of lineage),
  filenameLabel (the "5E482F90-…" style card label), bookmarkedAt?,
  segmentStatus: 'none'|'pending'|'ready'|'failed', createdAt

image_versions   // every edit/enhance output of an image (undo/redo/history)
  id, imageId, parentVersionId?, label ("High-Quality 4K Enhance…"),
  r2KeyFull, prompt?, createdAt, isCurrent

segments         // ⭐ auto-recognized objects = layers
  id, imageId, parentSegmentId? (hierarchy: man → head/eyes/mouth),
  label ("man","booth","tree"), caption (VLM description),
  bboxX, bboxY, bboxW, bboxH   -- normalized 0..1 box,
  maskR2Key? (png alpha mask or RLE), polygonJson?,
  lockedAt?, deletedAt?, aiPromptBadge (bool), orderIdx, createdAt

chat_threads     // per album (Screen B right panel)
  id, albumId, title, createdAt

chat_messages
  id, threadId, role: 'user'|'assistant', text,
  attachedImageId?, resultImageId?, resultVersionId?,
  operation? ('generate'|'enhance'|'edit'|'answer'), jobId?, createdAt

jobs             // async AI work (queue payloads + status for polling)
  id, type: 'segment'|'generate'|'enhance'|'inpaint'|'caption',
  imageId?, segmentId?, status: 'queued'|'running'|'done'|'error',
  progress (0..100), error?, workflowId?, createdAt, finishedAt

palettes         // plan 12
  id, ownerId, colorsJson, source: 'manual'|'extracted', createdAt

image_palettes   // many-to-many, plan 12
  imageId, paletteId

segment_prompts  // user-edited prompt per segment (Screen D Prompt card)
  id, segmentId, text, isActive, createdAt

references       // "References" tab assets (Screen A)
  id, projectId, r2KeyThumb, kind, createdAt
```

Indexes: `images(albumId)`, `segments(imageId)`, `chat_messages(threadId)`,
`jobs(status)`; foreign keys cascade on delete.

## R2 key layout (bucket `MEDIA`)

```
u/{userId}/a/{albumId}/i/{imageId}/original.{ext}
u/{userId}/a/{albumId}/i/{imageId}/thumb.webp
u/{userId}/a/{albumId}/i/{imageId}/v/{versionId}/full.{ext}
u/{userId}/a/{albumId}/i/{imageId}/seg/{segmentId}/mask.png
u/{userId}/a/{albumId}/i/{imageId}/seg/{segmentId}/crop.png   // segment thumbnail
```

## Steps

1. Write schema in `src/server/db/schema.ts` (template's Drizzle setup).
2. Generate + apply local migration (`drizzle-kit generate` → template's migrate task).
3. Seed script: demo project/album/images for local dev.
4. Repository modules per aggregate (`albumsRepo`, `imagesRepo`, `segmentsRepo`, `chatRepo`,
   `jobsRepo`) — typed queries used by all later API routes.
5. Zod schemas for each entity shared client/server (strict TS end to end).

## Acceptance

- Migration applies clean on a fresh local D1; `pnpm check` passes.
- Seed script populates a project with one album + two images + a threaded chat, matching the
  shape visible in the screenshots (album meta line, message roles, image lineage).
