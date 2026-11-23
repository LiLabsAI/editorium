/**
 * Shared preset types, built-in instant GPU filter definitions, intensity
 * interpolation, and portable JSON recipe helpers used by both the React
 * studio and the Cloudflare Worker API.
 *
 * Built-in AI hidden-prompt templates live exclusively on the server
 * (`src/worker/lib/presets.ts`) so system prompt engineering and guardrails
 * stay authoritative and cannot be tampered with by clients.
 */

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ImageAdjustments {
	exposure?: number;
	contrast?: number;
	highlights?: number;
	shadows?: number;
	temperature?: number;
	tint?: number;
	vibrance?: number;
	saturation?: number;
	clarity?: number;
	vignette?: number;
	/** Matte / lifted blacks film curve (0..1). */
	fade?: number;
	/** Deterministic photographic film grain (0..1). */
	grain?: number;
	/** Archival warm sepia tone mix (0..1). */
	sepia?: number;
	/** Soft Pro-Mist / highlight halation bloom (0..1). */
	bloom?: number;
	/** Shadow split-toning hue (0..360) and amount (0..1). */
	splitShadowHue?: number;
	splitShadowAmt?: number;
	/** Highlight split-toning hue (0..360) and amount (0..1). */
	splitHighlightHue?: number;
	splitHighlightAmt?: number;
	/** Active GPU preset provenance (for Amount slider & UI badge). */
	presetId?: string;
	presetIntensity?: number;
	straighten?: number;
	rotate90?: 0 | 1 | 2 | 3;
	flipH?: boolean;
	flipV?: boolean;
	crop?: Box;
}

export type PresetKind = "filter" | "ai_effect" | "hybrid";

export type PresetCategory =
	| "film"
	| "cinematic"
	| "bw"
	| "portrait"
	| "relight"
	| "backdrop"
	| "artistic"
	| "custom";

export type PresetIntensity = "subtle" | "balanced" | "bold";

export type PresetTargetScope = "whole" | "background" | "subject" | "selection";

export interface PresetAiMeta {
	targetScope: PresetTargetScope;
	opClass: "reimagine" | "style_transfer";
	defaultIntensity: PresetIntensity;
	/** Readable recipe summary exposed only when the user clicks "Peek / Remix". */
	remixPrompt?: string;
	accentSwatches: [string, string];
}

export interface PresetDto {
	id: string;
	slug: string;
	version: 1;
	name: string;
	category: PresetCategory;
	kind: PresetKind;
	description: string;
	creditCost: 0 | 2;
	isBuiltIn: boolean;
	isFavorite?: boolean;
	adjustments?: ImageAdjustments;
	aiMeta?: PresetAiMeta;
	createdAt?: string;
	updatedAt?: string;
}

/** Portable JSON schema for Import / Export (.editorium-preset.json). */
export interface PortablePresetRecipe {
	schema: "editorium.preset.v1";
	name: string;
	category: PresetCategory;
	kind: PresetKind;
	description?: string;
	adjustments?: ImageAdjustments;
	promptTemplate?: string;
	targetScope?: PresetTargetScope;
	opClass?: "reimagine" | "style_transfer";
	defaultIntensity?: PresetIntensity;
}

/** Color/tone grading fields interpolated by a preset's Amount slider (0..1). */
export const GRADE_SCALAR_KEYS = [
	"exposure",
	"contrast",
	"highlights",
	"shadows",
	"temperature",
	"tint",
	"vibrance",
	"saturation",
	"clarity",
	"vignette",
	"fade",
	"grain",
	"sepia",
	"bloom",
	"splitShadowAmt",
	"splitHighlightAmt",
] as const;

export type GradeScalarKey = (typeof GRADE_SCALAR_KEYS)[number];

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

/** Keep only geometry fields (crop/rotate/flip/straighten) from an adjustment state. */
export function extractGeometry(adj: ImageAdjustments | null | undefined): ImageAdjustments {
	if (!adj) return {};
	const out: ImageAdjustments = {};
	if (adj.straighten) out.straighten = adj.straighten;
	if (adj.rotate90) out.rotate90 = adj.rotate90;
	if (adj.flipH) out.flipH = true;
	if (adj.flipV) out.flipV = true;
	if (adj.crop) out.crop = adj.crop;
	return out;
}

/** Keep only color/tone/film fields (no geometry, no presetId metadata). */
export function extractGrade(adj: ImageAdjustments | null | undefined): ImageAdjustments {
	if (!adj) return {};
	const out: ImageAdjustments = {};
	for (const key of GRADE_SCALAR_KEYS) {
		const v = adj[key];
		if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) > 0.0005) {
			out[key] = round3(v);
		}
	}
	if (out.splitShadowAmt && typeof adj.splitShadowHue === "number" && Number.isFinite(adj.splitShadowHue)) {
		out.splitShadowHue = Math.round(((adj.splitShadowHue % 360) + 360) % 360);
	}
	if (out.splitHighlightAmt && typeof adj.splitHighlightHue === "number" && Number.isFinite(adj.splitHighlightHue)) {
		out.splitHighlightHue = Math.round(((adj.splitHighlightHue % 360) + 360) % 360);
	}
	return out;
}

/**
 * Apply a GPU filter preset at `intensity` (0..1) while preserving existing
 * geometry (crop, straighten, rotate, flip). Intensity 0 returns geometry only.
 */
export function interpolatePresetAdjustments(
	current: ImageAdjustments | null | undefined,
	presetAdj: ImageAdjustments,
	intensity: number,
	presetId?: string,
): ImageAdjustments {
	const t = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 1));
	const next: ImageAdjustments = extractGeometry(current);
	if (t > 0.001) {
		for (const key of GRADE_SCALAR_KEYS) {
			const target = presetAdj[key];
			if (typeof target === "number" && Number.isFinite(target) && Math.abs(target) > 0.0005) {
				const val = round3(target * t);
				if (Math.abs(val) > 0.0005) next[key] = val;
			}
		}
		if (next.splitShadowAmt && typeof presetAdj.splitShadowHue === "number") {
			next.splitShadowHue = Math.round(((presetAdj.splitShadowHue % 360) + 360) % 360);
		}
		if (next.splitHighlightAmt && typeof presetAdj.splitHighlightHue === "number") {
			next.splitHighlightHue = Math.round(((presetAdj.splitHighlightHue % 360) + 360) % 360);
		}
	}
	if (presetId) {
		next.presetId = presetId;
		next.presetIntensity = round3(t);
	}
	return next;
}

/**
 * Curated built-in instant GPU filter presets (0 credits, deterministic 60fps
 * WebGL2 rendering, live thumbnails on the user's actual photo).
 */
export const BUILT_IN_FILTER_PRESETS: PresetDto[] = [
	{
		id: "builtin:portra-400",
		slug: "portra-400",
		version: 1,
		name: "Portra 400",
		category: "film",
		kind: "filter",
		description: "Warm skin tones, soft highlight roll-off, subtle lifted blacks, and fine 35mm grain.",
		creditCost: 0,
		isBuiltIn: true,
		adjustments: {
			exposure: 0.08,
			contrast: -0.06,
			highlights: -0.18,
			shadows: 0.16,
			temperature: 0.18,
			tint: 0.06,
			vibrance: 0.14,
			saturation: -0.06,
			fade: 0.14,
			grain: 0.16,
			splitHighlightHue: 38,
			splitHighlightAmt: 0.14,
			splitShadowHue: 195,
			splitShadowAmt: 0.07,
		},
	},
	{
		id: "builtin:fuji-superia",
		slug: "fuji-superia",
		version: 1,
		name: "Fuji Superia",
		category: "film",
		kind: "filter",
		description: "Cool emerald shadows, crisp contrast, and vibrant botanical greens.",
		creditCost: 0,
		isBuiltIn: true,
		adjustments: {
			contrast: 0.14,
			highlights: -0.08,
			shadows: 0.08,
			temperature: -0.08,
			tint: -0.1,
			vibrance: 0.22,
			clarity: 0.12,
			fade: 0.08,
			grain: 0.18,
			splitShadowHue: 155,
			splitShadowAmt: 0.18,
			splitHighlightHue: 48,
			splitHighlightAmt: 0.08,
		},
	},
	{
		id: "builtin:cinestill-800t",
		slug: "cinestill-800t",
		version: 1,
		name: "CineStill 800T",
		category: "film",
		kind: "filter",
		description: "Tungsten cyan shadows with warm red-amber halation glow on bright highlights.",
		creditCost: 0,
		isBuiltIn: true,
		adjustments: {
			contrast: 0.18,
			highlights: 0.12,
			shadows: -0.08,
			temperature: -0.24,
			tint: 0.06,
			vibrance: 0.18,
			bloom: 0.42,
			grain: 0.26,
			vignette: 0.28,
			splitShadowHue: 198,
			splitShadowAmt: 0.28,
			splitHighlightHue: 16,
			splitHighlightAmt: 0.22,
		},
	},
	{
		id: "builtin:matte-fade",
		slug: "matte-fade",
		version: 1,
		name: "Matte Fade",
		category: "film",
		kind: "filter",
		description: "Lifted blacks, muted saturation, and gentle editorial softness.",
		creditCost: 0,
		isBuiltIn: true,
		adjustments: {
			contrast: -0.14,
			highlights: -0.16,
			shadows: 0.22,
			temperature: 0.1,
			saturation: -0.22,
			fade: 0.45,
			grain: 0.14,
			vignette: 0.16,
		},
	},
	{
		id: "builtin:teal-orange",
		slug: "teal-orange",
		version: 1,
		name: "Teal & Orange",
		category: "cinematic",
		kind: "filter",
		description: "Blockbuster split-toning with deep teal shadows and glowing amber highlights.",
		creditCost: 0,
		isBuiltIn: true,
		adjustments: {
			contrast: 0.22,
			highlights: -0.06,
			shadows: -0.08,
			vibrance: 0.24,
			clarity: 0.18,
			vignette: 0.28,
			splitShadowHue: 192,
			splitShadowAmt: 0.34,
			splitHighlightHue: 32,
			splitHighlightAmt: 0.3,
		},
	},
	{
		id: "builtin:golden-hour",
		slug: "golden-hour",
		version: 1,
		name: "Golden Hour",
		category: "cinematic",
		kind: "filter",
		description: "Sun-drenched amber warmth, lifted vibrance, gentle highlight bloom, and soft vignette.",
		creditCost: 0,
		isBuiltIn: true,
		adjustments: {
			exposure: 0.08,
			contrast: 0.08,
			temperature: 0.36,
			tint: 0.06,
			vibrance: 0.24,
			bloom: 0.22,
			vignette: 0.22,
			splitHighlightHue: 38,
			splitHighlightAmt: 0.24,
		},
	},
	{
		id: "builtin:moody-emerald",
		slug: "moody-emerald",
		version: 1,
		name: "Moody Emerald",
		category: "cinematic",
		kind: "filter",
		description: "Deep Nordic greens, sculpted shadows, and restrained contrast for atmospheric scenes.",
		creditCost: 0,
		isBuiltIn: true,
		adjustments: {
			exposure: -0.12,
			contrast: 0.2,
			highlights: -0.22,
			shadows: -0.14,
			temperature: -0.14,
			tint: -0.12,
			saturation: -0.24,
			clarity: 0.24,
			fade: 0.12,
			vignette: 0.38,
			splitShadowHue: 162,
			splitShadowAmt: 0.24,
		},
	},
	{
		id: "builtin:trix-400",
		slug: "trix-400",
		version: 1,
		name: "Tri-X 400",
		category: "bw",
		kind: "filter",
		description: "High-contrast monochrome street photography look with rich blacks and classic grain.",
		creditCost: 0,
		isBuiltIn: true,
		adjustments: {
			saturation: -1,
			contrast: 0.32,
			highlights: 0.1,
			shadows: -0.16,
			clarity: 0.28,
			grain: 0.32,
			vignette: 0.26,
		},
	},
	{
		id: "builtin:silver-portrait",
		slug: "silver-portrait",
		version: 1,
		name: "Silver Portrait",
		category: "bw",
		kind: "filter",
		description: "Luminous low-grain black & white with smooth skin midtones and lifted shadows.",
		creditCost: 0,
		isBuiltIn: true,
		adjustments: {
			saturation: -1,
			exposure: 0.1,
			contrast: 0.12,
			highlights: -0.12,
			shadows: 0.18,
			clarity: 0.08,
			fade: 0.12,
			grain: 0.08,
		},
	},
	{
		id: "builtin:clean-editorial",
		slug: "clean-editorial",
		version: 1,
		name: "Clean Editorial",
		category: "portrait",
		kind: "filter",
		description: "Crisp neutral whites, gentle highlight recovery, and true-to-life clarity.",
		creditCost: 0,
		isBuiltIn: true,
		adjustments: {
			exposure: 0.1,
			contrast: 0.1,
			highlights: -0.16,
			shadows: 0.14,
			vibrance: 0.14,
			clarity: 0.14,
		},
	},
	{
		id: "builtin:soft-promist",
		slug: "soft-promist",
		version: 1,
		name: "Soft Pro-Mist",
		category: "portrait",
		kind: "filter",
		description: "Dreamy optical diffusion glow on highlights with flattering softened micro-contrast.",
		creditCost: 0,
		isBuiltIn: true,
		adjustments: {
			exposure: 0.06,
			contrast: -0.06,
			highlights: 0.08,
			shadows: 0.14,
			temperature: 0.12,
			clarity: -0.18,
			bloom: 0.45,
			fade: 0.1,
		},
	},
	{
		id: "builtin:warm-sepia",
		slug: "warm-sepia",
		version: 1,
		name: "Warm Sepia",
		category: "film",
		kind: "filter",
		description: "Timeless darkroom sepia print tone with soft matte blacks and edge vignette.",
		creditCost: 0,
		isBuiltIn: true,
		adjustments: {
			sepia: 0.72,
			contrast: 0.1,
			fade: 0.2,
			grain: 0.18,
			vignette: 0.34,
		},
	},
];

const VALID_CATEGORIES = new Set<PresetCategory>([
	"film",
	"cinematic",
	"bw",
	"portrait",
	"relight",
	"backdrop",
	"artistic",
	"custom",
]);
const VALID_KINDS = new Set<PresetKind>(["filter", "ai_effect", "hybrid"]);
const VALID_SCOPES = new Set<PresetTargetScope>(["whole", "background", "subject", "selection"]);
const VALID_INTENSITIES = new Set<PresetIntensity>(["subtle", "balanced", "bold"]);

/** Serialize a preset into a clean portable `.editorium-preset.json` document. */
export function exportPresetRecipe(
	preset: Pick<PresetDto, "name" | "category" | "kind" | "description" | "adjustments" | "aiMeta">,
	promptTemplate?: string,
): string {
	const payload: PortablePresetRecipe = {
		schema: "editorium.preset.v1",
		name: preset.name,
		category: preset.category,
		kind: preset.kind,
		...(preset.description ? { description: preset.description } : {}),
		...(preset.adjustments ? { adjustments: extractGrade(preset.adjustments) } : {}),
		...(promptTemplate || preset.aiMeta?.remixPrompt
			? { promptTemplate: promptTemplate ?? preset.aiMeta?.remixPrompt }
			: {}),
		...(preset.aiMeta?.targetScope ? { targetScope: preset.aiMeta.targetScope } : {}),
		...(preset.aiMeta?.opClass ? { opClass: preset.aiMeta.opClass } : {}),
		...(preset.aiMeta?.defaultIntensity ? { defaultIntensity: preset.aiMeta.defaultIntensity } : {}),
	};
	return JSON.stringify(payload, null, 2);
}

/** Parse and validate an imported `.editorium-preset.json` string. Throws on invalid input. */
export function parseImportedPresetJson(raw: string): PortablePresetRecipe {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Invalid JSON file.");
	}
	if (!parsed || typeof parsed !== "object") throw new Error("Preset recipe must be a JSON object.");
	const rec = parsed as Record<string, unknown>;
	if (rec.schema !== undefined && rec.schema !== "editorium.preset.v1") {
		throw new Error("Unsupported preset schema version.");
	}
	const name = typeof rec.name === "string" ? rec.name.trim().slice(0, 48) : "";
	if (!name) throw new Error("Preset recipe requires a name.");
	const kind = VALID_KINDS.has(rec.kind as PresetKind) ? (rec.kind as PresetKind) : "filter";
	const category = VALID_CATEGORIES.has(rec.category as PresetCategory)
		? (rec.category as PresetCategory)
		: "custom";
	const description = typeof rec.description === "string" ? rec.description.trim().slice(0, 160) : "";
	const adjustments =
		rec.adjustments && typeof rec.adjustments === "object"
			? extractGrade(rec.adjustments as ImageAdjustments)
			: undefined;
	const promptTemplate =
		typeof rec.promptTemplate === "string" ? rec.promptTemplate.trim().slice(0, 400) : undefined;
	if (kind === "filter" && (!adjustments || Object.keys(adjustments).length === 0)) {
		throw new Error("Filter preset requires at least one color or tone adjustment.");
	}
	if ((kind === "ai_effect" || kind === "hybrid") && !promptTemplate) {
		throw new Error("AI effect preset requires a promptTemplate.");
	}
	const targetScope = VALID_SCOPES.has(rec.targetScope as PresetTargetScope)
		? (rec.targetScope as PresetTargetScope)
		: "whole";
	const opClass = rec.opClass === "style_transfer" ? "style_transfer" : "reimagine";
	const defaultIntensity = VALID_INTENSITIES.has(rec.defaultIntensity as PresetIntensity)
		? (rec.defaultIntensity as PresetIntensity)
		: "balanced";
	return {
		schema: "editorium.preset.v1",
		name,
		category,
		kind,
		...(description ? { description } : {}),
		...(adjustments && Object.keys(adjustments).length > 0 ? { adjustments } : {}),
		...(promptTemplate ? { promptTemplate } : {}),
		...(kind !== "filter" ? { targetScope, opClass, defaultIntensity } : {}),
	};
}
