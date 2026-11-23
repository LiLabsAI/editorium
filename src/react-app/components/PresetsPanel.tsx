import { useEffect, useMemo, useRef, useState } from "react";

import {
	exportPresetRecipe,
	extractGrade,
	interpolatePresetAdjustments,
	parseImportedPresetJson,
} from "../../shared/presets";
import { hasNonZeroAdjustments, renderPresetThumbnails } from "../editor/webgl";
import {
	api,
	describeError,
	fileUrl,
	type ImageAdjustments,
	type PresetCategory,
	type PresetDto,
	type PresetIntensity,
	type PresetKind,
	type PresetTargetScope,
} from "../lib/api";

type PanelTab = "filters" | "ai" | "saved";

const FILTER_CATEGORIES: Array<{ id: "all" | PresetCategory; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "film", label: "Film" },
	{ id: "cinematic", label: "Cinematic" },
	{ id: "bw", label: "B&W" },
	{ id: "portrait", label: "Portrait" },
];

const AI_CATEGORIES: Array<{ id: "all" | PresetCategory; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "relight", label: "Relight" },
	{ id: "backdrop", label: "Backdrop" },
	{ id: "artistic", label: "Artistic" },
	{ id: "cinematic", label: "Hybrid" },
];

function scopeBadge(preset: PresetDto, hasSelection: boolean): string {
	if (hasSelection) return "Active selection";
	if (preset.kind === "hybrid") return "AI + Live GPU";
	const scope = preset.aiMeta?.targetScope ?? "whole";
	if (scope === "background") return "Bg · Subject safe";
	if (scope === "subject") return "Subject only";
	return "Whole photo";
}

function scopeExplanation(preset: PresetDto, hasSelection: boolean, selectionLabel?: string | null): string {
	if (hasSelection) {
		return `Applies inside ${selectionLabel ? `“${selectionLabel}”` : "your active selection"} — outside pixels stay untouched.`;
	}
	if (preset.kind === "hybrid") {
		return "Runs AI lighting branch + attaches live tweakable GPU sliders.";
	}
	const scope = preset.aiMeta?.targetScope ?? "whole";
	if (scope === "background") {
		return "Auto-masks foreground with BiRefNet so your subject stays untouched.";
	}
	if (scope === "subject") {
		return "Auto-masks subject with BiRefNet while keeping background untouched.";
	}
	return preset.aiMeta?.opClass === "style_transfer"
		? "Stylizes whole photo while keeping framing & layout."
		: "Relights whole photo with fidelity guard protection.";
}

export interface PresetsPanelProps {
	imageId: string;
	photoSource: HTMLImageElement | null;
	presets: PresetDto[];
	adjustments: ImageAdjustments;
	hasSelection: boolean;
	selectionLabel?: string | null;
	busy?: boolean;
	initialCreateKind?: PresetKind | null;
	initialCreatePrompt?: string | null;
	onConsumeInitialCreate?: () => void;
	onPreviewAdjustments: (preview: ImageAdjustments | null) => void;
	onApplyFilterAdjustments: (next: ImageAdjustments) => void;
	onBakeFilterBranch: (label: string, preset?: { id: string; name: string }) => void;
	onResetAdjustments: () => void;
	onApplyAiPreset: (opts: {
		preset: PresetDto;
		intensity: PresetIntensity;
		extraPrompt?: string;
	}) => void;
	onRemixPrompt: (prompt: string) => void;
	onPresetsChanged: () => void;
	onNotice: (msg: string) => void;
}

/**
 * Unified Filters & Effects Presets Studio:
 * - Instant 0-credit WebGL2 GPU filters with live photo thumbnails, hover preview & Amount slider
 * - Server-resolved hidden-prompt AI Effects & Hybrid looks with intensity, tweak note & Peek/Remix
 * - Custom user preset creator (GPU filter, AI hidden-prompt, or Hybrid) + JSON Import/Export
 */
export function PresetsPanel({
	imageId,
	photoSource,
	presets,
	adjustments,
	hasSelection,
	selectionLabel,
	busy = false,
	initialCreateKind,
	initialCreatePrompt,
	onConsumeInitialCreate,
	onPreviewAdjustments,
	onApplyFilterAdjustments,
	onBakeFilterBranch,
	onResetAdjustments,
	onApplyAiPreset,
	onRemixPrompt,
	onPresetsChanged,
	onNotice,
}: PresetsPanelProps) {
	const [tab, setTab] = useState<PanelTab>("filters");
	const [category, setCategory] = useState<"all" | PresetCategory>("all");
	const [query, setQuery] = useState("");

	// Selected AI/Hybrid preset awaiting explicit Apply click (prevents accidental credit burns).
	const [selectedAiId, setSelectedAiId] = useState<string | null>(null);
	const [intensity, setIntensity] = useState<PresetIntensity>("balanced");
	const [extraPrompt, setExtraPrompt] = useState("");
	const [peekOpen, setPeekOpen] = useState(false);

	// Custom preset creator form state.
	const [creating, setCreating] = useState<boolean>(false);
	const [newKind, setNewKind] = useState<PresetKind>("filter");
	const [newName, setNewName] = useState("");
	const [newCategory, setNewCategory] = useState<PresetCategory>("custom");
	const [newDescription, setNewDescription] = useState("");
	const [newPrompt, setNewPrompt] = useState("");
	const [newScope, setNewScope] = useState<PresetTargetScope>("whole");
	const [newOpClass, setNewOpClass] = useState<"reimagine" | "style_transfer">("reimagine");
	const [newIntensity, setNewIntensity] = useState<PresetIntensity>("balanced");
	const [savingPreset, setSavingPreset] = useState(false);
	const importInputRef = useRef<HTMLInputElement>(null);

	// Respond to external "Save as Preset" triggers (from AdjustPanel or HistoryPanel).
	useEffect(() => {
		if (!initialCreateKind) return;
		const id = window.setTimeout(() => {
			setTab("saved");
			setCreating(true);
			setNewKind(initialCreateKind);
			setNewCategory(initialCreateKind === "filter" ? "film" : "custom");
			setNewName("");
			setNewDescription("");
			setNewPrompt(initialCreatePrompt ?? "");
			onConsumeInitialCreate?.();
		}, 0);
		return () => window.clearTimeout(id);
	}, [initialCreateKind, initialCreatePrompt, onConsumeInitialCreate]);

	const filterPresets = useMemo(
		() => presets.filter((p) => p.kind === "filter"),
		[presets],
	);
	const aiPresets = useMemo(
		() => presets.filter((p) => p.kind === "ai_effect" || p.kind === "hybrid"),
		[presets],
	);
	const customPresets = useMemo(
		() => presets.filter((p) => !p.isBuiltIn),
		[presets],
	);

	// Cached live GPU thumbnails rendered from the current photo once per image/filter set.
	const filterThumbKey = useMemo(
		() => `${imageId}:${filterPresets.map((p) => p.id).join(",")}`,
		[imageId, filterPresets],
	);
	const [thumbs, setThumbs] = useState<Record<string, string>>({});
	useEffect(() => {
		if (!photoSource || filterPresets.length === 0) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			if (cancelled) return;
			const rendered = renderPresetThumbnails(photoSource, filterPresets, 160);
			if (!cancelled) setThumbs(rendered);
		}, 16);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [photoSource, filterThumbKey, filterPresets]);

	const activeFilterPreset = useMemo(
		() => (adjustments.presetId ? filterPresets.find((p) => p.id === adjustments.presetId) ?? null : null),
		[adjustments.presetId, filterPresets],
	);

	const selectedAiPreset = useMemo(
		() => (selectedAiId ? aiPresets.find((p) => p.id === selectedAiId) ?? null : null),
		[selectedAiId, aiPresets],
	);

	const activeIntensity = adjustments.presetIntensity ?? 1;
	const hasGrade = Object.keys(extractGrade(adjustments)).length > 0;
	const hasAnyAdj = hasNonZeroAdjustments(adjustments);

	const visibleItems = useMemo(() => {
		const base = tab === "filters" ? filterPresets : tab === "ai" ? aiPresets : customPresets;
		const q = query.trim().toLowerCase();
		return base.filter((p) => {
			if (tab !== "saved" && category !== "all") {
				if (tab === "ai" && category === "cinematic") {
					if (p.kind !== "hybrid") return false;
				} else if (p.category !== category) {
					return false;
				}
			}
			if (!q) return true;
			return (
				p.name.toLowerCase().includes(q) ||
				p.description.toLowerCase().includes(q) ||
				p.category.toLowerCase().includes(q)
			);
		});
	}, [tab, category, query, filterPresets, aiPresets, customPresets]);

	function applyGpuPreset(preset: PresetDto, amount = 1) {
		if (!preset.adjustments) return;
		onPreviewAdjustments(null);
		onApplyFilterAdjustments(interpolatePresetAdjustments(adjustments, preset.adjustments, amount, preset.id));
	}

	function selectAiCard(preset: PresetDto) {
		setSelectedAiId(preset.id);
		setIntensity(preset.aiMeta?.defaultIntensity ?? "balanced");
		setPeekOpen(false);
	}

	async function handleSaveCustomPreset(e: React.FormEvent) {
		e.preventDefault();
		const name = newName.trim();
		if (!name || savingPreset) return;
		const grade = extractGrade(adjustments);
		if (newKind === "filter" && Object.keys(grade).length === 0) {
			onNotice("Adjust at least one Light, Color, or Film slider before saving a GPU Filter preset.");
			return;
		}
		if ((newKind === "ai_effect" || newKind === "hybrid") && newPrompt.trim().length < 3) {
			onNotice("Enter a hidden prompt template (at least 3 characters) for this AI preset.");
			return;
		}
		setSavingPreset(true);
		try {
			await api.createPreset({
				name,
				category: newCategory,
				kind: newKind,
				description: newDescription.trim(),
				...(newKind === "filter" || (newKind === "hybrid" && Object.keys(grade).length > 0)
					? { adjustments: grade }
					: {}),
				...(newKind !== "filter"
					? {
							promptTemplate: newPrompt.trim(),
							targetScope: newScope,
							opClass: newOpClass,
							defaultIntensity: newIntensity,
						}
					: {}),
			});
			setCreating(false);
			setNewName("");
			setNewDescription("");
			setNewPrompt("");
			onPresetsChanged();
		} catch (err) {
			onNotice(describeError(err));
		} finally {
			setSavingPreset(false);
		}
	}

	async function handleToggleFavorite(preset: PresetDto) {
		if (preset.isBuiltIn) return;
		try {
			await api.updatePreset(preset.id, { isFavorite: !preset.isFavorite });
			onPresetsChanged();
		} catch (err) {
			onNotice(describeError(err));
		}
	}

	async function handleDeletePreset(preset: PresetDto) {
		if (preset.isBuiltIn) return;
		try {
			await api.deletePreset(preset.id);
			if (selectedAiId === preset.id) setSelectedAiId(null);
			onPresetsChanged();
		} catch (err) {
			onNotice(describeError(err));
		}
	}

	function handleExportPreset(preset: PresetDto) {
		const json = exportPresetRecipe(preset);
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${preset.slug || "preset"}.editorium-preset.json`;
		a.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	async function handleImportFile(file: File | undefined) {
		if (!file) return;
		try {
			const text = await file.text();
			const recipe = parseImportedPresetJson(text);
			await api.createPreset({
				name: recipe.name,
				category: recipe.category,
				kind: recipe.kind,
				description: recipe.description,
				adjustments: recipe.adjustments,
				promptTemplate: recipe.promptTemplate,
				targetScope: recipe.targetScope,
				opClass: recipe.opClass,
				defaultIntensity: recipe.defaultIntensity,
			});
			setTab("saved");
			onPresetsChanged();
		} catch (err) {
			onNotice(err instanceof Error ? err.message : describeError(err));
		} finally {
			if (importInputRef.current) importInputRef.current.value = "";
		}
	}

	const categories = tab === "filters" ? FILTER_CATEGORIES : tab === "ai" ? AI_CATEGORIES : [];

	return (
		<div className="flex min-h-0 flex-1 flex-col text-xs">
			{/* Mode tabs */}
			<div className="border-b ed-hairline px-3 py-2.5 space-y-2">
				<div className="grid grid-cols-3 gap-1 rounded-xl bg-secondary/60 p-0.5" role="tablist" aria-label="Preset type">
					<button
						type="button"
						role="tab"
						aria-selected={tab === "filters"}
						onClick={() => {
							setTab("filters");
							setCategory("all");
							onPreviewAdjustments(null);
						}}
						className={`rounded-lg py-1 font-medium transition ${
							tab === "filters" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
						}`}
					>
						Filters
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "ai"}
						onClick={() => {
							setTab("ai");
							setCategory("all");
							onPreviewAdjustments(null);
						}}
						className={`rounded-lg py-1 font-medium transition ${
							tab === "ai" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
						}`}
					>
						AI Effects
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "saved"}
						onClick={() => {
							setTab("saved");
							setCategory("all");
							onPreviewAdjustments(null);
						}}
						className={`rounded-lg py-1 font-medium transition ${
							tab === "saved" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
						}`}
					>
						Saved ({customPresets.length})
					</button>
				</div>

				{/* Search */}
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={tab === "filters" ? "Search filters…" : tab === "ai" ? "Search AI effects…" : "Search saved…"}
					aria-label="Search presets"
					className="w-full rounded-lg border ed-hairline bg-background/60 px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:border-indigo-400/60"
				/>

				{/* Category pills */}
				{categories.length > 0 && (
					<div className="flex flex-wrap gap-1">
						{categories.map((c) => (
							<button
								key={c.id}
								type="button"
								aria-pressed={category === c.id}
								onClick={() => setCategory(c.id)}
								className={`rounded-full px-2 py-0.5 text-[11px] transition ${
									category === c.id
										? "bg-indigo-500/25 font-medium text-indigo-200"
										: "text-muted-foreground hover:bg-muted hover:text-foreground"
								}`}
							>
								{c.label}
							</button>
						))}
					</div>
				)}
			</div>

			{/* Main scrollable catalog */}
			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
				{tab === "saved" && (
					<div className="mb-3 space-y-2">
						<div className="flex flex-wrap gap-1.5">
							<button
								type="button"
								onClick={() => {
									setCreating(true);
									setNewKind("filter");
									setNewCategory("film");
								}}
								className="rounded-lg border ed-hairline bg-secondary/70 px-2 py-1 text-[11px] font-medium hover:bg-muted"
							>
								+ Save GPU Look
							</button>
							<button
								type="button"
								onClick={() => {
									setCreating(true);
									setNewKind("ai_effect");
									setNewCategory("custom");
								}}
								className="rounded-lg border border-indigo-400/40 bg-indigo-500/15 px-2 py-1 text-[11px] font-medium text-indigo-200 hover:bg-indigo-500/25"
							>
								+ New AI Preset
							</button>
							<button
								type="button"
								onClick={() => importInputRef.current?.click()}
								className="ml-auto rounded-lg border ed-hairline px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								Import JSON
							</button>
							<input
								ref={importInputRef}
								type="file"
								accept=".json,application/json"
								aria-label="Import preset JSON"
								className="hidden"
								onChange={(e) => void handleImportFile(e.target.files?.[0])}
							/>
						</div>

						{creating && (
							<form
								onSubmit={(e) => void handleSaveCustomPreset(e)}
								className="space-y-2 rounded-xl border ed-hairline bg-card/80 p-2.5"
							>
								<div className="flex items-center justify-between">
									<span className="font-semibold">Create Custom Preset</span>
									<button
										type="button"
										onClick={() => setCreating(false)}
										className="text-muted-foreground hover:text-foreground"
									>
										×
									</button>
								</div>

								<div className="grid grid-cols-3 gap-1">
									{(
										[
											["filter", "GPU Filter"],
											["ai_effect", "AI Effect"],
											["hybrid", "Hybrid"],
										] as const
									).map(([k, lbl]) => (
										<button
											key={k}
											type="button"
											onClick={() => setNewKind(k)}
											className={`rounded-lg border py-1 text-[11px] ${
												newKind === k
													? "border-indigo-400 bg-indigo-500/20 text-indigo-200"
													: "ed-hairline text-muted-foreground"
											}`}
										>
											{lbl}
										</button>
									))}
								</div>

								<input
									required
									maxLength={48}
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
									placeholder="Preset name (e.g. Warm Street 35mm)"
									aria-label="Preset name"
									className="w-full rounded-lg border ed-hairline bg-background px-2 py-1 text-xs outline-none focus:border-indigo-400"
								/>

								<input
									maxLength={160}
									value={newDescription}
									onChange={(e) => setNewDescription(e.target.value)}
									placeholder="Short description (optional)"
									aria-label="Preset description"
									className="w-full rounded-lg border ed-hairline bg-background px-2 py-1 text-xs outline-none focus:border-indigo-400"
								/>

								{newKind !== "filter" && (
									<>
										<textarea
											required
											rows={3}
											maxLength={400}
											value={newPrompt}
											onChange={(e) => setNewPrompt(e.target.value)}
											placeholder="Hidden prompt recipe (e.g. Relight in warm tungsten cafe light with gentle shadow falloff…)"
											aria-label="Hidden prompt template"
											className="w-full resize-none rounded-lg border ed-hairline bg-background px-2 py-1 text-xs outline-none focus:border-indigo-400"
										/>
										<div className="grid grid-cols-2 gap-1.5">
											<select
												aria-label="Target scope"
												value={newScope}
												onChange={(e) => setNewScope(e.target.value as PresetTargetScope)}
												className="rounded-lg border ed-hairline bg-background px-2 py-1 text-[11px]"
											>
												<option value="whole">Scope: Whole photo</option>
												<option value="background">Scope: Background (Auto-Mask)</option>
												<option value="subject">Scope: Subject (Auto-Mask)</option>
											</select>
											<select
												aria-label="AI style mode"
												value={newOpClass}
												onChange={(e) => setNewOpClass(e.target.value as "reimagine" | "style_transfer")}
												className="rounded-lg border ed-hairline bg-background px-2 py-1 text-[11px]"
											>
												<option value="reimagine">Mode: Natural Relight</option>
												<option value="style_transfer">Mode: Artistic Style</option>
											</select>
										</div>
										<select
											aria-label="Default intensity"
											value={newIntensity}
											onChange={(e) => setNewIntensity(e.target.value as PresetIntensity)}
											className="w-full rounded-lg border ed-hairline bg-background px-2 py-1 text-[11px]"
										>
											<option value="subtle">Default strength: Subtle</option>
											<option value="balanced">Default strength: Balanced</option>
											<option value="bold">Default strength: Bold</option>
										</select>
									</>
								)}

								{(newKind === "filter" || newKind === "hybrid") && (
									<p className="text-[11px] text-muted-foreground">
										{hasGrade
											? "Captures your current Adjust sliders automatically."
											: newKind === "filter"
												? "Tip: dial in sliders in the Adjust tab first to capture a GPU look."
												: "Optional: dial in Adjust sliders to pair a live GPU finish."}
									</p>
								)}

								<button
									type="submit"
									disabled={savingPreset || !newName.trim()}
									className="w-full rounded-full bg-foreground py-1.5 font-medium text-background transition hover:opacity-85 disabled:opacity-40"
								>
									{savingPreset ? "Saving…" : "Save Preset"}
								</button>
							</form>
						)}
					</div>
				)}

				{visibleItems.length === 0 ? (
					<div className="rounded-xl border ed-hairline px-3 py-6 text-center text-muted-foreground">
						{tab === "saved"
							? "No saved presets yet. Save your current Adjust look or create a custom hidden-prompt AI effect."
							: "No presets match your filter."}
					</div>
				) : tab === "filters" ? (
					<div className="grid grid-cols-2 gap-2">
						{visibleItems.map((preset) => {
							const active = adjustments.presetId === preset.id;
							const thumbSrc = thumbs[preset.id] ?? fileUrl(imageId, "thumb");
							return (
								<button
									key={preset.id}
									type="button"
									title={preset.description}
									aria-pressed={active}
									onMouseEnter={() => {
										if (preset.adjustments) {
											onPreviewAdjustments(
												interpolatePresetAdjustments(
													adjustments,
													preset.adjustments,
													active ? activeIntensity : 1,
													preset.id,
												),
											);
										}
									}}
									onMouseLeave={() => onPreviewAdjustments(null)}
									onClick={() => applyGpuPreset(preset, active ? activeIntensity : 1)}
									className={`group overflow-hidden rounded-xl border text-left transition ${
										active
											? "border-indigo-400 ring-1 ring-indigo-400/50 bg-indigo-500/10"
											: "ed-hairline bg-card/50 hover:border-white/25"
									}`}
								>
									<div className="relative aspect-[4/3] w-full overflow-hidden bg-black/40">
										<img
											src={thumbSrc}
											alt={preset.name}
											className="size-full object-cover transition duration-200 group-hover:scale-[1.03]"
										/>
										<span className="absolute right-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[9px] font-medium text-emerald-300 backdrop-blur-sm">
											Free
										</span>
									</div>
									<div className="px-2 py-1.5">
										<p className="truncate font-medium text-foreground">{preset.name}</p>
										<p className="truncate text-[10px] capitalize text-muted-foreground">{preset.category}</p>
									</div>
								</button>
							);
						})}
					</div>
				) : tab === "ai" ? (
					<div className="grid grid-cols-2 gap-2">
						{visibleItems.map((preset) => {
							const selected = selectedAiId === preset.id;
							const [c1, c2] = preset.aiMeta?.accentSwatches ?? ["#6366f1", "#ec4899"];
							return (
								<button
									key={preset.id}
									type="button"
									title={preset.description}
									aria-pressed={selected}
									onClick={() => selectAiCard(preset)}
									className={`overflow-hidden rounded-xl border text-left transition ${
										selected
											? "border-indigo-400 ring-1 ring-indigo-400/50 bg-indigo-500/15"
											: "ed-hairline bg-card/50 hover:border-white/25"
									}`}
								>
									<div
										className="relative flex aspect-[16/10] w-full flex-col justify-between p-2"
										style={{ backgroundImage: `linear-gradient(135deg, ${c1}, ${c2})` }}
									>
										<div className="flex items-center justify-between gap-1">
											<span className="rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] font-medium text-white backdrop-blur-sm">
												{scopeBadge(preset, hasSelection)}
											</span>
											<span className="rounded-full bg-black/65 px-1.5 py-0.5 text-[9px] font-medium text-amber-200 backdrop-blur-sm">
												2 cr
											</span>
										</div>
										<p className="truncate text-xs font-semibold text-white drop-shadow">{preset.name}</p>
									</div>
									<div className="px-2 py-1.5">
										<p className="line-clamp-2 text-[10px] leading-snug text-muted-foreground">{preset.description}</p>
									</div>
								</button>
							);
						})}
					</div>
				) : (
					<div className="space-y-2">
						{visibleItems.map((preset) => {
							const isFilter = preset.kind === "filter";
							const active = isFilter ? adjustments.presetId === preset.id : selectedAiId === preset.id;
							return (
								<div
									key={preset.id}
									className={`rounded-xl border p-2.5 transition ${
										active ? "border-indigo-400 bg-indigo-500/10" : "ed-hairline bg-card/50"
									}`}
								>
									<div className="flex items-start justify-between gap-2">
										<button
											type="button"
											onClick={() => {
												if (isFilter) applyGpuPreset(preset, 1);
												else selectAiCard(preset);
											}}
											className="min-w-0 flex-1 text-left"
										>
											<div className="flex items-center gap-1.5">
												<span className="truncate font-medium text-foreground">{preset.name}</span>
												<span
													className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
														isFilter
															? "bg-emerald-500/15 text-emerald-300"
															: "bg-indigo-500/20 text-indigo-200"
													}`}
												>
													{isFilter ? "GPU · Free" : preset.kind === "hybrid" ? "Hybrid · 2 cr" : "AI · 2 cr"}
												</span>
											</div>
											<p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{preset.description}</p>
										</button>
										<div className="flex shrink-0 items-center gap-1">
											<button
												type="button"
												title={preset.isFavorite ? "Unpin favorite" : "Pin favorite"}
												aria-label={preset.isFavorite ? `Unfavorite ${preset.name}` : `Favorite ${preset.name}`}
												onClick={() => void handleToggleFavorite(preset)}
												className={`rounded px-1 py-0.5 text-xs ${
													preset.isFavorite ? "text-amber-300" : "text-muted-foreground hover:text-foreground"
												}`}
											>
												{preset.isFavorite ? "★" : "☆"}
											</button>
											<button
												type="button"
												title="Export recipe JSON"
												aria-label={`Export ${preset.name}`}
												onClick={() => handleExportPreset(preset)}
												className="rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
											>
												↓
											</button>
											<button
												type="button"
												title="Delete preset"
												aria-label={`Delete ${preset.name}`}
												onClick={() => void handleDeletePreset(preset)}
												className="rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-red-500/20 hover:text-red-300"
											>
												×
											</button>
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* Sticky Bottom Dock: GPU Amount slider OR AI Effect Apply confirmation bar */}
			{selectedAiPreset && (tab === "ai" || (tab === "saved" && selectedAiPreset.kind !== "filter")) ? (
				<div className="space-y-2 border-t ed-hairline bg-card/90 p-3">
					<div className="flex items-center justify-between gap-2">
						<span className="truncate font-semibold text-foreground">{selectedAiPreset.name}</span>
						<button
							type="button"
							onClick={() => setSelectedAiId(null)}
							className="text-[11px] text-muted-foreground hover:text-foreground"
						>
							Clear
						</button>
					</div>
					<p className="text-[11px] leading-snug text-muted-foreground">
						{scopeExplanation(selectedAiPreset, hasSelection, selectionLabel)}
					</p>

					{/* Intensity pills */}
					<div className="grid grid-cols-3 gap-1" role="group" aria-label="Effect strength">
						{(["subtle", "balanced", "bold"] as const).map((level) => (
							<button
								key={level}
								type="button"
								aria-pressed={intensity === level}
								onClick={() => setIntensity(level)}
								className={`rounded-lg border py-1 text-[11px] capitalize transition ${
									intensity === level
										? "border-indigo-400 bg-indigo-500/20 font-medium text-indigo-200"
										: "ed-hairline text-muted-foreground hover:text-foreground"
								}`}
							>
								{level}
							</button>
						))}
					</div>

					{/* Optional user tweak */}
					<input
						type="text"
						maxLength={200}
						value={extraPrompt}
						onChange={(e) => setExtraPrompt(e.target.value)}
						placeholder="Optional tweak (e.g. keep jacket red)…"
						aria-label="Optional effect tweak"
						className="w-full rounded-lg border ed-hairline bg-background px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:border-indigo-400"
					/>

					{/* Progressive disclosure: Peek / Remix hidden prompt */}
					{selectedAiPreset.aiMeta?.remixPrompt && (
						<div>
							<button
								type="button"
								aria-expanded={peekOpen}
								onClick={() => setPeekOpen((v) => !v)}
								className="text-[11px] text-indigo-300 hover:underline"
							>
								{peekOpen ? "Hide recipe" : "Peek / Remix prompt"}
							</button>
							{peekOpen && (
								<div className="mt-1.5 space-y-1.5 rounded-lg border ed-hairline bg-background/70 p-2 text-[11px] text-muted-foreground">
									<p className="leading-relaxed">{selectedAiPreset.aiMeta.remixPrompt}</p>
									<button
										type="button"
										onClick={() => onRemixPrompt(selectedAiPreset.aiMeta?.remixPrompt ?? "")}
										className="rounded-full border ed-hairline px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-muted"
									>
										Load into Composer
									</button>
								</div>
							)}
						</div>
					)}

					<button
						type="button"
						disabled={busy}
						onClick={() => {
							onApplyAiPreset({
								preset: selectedAiPreset,
								intensity,
								extraPrompt: extraPrompt.trim() || undefined,
							});
							setExtraPrompt("");
						}}
						className="w-full rounded-full bg-indigo-500 py-2 font-medium text-white transition hover:bg-indigo-400 disabled:opacity-40"
					>
						{busy ? "Applying…" : `Apply ${selectedAiPreset.name} (2 credits)`}
					</button>
				</div>
			) : (
				(activeFilterPreset || hasAnyAdj) && (
					<div className="space-y-2 border-t ed-hairline bg-card/90 p-3">
						{activeFilterPreset && (
							<label className="block space-y-1">
								<div className="flex items-center justify-between text-[11px]">
									<span className="truncate font-medium text-foreground">{activeFilterPreset.name}</span>
									<span className="tabular-nums text-muted-foreground">{Math.round(activeIntensity * 100)}%</span>
								</div>
								<input
									type="range"
									aria-label="Preset intensity"
									min={0}
									max={1}
									step={0.02}
									value={activeIntensity}
									onChange={(e) => applyGpuPreset(activeFilterPreset, Number(e.target.value))}
									className="w-full accent-indigo-400"
								/>
							</label>
						)}
						<div className="flex items-center gap-2">
							<button
								type="button"
								disabled={busy || !hasAnyAdj}
								onClick={() =>
									onBakeFilterBranch(
										activeFilterPreset ? activeFilterPreset.name : "Color grade",
										activeFilterPreset ? { id: activeFilterPreset.id, name: activeFilterPreset.name } : undefined,
									)
								}
								className="flex-1 rounded-full bg-foreground py-1.5 font-medium text-background transition hover:opacity-85 disabled:opacity-40"
							>
								Bake branch (Free)
							</button>
							<button
								type="button"
								disabled={busy || !hasAnyAdj}
								onClick={onResetAdjustments}
								className="rounded-full border ed-hairline px-3 py-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
							>
								Reset
							</button>
						</div>
					</div>
				)
			)}
		</div>
	);
}
