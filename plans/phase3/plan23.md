# Plan 23 — Real Editing Models (SD-Inpainting, SDXL-Lightning img2img, flux T2I)

**Goal:** replace the mock pixel pipeline with the real Workers AI editing
models found in the catalog investigation.

## Provider changes (`WorkersAIProvider`)

1. **`inpaint`** → `@cf/runwayml/stable-diffusion-v1-5-inpainting`:
   - Inputs: `prompt`, `image_b64` (source, downscaled ≤1024), `mask` as
     8-bit array (our stored feathered PNG re-encoded to raw bytes if needed
     by the schema), `strength` from the reference mode, `num_steps: 12`.
   - Output: base64 PNG (or ReadableStream — handle both shapes).
   - Constraints: model works at 512×512-class resolutions → send the
     bounding-square crop around the mask (25% context margin), then composite
     the returned crop back into the full image through the feathered mask
     (server-side, pure TS: PNG decode/encode via the existing zlib helpers —
     or keep the composite on the region only and store full PNG).
2. **`upscale`/enhance** → `@cf/bytedance/stable-diffusion-xl-lightning`
   img2img: `image_b64`, `strength 0.25–0.35`, prompt
   "professional photograph, crisp detail, sharp focus, high resolution".
3. **`textToImage`** → keep flux-1-schnell; fallback SDXL-lightning.
4. **`imageToImage`** → SDXL-lightning img2img with mode→strength mapping.
5. **Input normalization**: every model call routes through
   `prepareModelInput` (≤1024px JPEG via the Images binding), converts to
   `image_b64`, and enforces the 4:3/1:1/9:16 size floors (256px min).
6. Add `MODEL_INPAINT` wrangler var; record checked model IDs in a comment.

## Compositing for region truth

7. The inpainting model returns the whole (cropped) canvas. Composite: paste
   the generated crop over the source only inside the feathered mask so
   untouched pixels are bit-identical — client-visible "only the region
   changed" guarantee now holds with a real model.

## Acceptance

- Live mode: select the sky in a real landscape photo → "replace with sunset
  clouds" → returned image differs only inside the mask; JPEG output stored,
  variants derived, version/branch recorded.
- Enhance on a real photo → visibly crisper output; no model errors at 4:3.
