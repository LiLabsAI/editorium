import type {
	Box,
	ImageAdjustments,
	PortablePresetRecipe,
	PresetCategory,
	PresetDto,
	PresetIntensity,
	PresetKind,
	PresetTargetScope,
} from "../../shared/presets";
import { jobEvents, type JobRealtimeEvent } from "./events";

export type {
	Box,
	ImageAdjustments,
	PortablePresetRecipe,
	PresetCategory,
	PresetDto,
	PresetIntensity,
	PresetKind,
	PresetTargetScope,
};

/** Typed fetch client for the Editorium API. */

export interface AlbumSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	coverImageId: string | null;
	imageCount: number;
}

export interface Me {
	user: { id: string; name: string; plan: string; credits: number } | null;
	project?: { id: string; name: string };
}

export interface ImageDto {
	id: string;
	albumId: string;
	kind: "upload" | "generated" | "edited";
	widthPx: number;
	heightPx: number;
	mime: string;
	sourceImageId: string | null;
	rootImageId?: string | null;
	currentVersionId: string | null;
	filenameLabel: string;
	bookmarkedAt: string | null;
	segmentStatus: "none" | "pending" | "partial" | "ready" | "failed";
	adjustmentsJson?: string | null;
	overlayR2Key?: string | null;
	positionIdx: number;
	createdAt: string;
}

export type OpClass =
	| "adjust"
	| "enhance"
	| "segment"
	| "local"
	| "reimagine"
	| "style_transfer"
	| "outpaint"
	| "generate"
	| "answer"
	| "upload";

export interface VersionDto {
	id: string;
	imageId: string;
	parentVersionId: string | null;
	label: string;
	operation: string | null;
	prompt: string | null;
	/** How this version was produced (phase 4 audit). */
	opClass: Exclude<OpClass, "answer" | "upload"> | null;
	model: string | null;
	fidelity: number | null;
	adjustmentsJson?: string | null;
	createdAt: string;
}

export interface SegmentDto {
	id: string;
	imageId: string;
	parentSegmentId: string | null;
	label: string;
	caption: string | null;
	bboxX: number;
	bboxY: number;
	bboxW: number;
	bboxH: number;
	polygonJson?: string | null;
	maskR2Key?: string | null;
	lockedAt: string | null;
	hiddenAt: string | null;
	deletedAt: string | null;
	hasPrompt: boolean;
	orderIdx: number;
}

export interface ThreadDto {
	id: string;
	albumId: string;
	title: string;
	/** Set for a photo family's editor history (phase 5). */
	rootImageId: string | null;
	createdAt: string;
}

export interface MessageDto {
	id: string;
	threadId: string;
	role: "user" | "assistant";
	text: string;
	attachedImageId: string | null;
	resultImageId: string | null;
	operation: string | null;
	jobId: string | null;
	createdAt: string;
}

export interface JobDto {
	id: string;
	type: string;
	status: "queued" | "running" | "done" | "error";
	progress: number;
	error: string | null;
	imageId: string | null;
	resultImageId: string | null;
}

export interface EditInstructionDto {
	id: string;
	text: string;
	bboxX: number;
	bboxY: number;
	bboxW: number;
	bboxH: number;
	maskR2Key?: string | null;
}

export interface AnnotationDto {
	id: string;
	imageId: string;
	text: string;
	normX: number;
	normY: number;
	fontSize: number;
	color: string;
}

export interface ReferenceDto {
	id: string;
	projectId: string;
	title: string;
	r2KeyFull: string | null;
	r2KeyThumb: string;
	mime: string;
	widthPx: number;
	heightPx: number;
	kind: string;
	createdAt: string;
}

export interface ShareLinkDto {
	id: string;
	token: string;
	allowDownload: boolean;
	expiresAt: string | null;
	createdAt: string;
}

/** One request and its reply in a photo family's history (server-derived). */
export interface HistoryTurn {
	id: string;
	createdAt: string;
	derived: boolean;
	request: {
		text: string;
		opClass: OpClass | null;
		bboxes: Box[];
		imageId: string | null;
		presetId?: string | null;
		presetName?: string | null;
	};
	reply: {
		status: "queued" | "running" | "done" | "error";
		text: string;
		error: string | null;
		credits: number;
		refunded: boolean;
		result: {
			imageId: string;
			label: string;
			opClass: string | null;
			model: string | null;
			fidelity: number | null;
			presetId?: string | null;
			presetName?: string | null;
			exists: boolean;
		} | null;
	};
}

export interface PaletteDto {
	palette: { id: string; colorsJson: string; source: string };
	link: { scope: string; segmentId: string | null };
}

export class ApiError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code);
		this.name = "ApiError";
	}
}

/** Turn an API error code into a sentence for the UI. */
export function describeError(err: unknown): string {
	const code = err instanceof ApiError ? err.code : err instanceof Error ? err.message : String(err);
	const messages: Record<string, string> = {
		rate_limited: "You're going a bit fast — wait a minute and try again.",
		too_many_requests: "You're going a bit fast — wait a minute and try again.",
		quota_exceeded: "You've reached the per-minute limit. Please wait a few seconds.",
		insufficient_credits: "You're out of credits.",
		unauthorized: "Your session expired — reload the page.",
		file_too_large: "That file is larger than 20 MB.",
		invalid_file: "That file could not be read.",
		not_an_image: "That file isn't a PNG, JPEG, WebP, or GIF image.",
		invalid_body: "That request wasn't valid.",
		invalid_form: "Upload data was malformed.",
		empty_patch: "No changes were supplied.",
		not_found: "That item no longer exists.",
		segment_locked: "This layer is locked — unlock it in the Layers drawer to edit.",
		polygon_too_small: "Draw a slightly larger area first.",
		invalid_mask: "The selection mask wasn't valid PNG data.",
		mask_must_be_png: "Selection masks must be encoded as PNG.",
		overlay_must_be_png: "Text overlay must be a PNG image.",
		already_applying: "Those instructions are already being applied.",
		no_instructions: "Add at least one edit chip before applying.",
		empty_outpaint_padding: "Extend at least one border before generating.",
		dimensions_exceed_limit: "Expanded dimensions exceed the 4096px maximum.",
		download_disabled: "Downloads are disabled on this share link.",
		invalid_key: "That owner key isn't valid.",
		preset_not_found: "That preset no longer exists.",
		preset_requires_ai: "Filter presets apply instantly in the canvas without running an AI job.",
		builtin_immutable: "Built-in presets cannot be modified or deleted.",
	};
	return messages[code] ?? "Something went wrong. Please try again.";
}

async function throwIfNotOk(res: Response): Promise<void> {
	if (res.ok) return;
	const detail = (await res.json().catch(() => ({}))) as { error?: string };
	throw new ApiError(detail.error ?? res.statusText ?? "error", res.status);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`/api${path}`, {
		headers: typeof init?.body === "string" ? { "Content-Type": "application/json" } : undefined,
		...init,
	});
	await throwIfNotOk(res);
	return res.json() as Promise<T>;
}

export const api = {
	me: () => request<Me>("/me"),
	/** Private guest account for this browser (no-op if already signed in). */
	guest: () => request<{ ok: boolean; userId: string }>("/auth/guest", { method: "POST" }),
	claimOwner: (key: string) =>
		request<{ ok: boolean }>("/auth/claim", { method: "POST", body: JSON.stringify({ key }) }),
	logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

	albums: (q?: string, sort?: string) =>
		request<{ project: { id: string; name: string }; albums: AlbumSummary[] }>(
			`/albums?${new URLSearchParams({ ...(q ? { q } : {}), ...(sort ? { sort } : {}) })}`,
		),
	albumGet: (id: string) =>
		request<{ album: { id: string; title: string } }>(`/albums/${encodeURIComponent(id)}`),
	createAlbum: (title?: string) =>
		request<{ album: { id: string; title: string } }>("/albums", {
			method: "POST",
			body: JSON.stringify({ title }),
		}),
	renameAlbum: (id: string, title: string) =>
		request<{ album: unknown }>(`/albums/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ title }),
		}),
	deleteAlbum: (id: string) => request<{ ok: boolean }>(`/albums/${encodeURIComponent(id)}`, { method: "DELETE" }),

	references: () => request<{ references: ReferenceDto[] }>("/references"),
	uploadReference: async (file: File, title?: string): Promise<{ reference: ReferenceDto }> => {
		const form = new FormData();
		form.append("file", file);
		if (title?.trim()) form.append("title", title.trim());
		const res = await fetch("/api/references", { method: "POST", body: form });
		await throwIfNotOk(res);
		return res.json();
	},
	deleteReference: (id: string) =>
		request<{ ok: boolean }>(`/references/${encodeURIComponent(id)}`, { method: "DELETE" }),

	albumImages: (albumId: string, filter = "all") =>
		request<{ images: ImageDto[] }>(
			`/albums/${encodeURIComponent(albumId)}/images?filter=${encodeURIComponent(filter)}`,
		),
	albumThreads: (albumId: string) =>
		request<{ threads: ThreadDto[] }>(`/albums/${encodeURIComponent(albumId)}/threads`),
	createThread: (albumId: string, createNew = false) =>
		request<{ thread: ThreadDto; reused?: boolean }>(`/albums/${encodeURIComponent(albumId)}/threads`, {
			method: "POST",
			body: JSON.stringify({ new: createNew }),
		}),
	threadMessages: (threadId: string) =>
		request<{ messages: MessageDto[] }>(`/threads/${encodeURIComponent(threadId)}/messages`),
	sendMessage: (
		threadId: string,
		body: {
			text: string;
			attachedImageId?: string;
			segmentId?: string;
			mentionImageIds?: string[];
			paletteIds?: string[];
		},
		signal?: AbortSignal,
	) =>
		fetch(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		}),

	image: (id: string) =>
		request<{ image: ImageDto; album: { id: string; title: string }; versions: VersionDto[] }>(
			`/images/${encodeURIComponent(id)}`,
		),
	imageVersions: (id: string) =>
		request<{ versions: VersionDto[]; currentId: string | null }>(
			`/images/${encodeURIComponent(id)}/versions`,
		),
	activateVersion: (imageId: string, versionId: string) =>
		request<{ ok: boolean }>(
			`/images/${encodeURIComponent(imageId)}/versions/${encodeURIComponent(versionId)}/activate`,
			{ method: "POST" },
		),
	patchImage: (id: string, body: Partial<Pick<ImageDto, "filenameLabel">> & { bookmarked?: boolean }) =>
		request<{ image: ImageDto }>(`/images/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	saveAdjustments: (imageId: string, adjustments: ImageAdjustments | null) =>
		request<{ ok: boolean; adjustmentsJson: string | null }>(
			`/images/${encodeURIComponent(imageId)}/adjustments`,
			{
				method: "PATCH",
				body: JSON.stringify({ adjustments }),
			},
		),
	deleteImage: (id: string) =>
		request<{ ok: boolean }>(`/images/${encodeURIComponent(id)}`, { method: "DELETE" }),

	segments: (imageId: string) =>
		request<{ segments: SegmentDto[]; status: string; recognizer?: "demo" | "live" }>(
			`/images/${encodeURIComponent(imageId)}/segments`,
		),
	resegment: (imageId: string) =>
		request<{ jobId: string }>(`/images/${encodeURIComponent(imageId)}/resegment`, { method: "POST" }),
	extractSubjectMask: (imageId: string) =>
		request<{ segment: SegmentDto }>(`/images/${encodeURIComponent(imageId)}/subject-mask`, { method: "POST" }),
	patchSegment: (
		id: string,
		body: {
			label?: string;
			bbox?: Box;
			locked?: boolean;
			hidden?: boolean;
		},
	) =>
		request<{ segment: SegmentDto }>(`/segments/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	deleteSegment: (id: string) =>
		request<{ ok: boolean }>(`/segments/${encodeURIComponent(id)}`, { method: "DELETE" }),
	segmentPrompt: (id: string, text: string) =>
		request<{ prompt: { id: string; text: string } }>(`/segments/${encodeURIComponent(id)}/prompts`, {
			method: "POST",
			body: JSON.stringify({ text }),
		}),
	segmentPrompts: (id: string) =>
		request<{ prompts: Array<{ id: string; text: string; isActive: boolean }>; caption: string | null }>(
			`/segments/${encodeURIComponent(id)}/prompts`,
		),

	savePalette: (imageId: string, colors: string[], segmentId?: string) =>
		request<{ palette: { id: string } }>(`/images/${encodeURIComponent(imageId)}/palette`, {
			method: "POST",
			body: JSON.stringify({ colors, segmentId }),
		}),
	imagePalettes: (imageId: string) =>
		request<{ palettes: PaletteDto[] }>(`/images/${encodeURIComponent(imageId)}/palettes`),
	rewritePrompt: (text: string, operation: string, context?: string) =>
		request<{ rewritten: string }>("/prompts/rewrite", {
			method: "POST",
			body: JSON.stringify({ text, operation, context }),
		}),

	job: (id: string) => request<{ job: JobDto }>(`/jobs/${encodeURIComponent(id)}`),

	/** Photo-family timeline + its chat thread (phase 5). */
	history: (imageId: string) =>
		request<{ threadId: string; rootImageId: string; turns: HistoryTurn[] }>(
			`/images/${encodeURIComponent(imageId)}/history`,
		),
	branchFamily: (imageId: string) =>
		request<{ images: ImageDto[]; rootId?: string }>(`/images/${encodeURIComponent(imageId)}/branch`),
	filterBranch: async (
		imageId: string,
		label: string,
		blob: Blob,
		adjustmentsJson?: string,
		preset?: { id: string; name: string },
	) => {
		const form = new FormData();
		form.append("file", blob, "filtered.png");
		form.append("label", label);
		if (adjustmentsJson) form.append("adjustmentsJson", adjustmentsJson);
		if (preset) {
			form.append("presetId", preset.id);
			form.append("presetName", preset.name);
		}
		const res = await fetch(`/api/images/${encodeURIComponent(imageId)}/filter-branch`, {
			method: "POST",
			body: form,
		});
		await throwIfNotOk(res);
		return (await res.json()) as { imageId: string; versionId: string };
	},
	editImage: (imageId: string, prompt: string, referenceImageIds?: string[]) =>
		request<{ jobId: string }>(`/images/${encodeURIComponent(imageId)}/edit`, {
			method: "POST",
			body: JSON.stringify({ prompt, ...(referenceImageIds?.length ? { referenceImageIds } : {}) }),
		}),
	outpaintImage: (
		imageId: string,
		pad: { top: number; bottom: number; left: number; right: number },
		prompt?: string,
	) =>
		request<{ jobId: string }>(`/images/${encodeURIComponent(imageId)}/outpaint`, {
			method: "POST",
			body: JSON.stringify({ ...pad, ...(prompt?.trim() ? { prompt: prompt.trim() } : {}) }),
		}),
	instructions: (imageId: string) =>
		request<{ instructions: EditInstructionDto[] }>(`/images/${encodeURIComponent(imageId)}/instructions`),
	createInstruction: (
		imageId: string,
		body: {
			text: string;
			bbox: Box;
			polygon?: Array<{ x: number; y: number }>;
			maskPngBase64?: string;
		},
	) =>
		request<{ instruction: EditInstructionDto }>(`/images/${encodeURIComponent(imageId)}/instructions`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	deleteInstruction: (id: string) =>
		request<{ ok: boolean }>(`/instructions/${encodeURIComponent(id)}`, { method: "DELETE" }),
	/** Apply pinned instructions; pass ids to apply only those chips. */
	applyInstructions: (imageId: string, instructionIds?: string[]) =>
		request<{ jobId: string; label: string }>(`/images/${encodeURIComponent(imageId)}/apply-instructions`, {
			method: "POST",
			body: JSON.stringify({ instructionIds }),
		}),
	editRegion: (imageId: string, segmentId: string, prompt: string, referenceImageIds?: string[]) =>
		request<{ jobId: string }>(`/images/${encodeURIComponent(imageId)}/edit-region`, {
			method: "POST",
			body: JSON.stringify({ segmentId, prompt, ...(referenceImageIds?.length ? { referenceImageIds } : {}) }),
		}),
	editRegionMask: (
		imageId: string,
		body: {
			bbox: Box;
			prompt: string;
			maskPngBase64?: string;
			label?: string;
			referenceImageIds?: string[];
		},
	) =>
		request<{ jobId: string }>(`/images/${encodeURIComponent(imageId)}/edit-region`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	removeBackground: (imageId: string) =>
		request<{ jobId: string }>(`/images/${encodeURIComponent(imageId)}/remove-background`, { method: "POST" }),
	enhanceImage: (imageId: string) =>
		request<{ jobId: string }>(`/images/${encodeURIComponent(imageId)}/enhance`, { method: "POST" }),
	duplicateImage: (imageId: string) =>
		request<{ image: ImageDto }>(`/images/${encodeURIComponent(imageId)}/duplicate`, { method: "POST" }),
	createSegment: (
		imageId: string,
		polygonOrBody:
			| Array<{ x: number; y: number }>
			| {
					polygon?: Array<{ x: number; y: number }>;
					bbox?: Box;
					maskPngBase64?: string;
					label?: string;
			  },
		label?: string,
	) => {
		const payload = Array.isArray(polygonOrBody)
			? { polygon: polygonOrBody, label }
			: polygonOrBody;
		return request<{ segment: SegmentDto }>(`/images/${encodeURIComponent(imageId)}/segments`, {
			method: "POST",
			body: JSON.stringify(payload),
		});
	},
	annotations: (imageId: string) =>
		request<{ annotations: AnnotationDto[] }>(`/images/${encodeURIComponent(imageId)}/annotations`),
	addAnnotation: (imageId: string, body: { text: string; normX: number; normY: number; fontSize?: number; color?: string }) =>
		request<{ annotation: AnnotationDto }>(`/images/${encodeURIComponent(imageId)}/annotations`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	deleteAnnotation: (id: string) =>
		request<{ ok: boolean }>(`/annotations/${encodeURIComponent(id)}`, { method: "DELETE" }),
	saveOverlay: async (imageId: string, blob: Blob | null): Promise<{ ok: boolean }> => {
		const form = new FormData();
		if (blob) form.append("file", blob, "overlay.png");
		const res = await fetch(`/api/images/${encodeURIComponent(imageId)}/annotations-overlay`, {
			method: "POST",
			body: form,
		});
		await throwIfNotOk(res);
		return res.json();
	},

	shares: (imageId: string) =>
		request<{ shares: ShareLinkDto[] }>(`/images/${encodeURIComponent(imageId)}/shares`),
	share: (imageId: string, allowDownload = true, expiresInHours?: number) =>
		request<{ url: string; share: ShareLinkDto }>(`/images/${encodeURIComponent(imageId)}/share`, {
			method: "POST",
			body: JSON.stringify({ allowDownload, ...(expiresInHours ? { expiresInHours } : {}) }),
		}),
	revokeShare: (id: string) =>
		request<{ ok: boolean }>(`/share/${encodeURIComponent(id)}`, { method: "DELETE" }),
	publicShare: (token: string) =>
		request<{ share: { allowDownload: boolean; title: string; adjustmentsJson?: string | null; hasOverlay?: boolean } }>(
			`/public/share/${encodeURIComponent(token)}`,
		),

	usage: () =>
		request<{ balance: number; events: Array<{ reason: string; total: number; credits: number }> }>("/usage"),

	presets: () => request<{ presets: PresetDto[] }>("/presets"),
	createPreset: (body: {
		name: string;
		category?: PresetCategory;
		kind: PresetKind;
		description?: string;
		adjustments?: ImageAdjustments;
		promptTemplate?: string;
		targetScope?: PresetTargetScope;
		opClass?: "reimagine" | "style_transfer";
		defaultIntensity?: PresetIntensity;
	}) =>
		request<{ preset: PresetDto }>("/presets", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	updatePreset: (
		id: string,
		body: {
			name?: string;
			category?: PresetCategory;
			description?: string;
			adjustments?: ImageAdjustments | null;
			promptTemplate?: string | null;
			targetScope?: PresetTargetScope;
			opClass?: "reimagine" | "style_transfer";
			defaultIntensity?: PresetIntensity;
			isFavorite?: boolean;
		},
	) =>
		request<{ preset: PresetDto }>(`/presets/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	deletePreset: (id: string) =>
		request<{ ok: boolean }>(`/presets/${encodeURIComponent(id)}`, { method: "DELETE" }),
	applyPreset: (
		imageId: string,
		body: {
			presetId: string;
			intensity?: PresetIntensity;
			extraPrompt?: string;
			bbox?: Box;
			maskPngBase64?: string;
			segmentId?: string;
			referenceImageIds?: string[];
			paletteIds?: string[];
		},
	) =>
		request<{ jobId: string; presetName: string }>(`/images/${encodeURIComponent(imageId)}/apply-preset`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
};

export function fileUrl(
	imageId: string,
	variant: "thumb" | "web" | "original" = "web",
	versionId?: string,
	download = false,
): string {
	const v = versionId ? `&v=${encodeURIComponent(versionId)}` : "";
	const dl = download ? "&download=1" : "";
	return `/api/images/${encodeURIComponent(imageId)}/file?variant=${variant}${v}${dl}`;
}

export function referenceFileUrl(refId: string, variant: "thumb" | "original" = "thumb"): string {
	return `/api/references/${encodeURIComponent(refId)}/file?variant=${variant}`;
}

/** Read the agent's SSE stream (`data: {event, data}` frames), calling
 * `onFrame` per frame; malformed frames are skipped. */
export async function readAgentStream(
	res: Response,
	onFrame: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
	if (!res.ok || !res.body) {
		const detail = (await res.json().catch(() => ({}))) as { error?: string };
		throw new ApiError(detail.error ?? "error", res.status);
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
		const parts = buffer.split("\n\n");
		buffer = done ? "" : (parts.pop() ?? "");
		for (const part of parts) {
			const line = part.trim();
			if (!line.startsWith("data:")) continue;
			try {
				const frame = JSON.parse(line.slice(5).trim()) as { event: string; data: Record<string, unknown> };
				onFrame(frame.event, frame.data ?? {});
			} catch {
				// skip a malformed frame
			}
		}
		if (done) break;
	}
}

/** Public share media, addressed by TOKEN (an image id grants nothing). */
export function shareFileUrl(token: string, variant: "web" | "original" = "web"): string {
	return `/api/public/share/${encodeURIComponent(token)}/file?variant=${variant}`;
}

function eventToJobDto(ev: JobRealtimeEvent): JobDto {
	return {
		id: ev.jobId,
		type: ev.jobType ?? "",
		status: ev.status,
		progress: ev.progress,
		error: ev.error ?? null,
		imageId: ev.imageId ?? null,
		resultImageId: ev.resultImageId ?? null,
	};
}

/** Await a job via real-time Durable Object WebSocket with HTTP polling fallback. */
export async function waitForJob(
	jobId: string,
	{
		timeoutMs = 120_000,
		intervalMs = 1500,
		onProgress,
	}: {
		timeoutMs?: number;
		intervalMs?: number;
		onProgress?: (job: JobDto) => void;
	} = {},
): Promise<JobDto | null> {
	const cached = jobEvents.getLatest(jobId);
	if (cached && (cached.status === "done" || cached.status === "error")) {
		return eventToJobDto(cached);
	}

	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const deadline = Date.now() + timeoutMs;

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			unsub();
		};
		const finish = (job: JobDto | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(job);
		};
		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const unsub = jobEvents.subscribeJob(jobId, (ev) => {
			const dto = eventToJobDto(ev);
			onProgress?.(dto);
			if (dto.status === "done" || dto.status === "error") {
				finish(dto);
			}
		});

		const poll = async () => {
			if (settled) return;
			if (Date.now() >= deadline) {
				finish(null);
				return;
			}
			try {
				const { job } = await api.job(jobId);
				if (settled) return;
				onProgress?.(job);
				if (job.status === "done" || job.status === "error") {
					finish(job);
					return;
				}
			} catch (err) {
				fail(err);
				return;
			}
			const nextDelay = jobEvents.isConnected() ? Math.max(intervalMs, 5000) : intervalMs;
			timer = setTimeout(poll, nextDelay);
		};

		// Wait one short beat for an instant WS push or check immediately when offline/unconnected.
		timer = setTimeout(poll, jobEvents.isConnected() ? 1500 : 250);
	});
}

export function segmentCropUrl(segmentId: string): string {
	return `/api/segments/${encodeURIComponent(segmentId)}/crop`;
}

export function segmentMaskUrl(segmentId: string): string {
	return `/api/segments/${encodeURIComponent(segmentId)}/mask`;
}

/** Upload one file through the Worker (multipart). */
export async function uploadFile(albumId: string, file: File): Promise<{ image: ImageDto; segmentJobId: string | null }> {
	const form = new FormData();
	form.append("file", file);
	const res = await fetch(`/api/albums/${encodeURIComponent(albumId)}/upload`, { method: "POST", body: form });
	await throwIfNotOk(res);
	return res.json();
}
