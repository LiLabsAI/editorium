# Plan 9 — ⭐ Auto-Segmentation Engine (detect → caption → layers)

**Depends on:** Plan 8 · **Screens:** C–D (the element tree and its captions)

## Goal

The flagship feature: when an image lands (upload **or** generation), automatically recognize
everything in it — the man, his head/eyes/mouth, the booth, the tree, the water — and persist each
as a hierarchical `segments` row with an AI-written caption. This is what powers the sidebar
element tree, the canvas boxes, and per-region prompting in plans 10–11.

## Pipeline (runs in the `segment` job from plans 3/7)

```
image ─▶ 1. DETECT      object detector → boxes + labels (top-K, dedup, NMS)
       ─▶ 2. HIERARCHY  group boxes (containment + class affinity): "man" ⊃ {head, eyes, mouth};
                        "booth" ⊃ {door, crown sign}; scenes ⊃ {sky, water, grass, tree…}
       ─▶ 3. RE-IDENTIFY  per box: crop → VLM produces (a) clean label, (b) 1–2 sentence
                        caption with position language ("image-left", "in front of", …)
       ─▶ 4. MASKS      per box: refine to a soft mask — provider options (pick at build):
                        a) Workers AI segmentation/matting model if catalog offers one,
                        b) external provider (SAM-class via fal.ai/Replicate adapter),
                        c) client-assist fallback: transformers.js SAM in browser on demand.
       ─▶ 5. PERSIST    segments rows (normalized bboxes, polygons/RLE → R2 mask.png,
                        label, caption, parentSegmentId, orderIdx), crop thumbnails to R2,
                        image.segmentStatus='ready'
```

- **Provider abstraction (build-time swappable):**
  `providers.detect(image)`, `providers.segment(box)`, `providers.caption(crop)`.
  v1 = all Workers AI (candidate models: DETR-resnet-50 for detect; a vision-language instruct
  model for caption; catalog check required). Masks may ship as v1 = box-alpha feathering, v1.5 =
  provider masks — the schema already supports both.
- **Face detail pass (the "eyes, mouth, head" requirement):** when a box is a person/face class,
  run a face-landmark model (catalog check; else external provider) → sub-segment
  `head → {eyes, mouth, nose, hair}` boxes relative to the parent.
- **Job mechanics:** Workflows `SegmentWorkflow` (multi-step, retryable per step); progress
  written to `jobs.progress` (detect 20% → captions 60% → masks 90% → persist 100%).
- **Failure:** captions failing leaves boxes+labels (status partial); total failure →
  `segmentStatus='failed'` with retry affordance in the editor sidebar.

## API

- `GET /api/images/:id/segments` → tree (nested by `parentSegmentId`) incl. thumb URLs + captions.
- `POST /api/images/:id/resegment` → re-enqueue (dev/tools).
- `GET /api/jobs/:id` already exists for progress polling.

## Frontend hookpoints (rendered by plan 10)

- Editor sidebar: poll `segmentStatus`; on `ready`, hydrate the element tree under
  "Generated image".
- Canvas: receives the segment tree and draws overlays (plan 10).

## Acceptance

- Uploading a photo like the reference (man + phone booth + sea + tree) yields a tree of ~8–12
  top-level segments incl. a person with head/eyes/mouth children, each with label + caption,
  visible via API within ~30s.
- Caption quality bar: mentions object + position relative to scene (matches the reference
  caption style without copying its text).
- Segment thumbnails (crops) stored and servable; re-running segmentation replaces rows
  idempotently (no duplicates).
- Workflow retries: injecting a caption-model error still yields boxes + `partial` status.
