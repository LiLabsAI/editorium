import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	BUILT_IN_FILTER_PRESETS,
	exportPresetRecipe,
	interpolatePresetAdjustments,
	parseImportedPresetJson,
	type PresetDto,
} from "../shared/presets";
import { PresetsPanel } from "./components/PresetsPanel";

const SAMPLE_AI_PRESET: PresetDto = {
	id: "builtin:ai-neon-noir",
	slug: "neon-noir",
	version: 1,
	name: "Neon Noir",
	category: "relight",
	kind: "ai_effect",
	description: "Moody cyan & magenta night lighting.",
	creditCost: 2,
	isBuiltIn: true,
	aiMeta: {
		targetScope: "whole",
		opClass: "reimagine",
		defaultIntensity: "balanced",
		remixPrompt: "Moody neon noir night lighting with cyan and magenta reflections",
		accentSwatches: ["#06b6d4", "#d946ef"],
	},
};

const SAMPLE_CUSTOM_PRESET: PresetDto = {
	id: "custom-1",
	slug: "my-warm-look",
	version: 1,
	name: "My Warm Look",
	category: "film",
	kind: "filter",
	description: "Custom warm look",
	creditCost: 0,
	isBuiltIn: false,
	isFavorite: false,
	adjustments: { temperature: 0.3, grain: 0.2 },
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("shared preset helpers", () => {
	it("interpolates GPU preset grades by intensity while preserving geometry", () => {
		const base = { rotate90: 1 as const, flipH: true, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } };
		const preset = { contrast: 0.4, grain: 0.2, splitShadowHue: 192, splitShadowAmt: 0.3 };

		const half = interpolatePresetAdjustments(base, preset, 0.5, "builtin:teal-orange");
		expect(half.rotate90).toBe(1);
		expect(half.flipH).toBe(true);
		expect(half.crop).toEqual(base.crop);
		expect(half.contrast).toBe(0.2);
		expect(half.grain).toBe(0.1);
		expect(half.splitShadowAmt).toBe(0.15);
		expect(half.splitShadowHue).toBe(192);
		expect(half.presetId).toBe("builtin:teal-orange");
		expect(half.presetIntensity).toBe(0.5);

		const zero = interpolatePresetAdjustments(base, preset, 0, "builtin:teal-orange");
		expect(zero.contrast).toBeUndefined();
		expect(zero.splitShadowHue).toBeUndefined();
		expect(zero.rotate90).toBe(1);
	});

	it("exports and parses portable .editorium-preset.json recipes cleanly", () => {
		const rawFilter = exportPresetRecipe(BUILT_IN_FILTER_PRESETS[0]!);
		const parsedFilter = parseImportedPresetJson(rawFilter);
		expect(parsedFilter.name).toBe("Portra 400");
		expect(parsedFilter.kind).toBe("filter");
		expect(parsedFilter.adjustments?.grain).toBeGreaterThan(0);

		const rawAi = exportPresetRecipe(SAMPLE_AI_PRESET);
		const parsedAi = parseImportedPresetJson(rawAi);
		expect(parsedAi.kind).toBe("ai_effect");
		expect(parsedAi.promptTemplate).toContain("neon noir");

		expect(() => parseImportedPresetJson("not json")).toThrow(/Invalid JSON/);
		expect(() => parseImportedPresetJson(JSON.stringify({ name: "Bad", kind: "ai_effect" }))).toThrow(
			/promptTemplate/,
		);
	});
});

describe("PresetsPanel", () => {
	const baseProps = {
		imageId: "img-1",
		photoSource: null,
		presets: [...BUILT_IN_FILTER_PRESETS.slice(0, 3), SAMPLE_AI_PRESET, SAMPLE_CUSTOM_PRESET],
		adjustments: {},
		hasSelection: false,
		onPreviewAdjustments: vi.fn(),
		onApplyFilterAdjustments: vi.fn(),
		onBakeFilterBranch: vi.fn(),
		onResetAdjustments: vi.fn(),
		onApplyAiPreset: vi.fn(),
		onRemixPrompt: vi.fn(),
		onPresetsChanged: vi.fn(),
		onNotice: vi.fn(),
	};

	it("supports hover preview, non-destructive filter click, and Amount slider interpolation", () => {
		const onPreview = vi.fn();
		const onApply = vi.fn();
		const { rerender } = render(
			<PresetsPanel
				{...baseProps}
				onPreviewAdjustments={onPreview}
				onApplyFilterAdjustments={onApply}
			/>,
		);

		const card = screen.getByRole("button", { name: /Portra 400/i });
		fireEvent.mouseEnter(card);
		expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ presetId: "builtin:portra-400" }));
		fireEvent.mouseLeave(card);
		expect(onPreview).toHaveBeenLastCalledWith(null);

		fireEvent.click(card);
		expect(onApply).toHaveBeenCalledWith(
			expect.objectContaining({ presetId: "builtin:portra-400", presetIntensity: 1 }),
		);

		rerender(
			<PresetsPanel
				{...baseProps}
				adjustments={{ ...BUILT_IN_FILTER_PRESETS[0]!.adjustments, presetId: "builtin:portra-400", presetIntensity: 1 }}
				onPreviewAdjustments={onPreview}
				onApplyFilterAdjustments={onApply}
			/>,
		);
		const slider = screen.getByLabelText("Preset intensity");
		fireEvent.change(slider, { target: { value: "0.5" } });
		expect(onApply).toHaveBeenLastCalledWith(
			expect.objectContaining({ presetId: "builtin:portra-400", presetIntensity: 0.5 }),
		);
	});

	it("requires explicit confirmation in the AI Effects Apply dock and supports Peek / Remix", () => {
		const onApplyAi = vi.fn();
		const onRemix = vi.fn();
		render(
			<PresetsPanel
				{...baseProps}
				onApplyAiPreset={onApplyAi}
				onRemixPrompt={onRemix}
			/>,
		);

		fireEvent.click(screen.getByRole("tab", { name: "AI Effects" }));
		fireEvent.click(screen.getByRole("button", { name: /Neon Noir/i }));
		// Clicking card selects it into the Apply Dock without immediately spending credits.
		expect(onApplyAi).not.toHaveBeenCalled();

		// Progressive disclosure: Peek / Remix prompt.
		fireEvent.click(screen.getByRole("button", { name: /Peek \/ Remix prompt/i }));
		expect(screen.getByText(/Moody neon noir night lighting/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Load into Composer" }));
		expect(onRemix).toHaveBeenCalledWith("Moody neon noir night lighting with cyan and magenta reflections");

		// Choose Bold + optional tweak + explicit Apply button.
		fireEvent.click(screen.getByRole("button", { name: "bold" }));
		fireEvent.change(screen.getByLabelText("Optional effect tweak"), { target: { value: "keep jacket red" } });
		fireEvent.click(screen.getByRole("button", { name: /Apply Neon Noir \(2 credits\)/i }));
		expect(onApplyAi).toHaveBeenCalledWith({
			preset: SAMPLE_AI_PRESET,
			intensity: "bold",
			extraPrompt: "keep jacket red",
		});
	});

	it("lets users create a custom hidden-prompt AI preset in the Saved tab", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ preset: SAMPLE_CUSTOM_PRESET }), { status: 201 }));
		vi.stubGlobal("fetch", fetchMock);
		const onPresetsChanged = vi.fn();

		render(<PresetsPanel {...baseProps} onPresetsChanged={onPresetsChanged} />);
		fireEvent.click(screen.getByRole("tab", { name: /Saved/i }));
		fireEvent.click(screen.getByRole("button", { name: "+ New AI Preset" }));

		fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "Rainy Tokyo" } });
		fireEvent.change(screen.getByLabelText("Hidden prompt template"), {
			target: { value: "Relight with rainy neon Tokyo street reflections" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save Preset" }));

		await waitFor(() => {
			expect(onPresetsChanged).toHaveBeenCalled();
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/presets",
			expect.objectContaining({ method: "POST" }),
		);
	});
});
