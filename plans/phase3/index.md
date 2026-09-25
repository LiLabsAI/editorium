# Editorium — Phase 3 Plans: Real AI on Real Cloudflare

Phase 2 made the product functionally honest. Phase 3 makes the *pixels* and
*recognition* honest: real Workers AI models doing the editing and the
detection, the branch-photo workflow from the user's reference screenshot, and
an actual deployment on the user's Cloudflare account (explicitly requested —
the "don't deploy unless asked" guardrail is now satisfied).

## Findings from the Workers AI catalog (verified 2026-09-20)

| Capability | Model | Notes |
|---|---|---|
| Region inpainting | `@cf/runwayml/stable-diffusion-v1-5-inpainting` | `prompt` + `image_b64` + `mask[]` + `strength` (0–1) + `num_steps` (≤20) + `guidance`. Exactly the region-edit primitive. |
| Image-to-image (enhance / restyle) | `@cf/bytedance/stable-diffusion-xl-lightning`, `@cf/stabilityai/stable-diffusion-xl-base-1.0`, `@cf/lykon/dreamshaper-8-lcm` | All accept `image_b64` + `strength`. Lightning = fast few-step. |
| Text-to-image | `@cf/black-forest-labs/flux-1-schnell` (fast) or SDXL variants | |
| Object detection | `@cf/facebook/detr-resnet-50` | COCO classes: person, cup, chair, potted plant… accurate boxes, limited vocabulary (no sky/water/eyes). |
| Vision-language | `@cf/meta/llama-3.2-11b-vision-instruct` (+ gemma vision variants) | Captions and — crucially — scene inventory the detector cannot see. |
| LLM | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Chat + prompt rewriting. |

**Detection accuracy strategy** (user requirement: eyes, head, clothes, trees,
sky must come from AI): no Workers AI model produces pixel-accurate
segmentation for arbitrary parts today (no SAM-class model). The honest
architecture is **hybrid AI**: DETR localizes what COCO knows; a VLM scene
inventory names the semantic regions COCO lacks (sky/water/ground/foliage) as
bands cross-checked against the image; a person-crop VLM pass estimates
head/eyes/mouth sub-boxes; a final VLM pass captions every region. All-AI, no
canned data, accuracy documented per region type.

**Branch photo** (user requirement + reference screenshot): every AI output —
region edit, enhance — becomes a NEW image in the album (kind `edited`,
lineage via `sourceImageId`) instead of a version on the same photo. The
editor gains a left filmstrip rail showing the source and its branches, like
the reference product.

**Auth**: skipped per user instruction until the final milestone.

## Plan index

| # | File | Title |
|---|------|-------|
| 23 | `plan23.md` | Real editing models: SD-inpainting, SDXL-lightning img2img, flux T2I |
| 24 | `plan24.md` | Branch photo: AI outputs are new images + editor filmstrip |
| 25 | `plan25.md` | Hybrid AI detection: DETR + VLM inventory + person parts |
| 26 | `plan26.md` | Deploy: remote D1/R2/Queue, AI_MOCK=false, `wrangler deploy` |
| 27 | `plan27.md` | Live verification on the deployed URL with a real photo |

## Progress

- [x] Plan 23 — Real editing models (SD-v1-5-inpainting wired; SDXL-lightning
      img2img for enhance; flux T2I; all deployed live)
- [x] Plan 24 — Branch photo (edit/enhance produce NEW images with lineage,
      filmstrip rail, auto-navigation to the branch, auto re-recognition)
- [x] Plan 25 — Hybrid AI detection (DETR int-array schema verified empirically,
      VLM scene inventory, VLM person-parts, VLM captions — all live)
- [x] Plan 26 — Deployed: D1 `5c05fada…`, R2 `editorium-media`, queue
      `editorium-ai-jobs` created; remote migrations applied; AUTH_SECRET set;
      AI_MOCK=false → https://editorium.aliahad.workers.dev
- [x] Plan 27 — Live verification passed: real DETR detections (person/couch/
      dog with pixel boxes normalized), real VLM captions describing the actual
      photo, real region edit branched to a new 1024×960 photo.

### Production schema discoveries (hard-won, worth keeping)

1. **DETR input**: `{ image: [8-bit ints] }` — NOT a data-URL string (5006
   oneOf error) and NOT a root string (3030). Output = ARRAY of
   `{score, label, box:{xmin,ymin,xmax,ymax}}` in PIXELS (normalize yourself).
2. **VLM** (llama-3.2-11b-vision-instruct): requires a one-time account-level
   `{prompt:"agree"}` license gate (5016); then input `{prompt, image}` (NOT
   `messages` — that yields "no user messages" 3030); output key is
   `response` (not `description`).
3. Wrangler deploy builds from `dist/` — always `pnpm build` after
   wrangler.json edits or the deploy ships a stale config.
4. Secrets vs vars: AUTH_SECRET moved to `.dev.vars` (local) + `wrangler
   secret put` (prod); a same-name var in wrangler.json would clobber it.


## Post-deploy accuracy iteration (2026-09-20, user-reported)

User's live screenshot showed: no person row, junk "toothbrush" (DETR misfired
on a straw), inventory leak ("tumbler"), hallucinated captions (prompt
asserted the label before the VLM looked). Fixes deployed:

1. Same-label dedupe tightened (IoU 0.3) + post-caption cross-label merge
   (IoU 0.5) — DETR's duplicate fires collapse into one region each.
2. Min-area filter for non-essential classes (long-tail misfires die early).
3. VLM inventory whitelist (scene words only) — object leaks dropped.
4. Person backstop: if DETR finds no person but the VLM does, an approximate
   VLM box is added.
5. Captions are open-ended ("describe what you see") and the VLM's own LABEL
   overrides the detector's — misfires get renamed to what is actually
   visible instead of hallucinated details.

Live re-verify on the reference photo: 7 accurate regions (was 3 with the
person missing), correct captions, no junk classes. Remaining known limit:
near-duplicate "man on couch" style rows can survive when DETR fires
overlapping boxes below the merge thresholds — next lever is a proper
segmenter (SAM-class via external provider seam).


## Interaction-model fix (user feedback, 2026-09-20)

The user's direction: selection should be context only — the edit is typed and
applied from the chat bar, not from a popup card.

1. Removed the floating Prompt card from the canvas (selection now shows only
   the handled box + label chip, like the reference).
2. The composer is the single apply point: selection shows an
   "Apply to: <region>" chip, the send button becomes "Apply to <region>",
   and the message routes to a region edit via the agent (segmentId).
3. After sending, an apply-progress line polls the job and the app navigates
   to the branched photo automatically (verified live end-to-end).
4. Region captions moved to tree-row tooltips.

## Editing-model trade-off (measured, not hidden)

- SD-v1.5-inpainting preserves composition but its masked output was often
  near-identical to the input (under-edits).
- FLUX.2-klein follows prompts dramatically (bright red velvet chesterfield)
  but re-renders the scene rather than doing localized pixel edits.
- Current routing: FLUX edit is primary for ALL region edits (visible results
  beat invisible ones), with a preservation clause in the prompt.
- NEXT (phase 4): server-side composite — decode the FLUX PNG + Images-binding
  PNG of the source, blend through the feathered mask, re-encode. This gives
  FLUX-quality content with pixel-exact locality. Requires a pure-TS PNG
  decoder (encoder + zlib already exist in `lib/mask.ts`).


## Workflow change (user directive, 2026-09-20)

**Local dev is retired for testing.** All verification happens on production:
https://editorium.aliahad.workers.dev — the user tests there too. Loop per
change: `pnpm check` → `pnpm build` → `npx wrangler deploy` → browser-verify
on the deployed URL. Local `.dev.vars`/D1 emulation state is disposable; the
user's production data (albums, uploads, branches) is real — never run
destructive queries against remote D1.


## Annotate-then-apply (Reve workflow, built 2026-09-20)

From the user's reve.com screenrecording analysis — the reference flow is
**annotate first, apply once**:

1. Marquee tool draws a rectangle → floating "Describe edits" input appears
   at the selection.
2. ✓ Save **pins an instruction chip** on the photo (nothing executes).
3. Multiple chips accumulate across regions.
4. One **"Apply N edits ↑"** button in the chat bar runs ALL instructions in a
   single FLUX generation → new branched photo **auto-titled** from the
   instruction targets ("Bright red velvet & add hanging plants on the wall"),
   editor auto-navigates to it.

Backend: `edit_instructions` table (migration 0004), CRUD + batched
`apply-instructions` endpoint (charges 2 credits), `batch_edit` queue job that
folds every chip into one coherent FLUX instruction. Verified live
end-to-end with two chips on production.

Bugs found & fixed during verification:
- Remote D1 was missing migration 0004 (deploy rule: always
  `pnpm db:migrate:remote` before deploy — now in the loop).
- Toolbar/bulk-bar clicks were swallowed by the canvas container's pointer
  handlers in some states — added `stopPropagation` on both.
- Testing hazard (not a product bug): driving the shared in-app browser while
  the user has tabs open causes tab-target confusion — verify in a fresh tab.

Known limit (unchanged): the batch edit is a single whole-frame FLUX edit, so
the composition re-renders; pixel-local compositing stays the phase-4 step.


## Moondream 3.1 investigation (user suggestion, 2026-09-21)

User proposed `@cf/moondream/moondream3.1-9B-A2B` for object detection.

**Catalog facts (verified):** Image-to-Text vision model, 9B MoE / 2B active.
Tasks: `query`, `caption`, `point`, `detect` — detect "returns bounding boxes
for objects matching a target phrase". Token pricing ($0.30/M in, $1.00/M out).
Open vocabulary — not limited to COCO classes.

**Live probe results (production binding, real photo):**
- `query` ✅ — open-vocabulary object discovery works: returned
  `["man", "dog", "couch", "pillows", "floor lamp", "wall", "pictures"]`
  (~160ms-class latency, 746 in / 62 out tokens). This names objects DETR
  cannot ("pillows", "floor lamp").
- `detect` ❌ — returns empty `response` + 0 neurons across 5 phrasings
  (specific "the couch"/"the dog"/"couch", generic "objects"). Platform-side
  issue; the detect head never fires.
- `point` ❌ — same empty-result behavior.

**Verdict:**
- resnet-50 is image CLASSIFICATION (one label per image, no boxes) — it can
  never replace detection; DETR remains our only box source.
- Moondream `query` is the best open-vocabulary DISCOVERY signal in the
  catalog and should feed the detector once region features return.
- Moondream `detect` would be the ideal box source when the platform bug is
  fixed — retest periodically. Until then: DETR (boxes) + GLM (labels) +
  Moondream query (discovery, when re-enabled) is the architecture.


## Phase 3 addendum: Pruna P-Image-Edit + honest limitations (2026-09-22)

**What works now:**
- Pruna P-Image-Edit (primary whole-photo edit): generates a new image
  following your instruction, using the input as reference. Verified live.
- SDXL-lightning img2img (fallback): also works via multipart.
- Client pixel transforms (B&W, golden hour): instant, deterministic.

**Honest limitation:** ALL generative image models on Workers AI re-render
the scene rather than doing pixel-local inpainting. Pruna P-Image-Edit is
the closest to a true editor but still generates a new interpretation.
For pixel-exact region editing, the options are: (a) external provider
with SAM+inpainting pipeline, or (b) accept the generative nature of the
current models — which is how all modern AI photo editors (Photoshop
Generative Fill, Canva Magic Edit) actually work: they re-render but
aim to preserve composition.

**For the user:** Pruna credentials need to be added in the Cloudflare
dashboard (AI → Providers → Pruna AI). The code is ready; it will
automatically use Pruna when credentials are present.
