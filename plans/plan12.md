# Plan 12 — Color Palettes & Prompt Intelligence

**Depends on:** Plan 10 (card UI), Plan 6 (LLM) · **Screens:** D (Color Palette + `+`), B
(palette button in composer)

## Goal

Build the color system and the prompting helpers visible in the screenshots: the **Color Palette**
section on the Prompt card with its `+` button, the palette swatch button in the Ask composer, and
LLM prompt rewriting so casual user phrasing becomes strong generation prompts.

## Palette extraction

- On thumbnail completion (plan 3 hook) extract 5 dominant colors per image (k-means on a
  downsampled buffer in the Worker — pure JS, no binary deps) → `palettes` row
  (`source: 'extracted'`, linked via `image_palettes`).
- Per-segment palettes: extract from the crop when segmentation completes (plan 9) — the Prompt
  card shows the selected segment's own swatches (that's what its Color Palette section displays).

## Palette UI

- **Prompt card:** swatch row (5 circles) + `+` → popover: pick from image/segment palettes,
  paste hex, or "extract from another image" (picker over album thumbs). Attached palettes
  serialize into the edit prompt as color constraints (`…dominant colors: #a1b2c3, …`).
- **Composer palette button (Screen B):** same popover inline; attaching shows chips above the
  input; sent message carries `paletteIds`.
- Swatch click = copy hex (tooltip).

## Prompt intelligence

- `POST /api/prompts/rewrite` `{text, operation, context}` → LLM (Workers AI) rewrites casual
  input into a structured generation prompt: subject + attributes + position words (matching the
  reference caption style: object, then placement like "image-left", then background relation) +
  attached palette hexes.
- "Enhance prompt" affordance: a sparkle button on the Prompt card + composer that passes the
  current text through rewrite and shows a diff-style before/after, Apply/Discard.
- The chat agent's system prompt (plan 6) automatically routes through rewrite for
  generate/edit tools.

## Acceptance

- Seed image → extracted 5-color palette renders on its segments' Prompt cards; `+` attaches a
  palette and the resulting edit job payload contains the hex constraints.
- "make the tree pink and tiny" → rewritten prompt contains color + size + placement structure;
  Apply/Discard UX works; unit tests for rewrite formatting + k-means extraction accuracy
  (±hue tolerance) on fixture images.
