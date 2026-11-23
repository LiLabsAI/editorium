/**
 * Server-side authoritative preset registry & hidden-prompt compiler.
 *
 * Built-in AI prompt templates live ONLY on the Worker so system prompt
 * engineering, model routing, and preservation guardrails stay trustworthy
 * and evolvable without exposing raw prompt boilerplate in the client bundle
 * or history bubbles.
 */

import type { PresetRow } from "../../../database/schema";
import {
	BUILT_IN_FILTER_PRESETS,
	extractGrade,
	type ImageAdjustments,
	type PresetCategory,
	type PresetDto,
	type PresetIntensity,
	type PresetKind,
	type PresetTargetScope,
} from "../../shared/presets";

export interface PresetAiRecipe {
	promptTemplate: string;
	intensityModifiers: Record<PresetIntensity, string>;
	preservationSuffix: string;
	targetScope: PresetTargetScope;
	opClass: "reimagine" | "style_transfer";
	preferredModel?: "primary" | "flux";
}

export interface ResolvedPreset {
	dto: PresetDto;
	recipe?: PresetAiRecipe;
}

const DEFAULT_INTENSITY_MODIFIERS: Record<PresetIntensity, string> = {
	subtle: "Apply a subtle, restrained version of this look:",
	balanced: "Apply a natural, balanced photographic rendition of this look:",
	bold: "Apply a dramatic, vivid, full-strength rendition of this look:",
};

const DEFAULT_PRESERVATION =
	"Keep the subject's identity, facial features, pose, proportions, and core framing faithful to the source photograph.";

interface BuiltInAiSpec {
	id: string;
	slug: string;
	name: string;
	category: PresetCategory;
	kind: "ai_effect" | "hybrid";
	description: string;
	accentSwatches: [string, string];
	defaultIntensity?: PresetIntensity;
	targetScope: PresetTargetScope;
	opClass: "reimagine" | "style_transfer";
	preferredModel?: "primary" | "flux";
	promptTemplate: string;
	/** Readable summary surfaced only when the user explicitly clicks "Peek / Remix". */
	remixPrompt: string;
	preservationSuffix?: string;
	/** Finishing live WebGL grade attached automatically to hybrid preset outputs. */
	adjustments?: ImageAdjustments;
}

const BUILT_IN_AI_SPECS: BuiltInAiSpec[] = [
	// --- Relight (whole photo, reimagine) ---
	{
		id: "builtin:ai-studio-softbox",
		slug: "studio-softbox",
		name: "Studio Softbox",
		category: "relight",
		kind: "ai_effect",
		description: "Balanced studio key light with clean catchlights and subtle rim separation.",
		accentSwatches: ["#f5f5f4", "#a8a29e"],
		targetScope: "whole",
		opClass: "reimagine",
		promptTemplate:
			"Relight this photograph with balanced professional studio softbox key lighting, gentle fill in the shadows, natural skin texture, crisp catchlights, and subtle edge rim separation",
		remixPrompt:
			"Professional studio softbox key lighting with gentle shadow fill, crisp catchlights, and subtle rim light",
	},
	{
		id: "builtin:ai-golden-rim",
		slug: "golden-rim-light",
		name: "Golden Rim Light",
		category: "relight",
		kind: "ai_effect",
		description: "Warm late-afternoon sun backlighting with golden edge glow and soft atmospheric haze.",
		accentSwatches: ["#f59e0b", "#7c2d12"],
		targetScope: "whole",
		opClass: "reimagine",
		promptTemplate:
			"Relight the scene in warm golden hour sunlight coming from a low angle behind the subject, creating luminous golden rim highlights along edges, warm directional shadows, and subtle sunlit atmospheric haze",
		remixPrompt:
			"Warm late-afternoon golden hour backlighting with luminous rim highlights and soft sunlit atmosphere",
	},
	{
		id: "builtin:ai-neon-noir",
		slug: "neon-noir",
		name: "Neon Noir",
		category: "relight",
		kind: "ai_effect",
		description: "Moody night lighting bathed in electric cyan and magenta reflections.",
		accentSwatches: ["#06b6d4", "#d946ef"],
		targetScope: "whole",
		opClass: "reimagine",
		promptTemplate:
			"Transform the lighting into atmospheric neon noir night cinematography with electric cyan key highlights, magenta rim reflections, deep moody shadows, and subtle wet-surface sheen",
		remixPrompt:
			"Moody neon noir night lighting with electric cyan highlights, magenta rim reflections, and deep shadows",
	},
	{
		id: "builtin:ai-moody-overcast",
		slug: "moody-overcast",
		name: "Moody Overcast",
		category: "relight",
		kind: "ai_effect",
		description: "Diffused Nordic overcast daylight with sculptural soft shadows and muted atmosphere.",
		accentSwatches: ["#64748b", "#1e293b"],
		targetScope: "whole",
		opClass: "reimagine",
		promptTemplate:
			"Relight with soft diffused Nordic overcast daylight, gentle cloud-filtered directionality, rich muted tones, and quiet cinematic atmosphere without harsh specular glare",
		remixPrompt:
			"Soft diffused Nordic overcast daylight with sculpted shadows and rich muted atmospheric tones",
	},

	// --- Backdrop (auto BiRefNet subject-protected background effects!) ---
	{
		id: "builtin:ai-clean-studio",
		slug: "clean-studio-backdrop",
		name: "Clean Studio",
		category: "backdrop",
		kind: "ai_effect",
		description: "Replaces the background with a seamless neutral cyclorama studio while keeping the subject untouched.",
		accentSwatches: ["#e2e8f0", "#475569"],
		targetScope: "background",
		opClass: "reimagine",
		promptTemplate:
			"Replace only the background with a clean, seamless matte warm-gray photography studio cyclorama backdrop with soft studio falloff lighting and natural grounded contact shadows",
		remixPrompt:
			"Clean matte warm-gray photography studio cyclorama backdrop with soft studio lighting falloff",
	},
	{
		id: "builtin:ai-creamy-bokeh",
		slug: "creamy-bokeh",
		name: "Creamy f/1.4 Bokeh",
		category: "backdrop",
		kind: "ai_effect",
		description: "Transforms the background into optical shallow depth-of-field blur with circular highlights.",
		accentSwatches: ["#fde68a", "#312e81"],
		targetScope: "background",
		opClass: "reimagine",
		promptTemplate:
			"Render the background with authentic full-frame 85mm f/1.4 optical shallow depth-of-field blur, creamy smooth transitions, and soft circular bokeh specular highlights matching the existing scene colors",
		remixPrompt:
			"Authentic 85mm f/1.4 optical shallow depth-of-field background blur with creamy circular bokeh highlights",
	},
	{
		id: "builtin:ai-golden-sky",
		slug: "golden-sunset-sky",
		name: "Golden Sunset Sky",
		category: "backdrop",
		kind: "ai_effect",
		description: "Shifts the backdrop into glowing twilight clouds while protecting the foreground subject.",
		accentSwatches: ["#fb923c", "#4338ca"],
		targetScope: "background",
		opClass: "reimagine",
		promptTemplate:
			"Transform the background environment into an atmospheric golden-hour sunset sky with warm amber and violet twilight clouds, matching natural ambient wrap around the horizon",
		remixPrompt:
			"Atmospheric golden-hour sunset background with warm amber and violet twilight clouds",
	},

	// --- Artistic (style_transfer fidelity profile) ---
	{
		id: "builtin:ai-editorial-35mm",
		slug: "editorial-35mm",
		name: "35mm Editorial",
		category: "artistic",
		kind: "ai_effect",
		description: "High-fashion analog medium-format look with organic optical depth and tactile texture.",
		accentSwatches: ["#d6d3d1", "#57534e"],
		targetScope: "whole",
		opClass: "reimagine",
		promptTemplate:
			"Re-render with authentic medium-format analog 35mm editorial magazine photography aesthetics, nuanced film dynamic range, organic optical grain, refined tonal separation, and natural skin micro-texture",
		remixPrompt:
			"Medium-format analog 35mm editorial magazine photograph with natural dynamic range and subtle optical grain",
	},
	{
		id: "builtin:ai-watercolor-ink",
		slug: "watercolor-ink",
		name: "Watercolor Ink",
		category: "artistic",
		kind: "ai_effect",
		description: "Delicate hand-painted watercolor pigment washes with fine editorial ink linework.",
		accentSwatches: ["#38bdf8", "#fb7185"],
		targetScope: "whole",
		opClass: "style_transfer",
		promptTemplate:
			"Restyle this image as an artisanal hand-painted watercolor illustration on cold-press textured paper with translucent pigment washes, soft bleeding edges, and delicate fine ink contour linework",
		remixPrompt:
			"Hand-painted watercolor illustration on textured paper with translucent washes and delicate ink linework",
		preservationSuffix:
			"Keep the exact layout, subject placement, silhouettes, and recognizable features from the source image.",
	},
	{
		id: "builtin:ai-oil-painting",
		slug: "oil-painting",
		name: "Oil Painting",
		category: "artistic",
		kind: "ai_effect",
		description: "Expressive museum oil painting with rich impasto brushwork and warm gallery light.",
		accentSwatches: ["#ca8a04", "#1e3a8a"],
		targetScope: "whole",
		opClass: "style_transfer",
		promptTemplate:
			"Restyle this photograph as a classical museum-grade oil painting on woven linen canvas with expressive visible impasto brushstrokes, rich layered chiaroscuro pigments, and painterly light",
		remixPrompt:
			"Classical oil painting on linen canvas with expressive impasto brushwork and rich layered light",
		preservationSuffix:
			"Keep the exact composition, subject pose, proportions, and recognizable facial likeness from the source image.",
	},
	{
		id: "builtin:ai-anime-cel",
		slug: "anime-cel",
		name: "Anime Cel",
		category: "artistic",
		kind: "ai_effect",
		description: "Hand-drawn Japanese theatrical anime film aesthetic with luminous painted backgrounds.",
		accentSwatches: ["#818cf8", "#f472b6"],
		targetScope: "whole",
		opClass: "style_transfer",
		promptTemplate:
			"Restyle this image as a hand-drawn Japanese theatrical anime film frame with clean expressive line art, luminous cel-shaded lighting, rich painted skies and scenery, and cinematic color harmony",
		remixPrompt:
			"Hand-drawn Japanese theatrical anime film illustration with clean line art and luminous cel lighting",
		preservationSuffix:
			"Preserve the exact composition, framing, subject pose, clothing colors, and scene layout of the original photograph.",
	},

	// --- Hybrid Flagship Presets (AI relight + attached live GPU finishing grade!) ---
	{
		id: "builtin:hybrid-cinema-still",
		slug: "cinema-still",
		name: "Cinema Still",
		category: "cinematic",
		kind: "hybrid",
		description: "Anamorphic cinematic relighting paired with a live, tweakable Teal & Orange film grade.",
		accentSwatches: ["#0e7490", "#ea580c"],
		targetScope: "whole",
		opClass: "reimagine",
		promptTemplate:
			"Relight this photograph like a 35mm anamorphic cinema film still with dramatic directional motivated lighting, subtle atmospheric depth, gentle highlight bloom, and naturalistic shadow falloff",
		remixPrompt:
			"Anamorphic 35mm cinema still lighting with directional depth + live Teal & Orange GPU finish",
		adjustments: {
			contrast: 0.12,
			clarity: 0.1,
			grain: 0.16,
			bloom: 0.16,
			vignette: 0.22,
			splitShadowHue: 194,
			splitShadowAmt: 0.22,
			splitHighlightHue: 34,
			splitHighlightAmt: 0.18,
		},
	},
	{
		id: "builtin:hybrid-analog-magazine",
		slug: "analog-magazine",
		name: "Analog Magazine",
		category: "portrait",
		kind: "hybrid",
		description: "Soft studio editorial lighting paired with a live Portra-style warm film grade.",
		accentSwatches: ["#f59e0b", "#d6d3d1"],
		targetScope: "whole",
		opClass: "reimagine",
		promptTemplate:
			"Relight with flattering soft diffused window-style editorial magazine lighting, clean neutral catchlights, natural skin radiance, and refined subtle shadow depth",
		remixPrompt:
			"Soft diffused editorial magazine lighting + live Portra warm matte film GPU finish",
		adjustments: {
			exposure: 0.06,
			highlights: -0.14,
			shadows: 0.12,
			temperature: 0.14,
			fade: 0.12,
			grain: 0.14,
			splitHighlightHue: 38,
			splitHighlightAmt: 0.12,
		},
	},
];

const BUILT_IN_AI_RESOLVED: ResolvedPreset[] = BUILT_IN_AI_SPECS.map((spec) => ({
	dto: {
		id: spec.id,
		slug: spec.slug,
		version: 1,
		name: spec.name,
		category: spec.category,
		kind: spec.kind,
		description: spec.description,
		creditCost: 2,
		isBuiltIn: true,
		...(spec.adjustments ? { adjustments: spec.adjustments } : {}),
		aiMeta: {
			targetScope: spec.targetScope,
			opClass: spec.opClass,
			defaultIntensity: spec.defaultIntensity ?? "balanced",
			remixPrompt: spec.remixPrompt,
			accentSwatches: spec.accentSwatches,
		},
	},
	recipe: {
		promptTemplate: spec.promptTemplate,
		intensityModifiers: DEFAULT_INTENSITY_MODIFIERS,
		preservationSuffix: spec.preservationSuffix ?? DEFAULT_PRESERVATION,
		targetScope: spec.targetScope,
		opClass: spec.opClass,
		preferredModel: spec.preferredModel,
	},
}));

const BUILT_IN_MAP = new Map<string, ResolvedPreset>([
	...BUILT_IN_FILTER_PRESETS.map((dto): [string, ResolvedPreset] => [dto.id, { dto }]),
	...BUILT_IN_AI_RESOLVED.map((item): [string, ResolvedPreset] => [item.dto.id, item]),
]);

export const BUILT_IN_PRESET_DTOS: PresetDto[] = [
	...BUILT_IN_FILTER_PRESETS,
	...BUILT_IN_AI_RESOLVED.map((item) => item.dto),
];

export function findBuiltInPreset(id: string): ResolvedPreset | null {
	return BUILT_IN_MAP.get(id) ?? null;
}

export function isBuiltInPresetId(id: string): boolean {
	return id.startsWith("builtin:") || BUILT_IN_MAP.has(id);
}

export function slugifyPresetName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "custom-preset"
	);
}

function parseAdjustmentsJson(json: string | null | undefined): ImageAdjustments | undefined {
	if (!json) return undefined;
	try {
		const parsed = JSON.parse(json) as ImageAdjustments;
		if (!parsed || typeof parsed !== "object") return undefined;
		const grade = extractGrade(parsed);
		return Object.keys(grade).length > 0 ? grade : undefined;
	} catch {
		return undefined;
	}
}

/** Convert a D1 custom `presets` row into both its public DTO and server AI recipe. */
export function resolveCustomPresetRow(row: PresetRow): ResolvedPreset {
	const kind = row.kind as PresetKind;
	const adjustments = parseAdjustmentsJson(row.adjustmentsJson);
	const isAi = kind === "ai_effect" || kind === "hybrid";
	const promptTemplate = row.promptTemplate?.trim() ?? "";

	const dto: PresetDto = {
		id: row.id,
		slug: row.slug,
		version: 1,
		name: row.name,
		category: (row.category as PresetCategory) || "custom",
		kind,
		description: row.description || (isAi ? "Custom AI effect preset" : "Custom GPU filter preset"),
		creditCost: isAi ? 2 : 0,
		isBuiltIn: false,
		isFavorite: Boolean(row.isFavorite),
		...(adjustments ? { adjustments } : {}),
		...(isAi
			? {
					aiMeta: {
						targetScope: row.targetScope as PresetTargetScope,
						opClass: row.opClass as "reimagine" | "style_transfer",
						defaultIntensity: row.defaultIntensity as PresetIntensity,
						remixPrompt: promptTemplate,
						accentSwatches: ["#6366f1", "#ec4899"],
					},
				}
			: {}),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};

	const recipe: PresetAiRecipe | undefined =
		isAi && promptTemplate
			? {
					promptTemplate,
					intensityModifiers: DEFAULT_INTENSITY_MODIFIERS,
					preservationSuffix: DEFAULT_PRESERVATION,
					targetScope: row.targetScope as PresetTargetScope,
					opClass: row.opClass as "reimagine" | "style_transfer",
				}
			: undefined;

	return { dto, recipe };
}

/**
 * Compile the hidden prompt server-side from intensity tier + preset template
 * + optional user note + attached color palettes + preservation guardrail.
 */
export function compilePresetPrompt(
	recipe: PresetAiRecipe,
	opts: {
		intensity?: PresetIntensity;
		extraPrompt?: string;
		paletteHexes?: string[];
		hasUserMask?: boolean;
	} = {},
): string {
	const intensity: PresetIntensity = opts.intensity ?? "balanced";
	const parts: string[] = [recipe.intensityModifiers[intensity], recipe.promptTemplate.replace(/[.]+$/, "") + "."];

	const cleanExtra = (opts.extraPrompt ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
	if (cleanExtra) {
		parts.push(`Additional creative direction: ${cleanExtra.replace(/[.]+$/, "")}.`);
	}

	const palette = (opts.paletteHexes ?? []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 6);
	if (palette.length > 0) {
		parts.push(`Harmonize with color palette: ${palette.join(", ")}.`);
	}

	if (opts.hasUserMask) {
		parts.push("Apply the effect seamlessly inside the selected region while matching surrounding lighting.");
	} else {
		parts.push(recipe.preservationSuffix);
	}

	return parts.join(" ");
}
