# Plan 25 — Hybrid AI Detection: DETR + VLM Inventory + Person Parts

**Goal:** the user requirement — eyes, head, clothes, trees, sky must be
detected by AI, not heuristics. No single Workers AI model does full
segmentation, so the pipeline becomes a **three-model hybrid**, all AI:

## Pipeline (replaces parts of `runDetection`/`runCaptioning` in live mode)

1. **DETR pass** (`detr-resnet-50`): COCO objects with accurate boxes —
   person, cup, chair, potted plant, car… (existing filters kept).
2. **VLM scene inventory** (llama-3.2-11b-vision): one structured ask —
   "List the major SCENE regions in this photo (sky, water, ground, wall,
   foliage, road, snow, interior surfaces…). For each: name + vertical band
   (top/middle/bottom) + one-line look." Rendered as horizontal band boxes
   clipped between neighboring bands. This gives the AI-grounded sky/water/
   ground regions DETR cannot see, straight from model output.
3. **Person parts pass**: for each `person` box, crop the upper 45%, ask the
   VLM: "Locate head, eyes, mouth, upper clothing in this crop. Reply JSON
   with approximate percentage boxes." VLM boxes are coarse — accept ±15%
   tolerance, clamp into the person box, and mark sub-segments
   `accuracy: 'approximate'` in the caption prefix so the UI can be honest.
   Clothes: full-torso box below the head band (VLM-verified).
4. **Caption pass** (unchanged): per-region VLM captions with placement
   language.
5. **Cross-check**: VLM-inventory regions whose band contains no DETR object
   and less than 8% pixel share (per VLM claim) are dropped — hallucination
   guard.

## Data / UI

6. `segments` rows gain `detector` ('detr' | 'vlm-inventory' | 'vlm-person');
   tree shows a small badge per row (boxes = strong detection, sparkle = VLM).
7. Tree tooltip: "Detections are AI-generated; approximate regions marked ~".
8. Re-run pipeline order documented in the segment job progress:
   detect 25% → inventory 45% → parts 60% → captions 85% → persist 100%.

## Acceptance

- Real portrait: person + head/eyes/mouth/clothes (VLM boxes, honestly
  marked approximate) + scene bands the VLM actually reports.
- Real landscape: sky / water / ground bands + trees/objects from DETR.
- No fabricated regions: everything traces to a model output logged with the
  job (debug log includes per-pass summaries).
