# Plan 11 — Region-Aware Editing: Inpaint, Literal Reference, Enhance, Versions

**Depends on:** Plan 10 · **Screens:** B (enhance flow), D (regenerate region)

## Goal

Close the loop: a selected region + an edited prompt → regenerate **only that region**; the
"expensive camera / 4K" enhance flow from the chat; Reference-image "Literal" modes; and a
version stack powering undo/redo.

## Region edit (inpaint)

1. User edits the Prompt-card text and hits `Regenerate region`.
2. Enqueue `inpaint` job: payload = image version, segment mask (R2), prompt, reference mode.
3. Provider call (behind `providers.inpaint(image, mask, prompt, strength)`):
   - external inpainting model (SDXL/FLUX-inpaint class via provider adapter), or
   - v1 fallback: crop-based i2i — crop the segment region + surrounding context, run Workers AI
     i2i with prompt + strength from mode, composite back through the feathered mask.
4. Composite result = new `image_versions` row (label auto: `{verb} {segment label}`), linked to
   the segment; the segment's bbox/mask persists (same object, new pixels).
5. Editor swaps pixels with a soft crossfade; box stays put.

## Reference-image modes (Screen C dropdown)

`Literal / Balanced / Creative` → i2i strength map (0.85 / 0.6 / 0.35) + prompt-adherence hint in
the provider call. The "Reference image" row toggle = whether the source image constrains the
edit at all (off = pure T2I replace).

## Enhance flow (the Screen B conversation)

- `enhance_image(imageId, strength)` tool → `enhance` job:
  1. Upscale ×2–×4 (provider: real-esrgan-class; catalog check for a Workers AI upscaler,
     else external adapter), then a detail pass (sharpen/grain via VLM-guided preset prompt:
     "shot on a professional camera, crisp detail" → i2i at low strength 0.25).
  2. New version labeled "High-quality 4K enhance…" (auto-name from operation + params).
  3. Re-segment the new version in the background (plan 9 hook) so the tree stays live.
- Result streams back into the chat exactly like Screen B: narration → thumbnail → summary line,
  and the new image sits adjacent to its source on the album canvas.

## Versions = undo/redo + history

- All editing ops produce versions (chain via `parentVersionId`). Editor keeps an in-memory
  pointer: undo/redo buttons (plan 8) walk it; server round-trip only on ops.
- `Generated image` section header gets a version dropdown: list versions with labels + time,
  click = activate (`POST …/activate`), current bolded.
- Download button serves the active version's full-size object.

## API

- `POST /api/images/:id/edit-region` `{segmentId, prompt, mode}`
- `POST /api/images/:id/enhance` `{strength}`
- `GET /api/images/:id/versions`, `POST /api/images/:id/versions/:vid/activate`

## Acceptance

- Selecting the tree in a seeded image, editing its prompt to a new description, and regenerating
  replaces just that region (mask composite visible), creates a version, undo restores previous.
- Chat enhance: "make it high quality 4k like a costly camera" → enhanced adjacent image on
  canvas + version in editor, tree re-populates for the new version.
- Literal vs Creative visibly differ in adherence (strength passed through, provider-mocked in
  tests). Version list + activate + download all work.
