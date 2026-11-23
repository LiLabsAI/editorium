import type { ImageAdjustments } from "../lib/api";
import { hasNonZeroAdjustments } from "../editor/webgl";

type NumericKey =
	| "exposure"
	| "contrast"
	| "highlights"
	| "shadows"
	| "temperature"
	| "tint"
	| "vibrance"
	| "saturation"
	| "clarity"
	| "vignette"
	| "fade"
	| "grain"
	| "bloom"
	| "sepia"
	| "splitShadowHue"
	| "splitShadowAmt"
	| "splitHighlightHue"
	| "splitHighlightAmt"
	| "straighten";

interface SliderSpec {
	key: NumericKey;
	label: string;
	min: number;
	max: number;
	step: number;
	unit?: string;
}

const SLIDER_GROUPS: Array<{ title: string; items: SliderSpec[] }> = [
	{
		title: "Light",
		items: [
			{ key: "exposure", label: "Exposure", min: -2, max: 2, step: 0.05 },
			{ key: "contrast", label: "Contrast", min: -1, max: 1, step: 0.02 },
			{ key: "highlights", label: "Highlights", min: -1, max: 1, step: 0.02 },
			{ key: "shadows", label: "Shadows", min: -1, max: 1, step: 0.02 },
		],
	},
	{
		title: "Color",
		items: [
			{ key: "temperature", label: "Warmth", min: -1, max: 1, step: 0.02 },
			{ key: "tint", label: "Tint", min: -1, max: 1, step: 0.02 },
			{ key: "vibrance", label: "Vibrance", min: -1, max: 1, step: 0.02 },
			{ key: "saturation", label: "Saturation", min: -1, max: 1, step: 0.02 },
		],
	},
	{
		title: "Detail & Film",
		items: [
			{ key: "clarity", label: "Clarity", min: -1, max: 1, step: 0.02 },
			{ key: "fade", label: "Matte Fade", min: 0, max: 1, step: 0.02 },
			{ key: "grain", label: "Film Grain", min: 0, max: 1, step: 0.02 },
			{ key: "bloom", label: "Glow / Halation", min: 0, max: 1, step: 0.02 },
			{ key: "sepia", label: "Sepia", min: 0, max: 1, step: 0.02 },
			{ key: "vignette", label: "Vignette", min: 0, max: 1, step: 0.02 },
		],
	},
	{
		title: "Split Toning",
		items: [
			{ key: "splitShadowHue", label: "Shadow Hue", min: 0, max: 360, step: 2, unit: "°" },
			{ key: "splitShadowAmt", label: "Shadow Tint", min: 0, max: 1, step: 0.02 },
			{ key: "splitHighlightHue", label: "Highlight Hue", min: 0, max: 360, step: 2, unit: "°" },
			{ key: "splitHighlightAmt", label: "Highlight Tint", min: 0, max: 1, step: 0.02 },
		],
	},
];

/** Non-destructive GPU shader adjustment & geometry panel. */
export function AdjustPanel({
	adjustments,
	activePresetName,
	onChange,
	onReset,
	onBakeToBranch,
	onOpenCrop,
	onSaveAsPreset,
	saving,
	busy,
}: {
	adjustments: ImageAdjustments;
	activePresetName?: string | null;
	onChange: (next: ImageAdjustments) => void;
	onReset: () => void;
	onBakeToBranch: () => void;
	onOpenCrop: () => void;
	onSaveAsPreset?: () => void;
	saving?: boolean;
	busy?: boolean;
}) {
	const changed = hasNonZeroAdjustments(adjustments);

	const setNum = (key: NumericKey, val: number) => {
		const next: ImageAdjustments = { ...adjustments, [key]: val === 0 ? undefined : val };
		onChange(next);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3 text-xs">
			<div className="mb-3 flex items-center justify-between">
				<span className="text-sm font-semibold">Adjust & Transform</span>
				<span className="text-[11px] text-muted-foreground">
					{saving ? "Saving…" : changed ? "Live GPU look" : "Original"}
				</span>
			</div>

			{activePresetName && (
				<div className="mb-3 flex items-center justify-between rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-2.5 py-1.5 text-[11px]">
					<span className="truncate text-indigo-200">Preset: {activePresetName}</span>
					<span className="text-muted-foreground">
						{Math.round((adjustments.presetIntensity ?? 1) * 100)}%
					</span>
				</div>
			)}

			{/* Quick transform bar */}
			<div className="mb-4 flex flex-wrap gap-1.5">
				<button
					type="button"
					onClick={() => onChange({ ...adjustments, rotate90: (((adjustments.rotate90 ?? 0) + 1) % 4) as 0 | 1 | 2 | 3 })}
					className="rounded-lg border ed-hairline bg-secondary/60 px-2.5 py-1 hover:bg-muted"
				>
					Rotate 90°
				</button>
				<button
					type="button"
					aria-pressed={!!adjustments.flipH}
					onClick={() => onChange({ ...adjustments, flipH: !adjustments.flipH })}
					className={`rounded-lg border px-2.5 py-1 ${
						adjustments.flipH ? "border-indigo-400 bg-indigo-500/20" : "ed-hairline bg-secondary/60 hover:bg-muted"
					}`}
				>
					Flip H
				</button>
				<button
					type="button"
					aria-pressed={!!adjustments.flipV}
					onClick={() => onChange({ ...adjustments, flipV: !adjustments.flipV })}
					className={`rounded-lg border px-2.5 py-1 ${
						adjustments.flipV ? "border-indigo-400 bg-indigo-500/20" : "ed-hairline bg-secondary/60 hover:bg-muted"
					}`}
				>
					Flip V
				</button>
				<button
					type="button"
					onClick={onOpenCrop}
					className="rounded-lg border ed-hairline bg-secondary/60 px-2.5 py-1 hover:bg-muted"
				>
					Crop frame
				</button>
				{adjustments.crop && (
					<button
						type="button"
						onClick={() => {
							const copy = { ...adjustments };
							delete copy.crop;
							onChange(copy);
						}}
						className="rounded-lg border ed-hairline px-2 py-1 text-muted-foreground hover:text-foreground"
					>
						Reset crop
					</button>
				)}
			</div>

			{/* Straighten slider */}
			<label className="mb-4 block space-y-1">
				<div className="flex justify-between text-muted-foreground">
					<button type="button" onClick={() => setNum("straighten", 0)} className="hover:text-foreground">
						Straighten
					</button>
					<span className="tabular-nums">{(adjustments.straighten ?? 0).toFixed(1)}°</span>
				</div>
				<input
					type="range"
					min={-45}
					max={45}
					step={0.5}
					value={adjustments.straighten ?? 0}
					onChange={(e) => setNum("straighten", Number(e.target.value))}
					className="w-full accent-indigo-400"
				/>
			</label>

			{/* Grading groups */}
			<div className="space-y-4">
				{SLIDER_GROUPS.map((group) => (
					<div key={group.title} className="space-y-2 border-t ed-hairline pt-3">
						<p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{group.title}</p>
						{group.items.map((s) => {
							const val = adjustments[s.key] ?? 0;
							return (
								<label key={s.key} className="block space-y-1">
									<div className="flex justify-between">
										<button
											type="button"
											title={`Double-click or click to reset ${s.label}`}
											onClick={() => setNum(s.key, 0)}
											className="text-foreground/90 hover:text-white"
										>
											{s.label}
										</button>
										<span className="tabular-nums text-muted-foreground">
											{s.unit
												? `${Math.round(val)}${s.unit}`
												: val > 0
													? `+${val.toFixed(2)}`
													: val.toFixed(2)}
										</span>
									</div>
									<input
										type="range"
										min={s.min}
										max={s.max}
										step={s.step}
										value={val}
										onChange={(e) => setNum(s.key, Number(e.target.value))}
										className="w-full accent-indigo-400"
									/>
								</label>
							);
						})}
					</div>
				))}
			</div>

			<div className="mt-5 space-y-2 border-t ed-hairline pt-3">
				{onSaveAsPreset && (
					<button
						type="button"
						disabled={!changed || busy}
						onClick={onSaveAsPreset}
						className="w-full rounded-full border border-indigo-400/40 bg-indigo-500/15 py-1.5 font-medium text-indigo-200 transition hover:bg-indigo-500/25 disabled:opacity-40"
					>
						+ Save current look as Preset
					</button>
				)}
				<div className="flex items-center gap-2">
					<button
						type="button"
						disabled={!changed || busy}
						onClick={onBakeToBranch}
						className="flex-1 rounded-full bg-foreground py-1.5 font-medium text-background transition hover:opacity-85 disabled:opacity-40"
					>
						Bake to new branch
					</button>
					<button
						type="button"
						disabled={!changed || busy}
						onClick={onReset}
						className="rounded-full border ed-hairline px-3 py-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
					>
						Reset
					</button>
				</div>
			</div>
		</div>
	);
}
