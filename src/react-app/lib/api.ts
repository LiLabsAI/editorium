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
	currentVersionId: string | null;
	filenameLabel: string;
	bookmarkedAt: string | null;
	segmentStatus: "none" | "pending" | "partial" | "ready" | "failed";
	positionIdx: number;
	createdAt: string;
}

export interface VersionDto {
	id: string;
	imageId: string;
	parentVersionId: string | null;
	label: string;
	operation: string | null;
	prompt: string | null;
	/** How this version was produced (phase 4 audit). */
	opClass: "adjust" | "enhance" | "segment" | "local" | "reimagine" | "generate" | null;
	model: string | null;
	fidelity: number | null;
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
		insufficient_credits: "You're out of credits.",
		unauthorized: "Your session expired — reload the page.",
		file_too_large: "That file is larger than 25 MB.",
		not_an_image: "That file isn't a PNG, JPEG, WebP or GIF image.",
		invalid_body: "That request wasn't valid.",
		not_found: "That item no longer exists.",
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
		request<{ album: { id: string; title: string } }>(`/albums/${id}`),
	createAlbum: (title?: string) =>
		request<{ album: { id: string; title: string } }>("/albums", {
			method: "POST",
			body: JSON.stringify({ title }),
		}),
	renameAlbum: (id: string, title: string) =>
		request<{ album: unknown }>(`/albums/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ title }),
		}),
	deleteAlbum: (id: string) => request<{ ok: boolean }>(`/albums/${id}`, { method: "DELETE" }),

	albumImages: (albumId: string, filter = "all") =>
		request<{ images: ImageDto[] }>(`/albums/${albumId}/images?filter=${filter}`),
	albumThreads: (albumId: string) =>
		request<{ threads: ThreadDto[] }>(`/albums/${albumId}/threads`),
	createThread: (albumId: string) =>
		request<{ thread: ThreadDto }>(`/albums/${albumId}/threads`, { method: "POST" }),
	threadMessages: (threadId: string) =>
		request<{ messages: MessageDto[] }>(`/threads/${threadId}/messages`),
	sendMessage: (
		threadId: string,
		body: {
			text: string;
			attachedImageId?: string;
			segmentId?: string;
			paletteIds?: string[];
		},
	) =>
		fetch(`/api/threads/${threadId}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),

	image: (id: string) =>
		request<{ image: ImageDto; album: { id: string; title: string }; versions: VersionDto[] }>(`/images/${id}`),
	imageVersions: (id: string) =>
		request<{ versions: VersionDto[]; currentId: string | null }>(`/images/${id}/versions`),
	activateVersion: (imageId: string, versionId: string) =>
		request<{ ok: boolean }>(`/images/${imageId}/versions/${versionId}/activate`, { method: "POST" }),
	patchImage: (id: string, body: Partial<Pick<ImageDto, "filenameLabel">> & { bookmarked?: boolean }) =>
		request<{ image: ImageDto }>(`/images/${id}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	deleteImage: (id: string) => request<{ ok: boolean }>(`/images/${id}`, { method: "DELETE" }),

	segments: (imageId: string) =>
		request<{ segments: SegmentDto[]; status: string }>(`/images/${imageId}/segments`),
	resegment: (imageId: string) =>
		request<{ jobId: string }>(`/images/${imageId}/resegment`, { method: "POST" }),
	patchSegment: (
		id: string,
		body: {
			label?: string;
			bbox?: { x: number; y: number; w: number; h: number };
			locked?: boolean;
			hidden?: boolean;
		},
	) => request<{ segment: SegmentDto }>(`/segments/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
	deleteSegment: (id: string) => request<{ ok: boolean }>(`/segments/${id}`, { method: "DELETE" }),
	segmentPrompt: (id: string, text: string) =>
		request<{ prompt: { id: string; text: string } }>(`/segments/${id}/prompts`, {
			method: "POST",
			body: JSON.stringify({ text }),
		}),
	segmentPrompts: (id: string) =>
		request<{ prompts: Array<{ id: string; text: string; isActive: boolean }>; caption: string | null }>(
			`/segments/${id}/prompts`,
		),

	savePalette: (imageId: string, colors: string[], segmentId?: string) =>
		request<{ palette: { id: string } }>(`/images/${imageId}/palette`, {
			method: "POST",
			body: JSON.stringify({ colors, segmentId }),
		}),
	imagePalettes: (imageId: string) =>
		request<{ palettes: PaletteDto[] }>(`/images/${imageId}/palettes`),
	rewritePrompt: (text: string, operation: string, context?: string) =>
		request<{ rewritten: string }>("/prompts/rewrite", {
			method: "POST",
			body: JSON.stringify({ text, operation, context }),
		}),

	job: (id: string) => request<{ job: JobDto }>(`/jobs/${id}`),

	branchFamily: (imageId: string) =>
		request<{ images: ImageDto[] }>(`/images/${imageId}/branch`),
	filterBranch: async (imageId: string, label: string, blob: Blob) => {
		const form = new FormData();
		form.append("file", blob, "filtered.png");
		form.append("label", label);
		const res = await fetch(`/api/images/${imageId}/filter-branch`, { method: "POST", body: form });
		await throwIfNotOk(res);
		return (await res.json()) as { imageId: string; versionId: string };
	},
	editImage: (imageId: string, prompt: string) =>
		request<{ jobId: string }>(`/images/${imageId}/edit`, {
			method: "POST",
			body: JSON.stringify({ prompt }),
		}),
	instructions: (imageId: string) =>
		request<{
			instructions: Array<{
				id: string;
				text: string;
				bboxX: number;
				bboxY: number;
				bboxW: number;
				bboxH: number;
			}>;
		}>(`/images/${imageId}/instructions`),
	createInstruction: (
		imageId: string,
		body: { text: string; bbox: { x: number; y: number; w: number; h: number } },
	) =>
		request<{ instruction: { id: string } }>(`/images/${imageId}/instructions`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	deleteInstruction: (id: string) =>
		request<{ ok: boolean }>(`/instructions/${id}`, { method: "DELETE" }),
	/** Apply pinned instructions; pass ids to apply only those chips. */
	applyInstructions: (imageId: string, instructionIds?: string[]) =>
		request<{ jobId: string; label: string }>(`/images/${imageId}/apply-instructions`, {
			method: "POST",
			body: JSON.stringify({ instructionIds }),
		}),
	editRegion: (imageId: string, segmentId: string, prompt: string) =>
		request<{ jobId: string }>(`/images/${imageId}/edit-region`, {
			method: "POST",
			body: JSON.stringify({ segmentId, prompt }),
		}),
	removeBackground: (imageId: string) =>
		request<{ jobId: string }>(`/images/${imageId}/remove-background`, { method: "POST" }),
	enhanceImage: (imageId: string) =>
		request<{ jobId: string }>(`/images/${imageId}/enhance`, { method: "POST" }),
	duplicateImage: (imageId: string) =>
		request<{ image: ImageDto }>(`/images/${imageId}/duplicate`, { method: "POST" }),
	createSegment: (
		imageId: string,
		polygon: Array<{ x: number; y: number }>,
		label?: string,
	) =>
		request<{ segment: SegmentDto }>(`/images/${imageId}/segments`, {
			method: "POST",
			body: JSON.stringify({ polygon, label }),
		}),
	annotations: (imageId: string) =>
		request<{
			annotations: Array<{
				id: string;
				imageId: string;
				text: string;
				normX: number;
				normY: number;
				fontSize: number;
				color: string;
			}>;
		}>(`/images/${imageId}/annotations`),
	addAnnotation: (imageId: string, body: { text: string; normX: number; normY: number; fontSize?: number }) =>
		request<{ annotation: { id: string } }>(`/images/${imageId}/annotations`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	deleteAnnotation: (id: string) =>
		request<{ ok: boolean }>(`/annotations/${id}`, { method: "DELETE" }),

	share: (imageId: string, allowDownload = true) =>
		request<{ url: string; share: { id: string } }>(`/images/${imageId}/share`, {
			method: "POST",
			body: JSON.stringify({ allowDownload }),
		}),
	publicShare: (token: string) =>
		request<{ share: { allowDownload: boolean; title: string } }>(`/public/share/${token}`),

	usage: () =>
		request<{ balance: number; events: Array<{ reason: string; total: number; credits: number }> }>(
			"/usage",
		),
};

export function fileUrl(
	imageId: string,
	variant: "thumb" | "web" | "original" = "web",
	versionId?: string,
): string {
	const v = versionId ? `&v=${versionId}` : "";
	return `/api/images/${imageId}/file?variant=${variant}${v}`;
}

/** Public share media, addressed by TOKEN (an image id grants nothing). */
export function shareFileUrl(token: string, variant: "web" | "original" = "web"): string {
	return `/api/public/share/${encodeURIComponent(token)}/file?variant=${variant}`;
}

/** Poll a job until it settles. Resolves with the job, or `null` on timeout
 * (the job may still finish later — callers say so instead of going quiet). */
export async function waitForJob(
	jobId: string,
	{ timeoutMs = 120_000, intervalMs = 1500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<JobDto | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { job } = await api.job(jobId);
		if (job.status === "done" || job.status === "error") return job;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return null;
}

export function segmentCropUrl(segmentId: string): string {
	return `/api/segments/${segmentId}/crop`;
}

/** Upload one file through the Worker (multipart). */
export async function uploadFile(albumId: string, file: File): Promise<{ image: ImageDto; segmentJobId: string }> {
	const form = new FormData();
	form.append("file", file);
	const res = await fetch(`/api/albums/${albumId}/upload`, { method: "POST", body: form });
	await throwIfNotOk(res);
	return res.json();
}
