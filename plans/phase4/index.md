# Editorium — Phase 4: Fidelity-first image processing

## Why (incident, 2026-09-25)

"Enhance (AI)" on a portrait returned a **different person**. Root cause, verified
against the live Workers AI catalog (`/ai/models/schema`) and Cloudflare docs:

1. Pruna P-Image-Edit (primary) failed: `2021: Insufficient AI Gateway credits`.
2. The FLUX.2 klein fallback never received the photo. FLUX.2 only reads reference
   images sent as **binary multipart fields `input_image_0..3`, each < 512×512**;
   we sent a base64 string named `image`, which is silently ignored.
3. FLUX therefore ran pure text-to-image on "enhance this photo … professional
   camera quality" → a generic studio portrait.
4. The second fallback (SDXL-lightning) is also blind: its schema is JSON
   (`image` int array / `image_b64`), not multipart, and default `strength: 1`
   repaints everything.

Every FLUX "edit" since phase 3 was text-to-image. The phase-3 note "FLUX
re-renders the scene" was this bug, not model behaviour. The mock provider can
never catch a model ignoring its input — real-model contract checks are needed.

## Principle: every operation declares a fidelity contract

Route each operation to a tool that is *structurally unable* to violate it.

| Class | Operations | Tool | Contract |
|---|---|---|---|
| **Adjust** | B&W, golden hour, sharpen, contrast, crop, rotate | Images binding `transform()` / client canvas | Deterministic; composition identical |
| **Enhance** | "Enhance (AI)", upscale | Images `upscale: "generate"` (ESRGAN) + `sharpen`; or `pruna/p-image-upscale` | Same content, more resolution/detail |
| **Segment** | Remove background | Images `segment: "foreground"` (BiRefNet) | Pixels kept or cut, never repainted |
| **Local edit** | Region edits (drawn box / chips) | Mask → inpainting / FLUX on a crop → **composite back** with Images `draw()` (`composite: "in"`, then `"over"`) | Pixels outside the mask byte-identical |
| **Reimagine** | Free-text whole-photo edits | Pruna P-Image-Edit, or FLUX.2 with `input_image_0` | May change anything; labelled as reinterpretation |
| **Generate** | Text-to-image | FLUX.1 schnell | New photo |

## Guardrails

- **Adapter contract checks.** Each model adapter's request shape is unit-tested
  (input image actually present, correct field names/types) and verified against
  the live catalog schema by `pnpm probe:models`, which also runs a fixture photo
  through the real models and reports fidelity.
- **Fidelity guard.** After Adjust / Enhance / Segment / Local edit, compare a
  small grayscale thumbnail of result vs source. Drift beyond the class budget →
  job fails and is refunded, never saved as a new photo.
- **No silent downgrade.** A fallback must also consume the input photo; if none
  can, fail loudly with a refund.
- **Audit.** Each version records operation class, model, and fidelity score.

## Plan

- **P0 — stop the damage.** Enhance → Images ESRGAN + sharpen; Remove background
  → Images segment; FLUX receives the photo as `input_image_0` (≤ 512 px); remove
  the blind SDXL multipart fallback.
- **P1 — local edits.** Region edits = mask + inpainting (or FLUX on the crop) +
  composite-back so everything outside the region is untouched.
- **P2 — guardrails.** Fidelity guard, adapter contract tests, `probe:models`,
  per-version audit fields.
- **P3 — Pruna.** Re-enable P-Image-Edit / P-Image-Upscale once AI Gateway
  credits exist; label free-text edits as "Reimagine".

Open questions (probe before building): does the Images *binding* accept
`upscale: "generate"` (docs yes; installed types only on `fetch` cf.image)?
FLUX.2 quality with a 512 px reference? SD 1.5 inpainting quality at photo scale?

## Probe results (live bindings, 2026-09-25, `pnpm probe:models`)

| Check | Result |
|---|---|
| Images `upscale: "generate"` on the **binding** | Works (1200×900 → 2400×1800, ~4 s); types lag, cast needed |
| Images `segment: "foreground"` | Works (RGBA PNG; `background` flattens) |
| Images `draw(..., { composite: "in" })` | Works — pixel-exact masked paste |
| FLUX.2 klein + binary `input_image_0` (≤511 px) | Faithful edit, geometry preserved, ~5 s |
| SD 1.5 inpainting + mask | Honours mask but redraws shapes at 512 px — not used |
| Guard: ESRGAN / segment / faithful FLUX | r = 1.00 / 0.98 / 0.99 |
| Guard: text-only FLUX (the incident) | r = 0.125 → rejected |

## Progress

- [x] P0 — Enhance → Images ESRGAN + sharpen; Remove background → Images
      segment; FLUX receives the photo as binary `input_image_0`; blind SDXL
      fallback removed.
- [x] P1 — local edits = padded crop → FLUX with the crop as reference →
      feathered alpha mask → Images composite-back (outside region byte-identical).
- [x] P2 — fidelity guard (r / mad / outlier budgets per class), adapter
      contract tests, `pnpm probe:models` (runs production pixel code against
      live bindings, incl. a negative control), `image_versions.op_class /
      model / fidelity` audit (migration 0006).
- [x] P3 — free-text edits are "Reimagine" (UI copy + chat narration); Pruna
      stays primary and is guarded, pending AI Gateway credits.

## Calibration update (2026-09-25, user report)

A faithful Reimagine ("change the shirt color to green") was rejected: the
white shirt covers ~45% of the frame, so recolouring it dropped luma r to
0.37 (< 0.4). Reproduced with the production code on the same photo; the
output kept the person, pose, drink and background. A day→night recolour
also tripped the brightness cap (mad 114). Fix: Reimagine now passes on
**luma r ≥ 0.4 OR structure (edge-map correlation) ≥ 0.3**, with no
brightness cap. Measured: faithful recolours structure 0.56–0.82; the
no-photo control −0.05 and an unrelated image 0.14 still fail both.
`probe:models` now includes a large-recolour case.
