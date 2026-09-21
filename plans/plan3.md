# Plan 3 — Upload & Media Pipeline

**Depends on:** Plan 2 · **Screens:** B (Upload button), A (thumbnails)

## Goal

Get pixels into R2 safely and get every size variant the UI needs: original, web display,
thumbnail (album cards + segment tree thumbnails). This feeds every later screen.

## API (Hono)

| Route | Behavior |
|---|---|
| `POST /api/albums/:id/upload-url` | Returns short-TTL presigned R2 PUT URL + final `r2Key`; client uploads directly (keeps big files off the Worker). Fallback for dev: `POST /api/albums/:id/upload` multipart → Worker PUTs to R2. |
| `POST /api/images` | Register uploaded object: validate magic bytes + max size (e.g. 25 MB), read dimensions, create `images` row (kind `upload`), enqueue thumbnail job. |
| `GET /api/images/:id/file?variant=thumb\|web\|original` | Streams from R2 with long-lived `Cache-Control` + ETag; 302 to a custom-domain R2 URL in production. |
| `PATCH /api/images/:id` | Rename label, toggle bookmark (Screen B card menu). |
| `DELETE /api/images/:id` | Soft-delete → cascade rows; remove R2 objects. |

## Processing (Queue consumer or same Worker task)

1. Thumb/webp variants via Workers `ImageResizing` (Cloudflare Images binding) if available, else
   `wasm`-free approach: store original + request dynamic resize through images CDN; keep a fixed
   `thumb.webp` (512px) and `web.webp` (1600px) written back to R2.
2. Update `images.r2KeyThumb`; set album `coverImageId` if album has none.
3. **Hook point for plan 9:** after thumbnails, enqueue `segment` job (no-op until then).

## UI pieces (minimal here, full screens later)

- Shared `useUpload()` hook: pick files → presigned PUT → register → progress → invalidate queries.
- Image component `<R2Image imageId variant>` with skeleton shimmer on dark background.

## Acceptance

- Upload a 5 MB JPEG in dev → row in D1, objects in local R2 emulation, `thumb` and `web`
  variants render, album cover auto-set.
- Rejects: non-image bytes, oversize, wrong-owner album (403).
- Unit tests for register/validate; integration test hits local R2 binding.
