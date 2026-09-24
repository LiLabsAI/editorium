import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { api, describeError, fileUrl, waitForJob, type ImageDto, type VersionDto } from "../lib/api";
import { editorStore } from "../lib/store";
import { TopBar } from "../components/TopBar";
import { AskComposer } from "../components/Composer";
import { EditorCanvas } from "../editor/Canvas";

/** The editor: one photo, one bar, every edit is a branch.
 * Left rail = branch filmstrip. Center = the photo. Right rail = the chat bar. */
export function EditorPage({ projectName }: { projectName: string }) {
	const { albumId, imageId } = useParams<{ albumId: string; imageId: string }>();
	const navigate = useNavigate();
	const [albumTitle, setAlbumTitle] = useState("Album");
	const [image, setImage] = useState<ImageDto | null>(null);
	const [family, setFamily] = useState<ImageDto[]>([]);
	const [applying, setApplying] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	// Fresh state per photo (the old editor leaked zoom/selection across routes).
	useEffect(() => {
		editorStore.set({ tool: "region", selectedIds: [], hoveredId: null });
	}, [imageId]);

	const [versions, setVersions] = useState<VersionDto[]>([]);

	const loadAll = useCallback(async () => {
		if (!albumId || !imageId) return;
		const { image: img, album, versions: vers } = await api.image(imageId);
		setImage(img);
		setAlbumTitle(album.title);
		setVersions(vers);
		try {
			const f = await api.branchFamily(imageId);
			setFamily(f.images);
		} catch {
			setFamily([]);
		}
	}, [albumId, imageId]);

	useEffect(() => {
		loadAll().catch((err) => setNotice(describeError(err)));
	}, [loadAll]);

	async function download() {
		if (!image) return;
		const res = await fetch(fileUrl(image.id, "original", image.currentVersionId ?? undefined));
		if (!res.ok) {
			setNotice("Download failed. Please try again.");
			return;
		}
		const blob = await res.blob();
		const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${image.filenameLabel.replace(/\.[a-z0-9]+$/i, "") || "editorium"}.${ext}`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	async function share() {
		if (!image) return;
		try {
			const { url } = await api.share(image.id);
			const full = `${location.origin}${url}`;
			const copied = await navigator.clipboard?.writeText(full).then(
				() => true,
				() => false,
			);
			setNotice(copied ? `Share link copied: ${full}` : `Share link: ${full}`);
		} catch (err) {
			setNotice(`Couldn't create a share link: ${describeError(err)}`);
		}
	}

	/** Follow a job to its branched photo; report failure or a slow job. */
	async function followJob(jobId: string, what: string) {
		const job = await waitForJob(jobId);
		if (!job) {
			setNotice(`${what} is taking longer than usual — the new photo will appear in the strip when it's done.`);
		} else if (job.status === "error") {
			setNotice(`${what} failed. Your credits were refunded.`);
		} else if (job.resultImageId) {
			navigate(`/albums/${albumId}/images/${job.resultImageId}`);
		}
	}

	/** Region edit: draw a rect, describe the change, apply to that region. */
	async function regionEdit(rect: { x: number; y: number; w: number; h: number }, text: string) {
		if (!image || !albumId || applying) return;
		setApplying("Applying region edit…");
		setNotice(null);
		try {
			const { instruction } = await api.createInstruction(image.id, { text, bbox: rect });
			// Apply only THIS chip, never stale ones from an earlier attempt.
			const { jobId } = await api.applyInstructions(image.id, [instruction.id]);
			await followJob(jobId, "The region edit");
		} catch (err) {
			setNotice(`Edit failed: ${describeError(err)}`);
		}
		setApplying(null);
	}

	/** Deterministic pixel presets (B&W, golden hour): perfect composition,
	 * instant, free — no AI model needed for color transforms. Creates a
	 * branched photo like every other edit. */
	async function applyFilter(kind: "bw" | "golden", label: string) {
		if (!image || !albumId || applying) return;
		setApplying(label + "…");
		setNotice(null);
		try {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.src = fileUrl(image.id, "original", image.currentVersionId ?? undefined);
			await new Promise((res, rej) => {
				img.onload = res;
				img.onerror = () => rej(new Error("Could not load photo"));
			});
			// Cap at ~24 MP so huge photos neither exhaust memory nor exceed
			// the 25 MB upload limit once re-encoded.
			const scale = Math.min(1, Math.sqrt(24_000_000 / (img.naturalWidth * img.naturalHeight)));
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(img.naturalWidth * scale);
			canvas.height = Math.round(img.naturalHeight * scale);
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Canvas unavailable");
			ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
			const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
			const px = data.data;
			for (let i = 0; i < px.length; i += 4) {
				const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
				if (kind === "bw") {
					const l = 0.299 * r + 0.587 * g + 0.114 * b;
					px[i] = px[i + 1] = px[i + 2] = l;
				} else {
					// golden hour: warm shift + gentle lift
					px[i] = Math.min(255, r * 1.12 + 12);
					px[i + 1] = Math.min(255, g * 1.02 + 6);
					px[i + 2] = b * 0.86;
				}
			}
			ctx.putImageData(data, 0, 0);
			const blob = await new Promise<Blob>((res, rej) =>
				canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/jpeg", 0.92),
			);
			const { imageId: newId } = await api.filterBranch(image.id, label, blob);
			navigate(`/albums/${albumId}/images/${newId}`);
		} catch (err) {
			setNotice(`${label} failed: ${describeError(err)}`);
		}
		setApplying(null);
	}

	/** Run one queued operation and follow it to the new photo. */
	async function runOperation(status: string, what: string, start: () => Promise<{ jobId: string }>) {
		if (!image || !albumId || applying) return;
		setApplying(status);
		setNotice(null);
		try {
			const { jobId } = await start();
			await followJob(jobId, what);
		} catch (err) {
			setNotice(`${what} failed: ${describeError(err)}`);
		}
		setApplying(null);
	}

	/** Free-text change → Reimagine (whole-photo AI edit, may alter details). */
	const sendEdit = (text: string) =>
		runOperation("Reimagining your photo…", "The edit", () => api.editImage(image!.id, text));
	/** ESRGAN upscale + sharpen: same photo, more detail. */
	const enhance = () => runOperation("Enhancing…", "Enhance", () => api.enhanceImage(image!.id));
	/** Segmentation: subject kept pixel-for-pixel, background removed. */
	const removeBackground = () =>
		runOperation("Removing background…", "Background removal", () => api.removeBackground(image!.id));

	const currentVersion = versions.find((v) => v.id === image?.currentVersionId) ?? versions[versions.length - 1];

	return (
		<div className="flex h-screen flex-col">
			<TopBar
				projectName={projectName}
				crumbs={[{ label: albumTitle, to: albumId ? `/albums/${albumId}` : undefined }, { label: image?.filenameLabel ?? "…" }]}
				actions={
					image && (
						<>
							<button onClick={download} className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground">
								Download
							</button>
							<button onClick={share} className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-85">
								Share
							</button>
						</>
					)
				}
			/>
			<div className="flex min-h-0 flex-1">
				{/* Branch filmstrip: every edit becomes a photo beside the original */}
				<aside className="ed-panel flex w-16 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r ed-hairline py-3">
					{family.map((img) => {
						const active = img.id === imageId;
						return (
							<button
								key={img.id}
								title={img.filenameLabel}
								onClick={() => albumId && navigate(`/albums/${albumId}/images/${img.id}`)}
								className={`overflow-hidden rounded-lg border-2 transition ${
									active ? "border-[rgba(99,120,255,0.95)]" : "border-transparent opacity-70 hover:opacity-100"
								}`}
							>
								<img
									src={fileUrl(img.id, "thumb", img.currentVersionId ?? undefined)}
									alt={img.filenameLabel}
									loading="lazy"
									className="size-11 object-cover"
								/>
							</button>
						);
					})}
				</aside>

				{image ? (
					<EditorCanvas
						image={image}
						onRegionEdit={regionEdit}
						sourceUrl={
							image.sourceImageId
								? fileUrl(
										image.sourceImageId,
										"web",
										family.find((f) => f.id === image.sourceImageId)?.currentVersionId ?? undefined,
									)
								: undefined
						}
					/>
				) : (
					<div className="ed-canvas-bg flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
						Loading…
					</div>
				)}

				{/* The chat bar: the only control surface */}
				<aside className="ed-panel flex w-[340px] shrink-0 flex-col border-l ed-hairline">
					<div className="flex items-center justify-between px-4 pb-2 pt-4">
						<h2 className="text-sm font-semibold">Edit with words</h2>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-4 text-sm leading-relaxed text-muted-foreground">
						<p>Every result is a new photo beside the original. The original never changes.</p>
						<ul className="mt-3 space-y-1.5 text-xs">
							<li>
								<span className="text-foreground">Drag a box</span> on the photo to change just that area — everything outside it stays pixel-for-pixel.
							</li>
							<li>
								<span className="text-foreground">Enhance</span> and <span className="text-foreground">Remove background</span> keep the photo as it is.
							</li>
							<li>
								<span className="text-foreground">Describe a change</span> below to reimagine the whole photo — AI may alter other details.
							</li>
						</ul>
						{currentVersion?.opClass && (
							<p className="mt-4 rounded-lg bg-secondary/60 px-3 py-2 text-xs" title={currentVersion.model ?? undefined}>
								This photo: {OP_CLASS_LABEL[currentVersion.opClass] ?? currentVersion.opClass}
								{currentVersion.fidelity !== null && ` · fidelity ${currentVersion.fidelity.toFixed(2)}`}
							</p>
						)}
					</div>
					<div className="space-y-2 p-4 pt-0">
						<div className="flex flex-wrap gap-1.5">
							<button
								disabled={applying !== null}
								onClick={() => applyFilter("bw", "Black & white")}
								className="rounded-full border ed-hairline bg-secondary px-3 py-1.5 text-xs transition hover:bg-muted disabled:opacity-40"
							>
								Black & white
							</button>
							<button
								disabled={applying !== null}
								onClick={() => applyFilter("golden", "Golden hour")}
								className="rounded-full border ed-hairline bg-secondary px-3 py-1.5 text-xs transition hover:bg-muted disabled:opacity-40"
							>
								Golden hour
							</button>
							<button
								disabled={applying !== null}
								onClick={enhance}
								title="AI upscale + sharpen. Keeps the photo exactly as it is."
								className="rounded-full border ed-hairline bg-secondary px-3 py-1.5 text-xs transition hover:bg-muted disabled:opacity-40"
							>
								✦ Enhance (AI)
							</button>
							<button
								disabled={applying !== null}
								onClick={removeBackground}
								title="Cuts out the subject onto a transparent background. Nothing is repainted."
								className="rounded-full border ed-hairline bg-secondary px-3 py-1.5 text-xs transition hover:bg-muted disabled:opacity-40"
							>
								Remove background
							</button>
						</div>
						{versions.length > 1 && (
							<select
								aria-label="Version history"
								value={image?.currentVersionId ?? ""}
								onChange={async (e) => {
									if (!image) return;
									try {
										await api.activateVersion(image.id, e.target.value);
										await loadAll();
									} catch (err) {
										setNotice(describeError(err));
									}
								}}
								className="w-full rounded-lg border ed-hairline bg-background px-2 py-1.5 text-xs"
							>
								{versions.map((v) => (
									<option key={v.id} value={v.id}>
										{v.label}
									</option>
								))}
							</select>
						)}
						{notice && (
							<p role="alert" className="break-words rounded-lg bg-secondary/60 px-3 py-2 text-xs text-foreground">
								{notice}
							</p>
						)}
						{applying && (
							<div className="flex items-center gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-xs text-foreground" role="status">
								<span className="size-3 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
								{applying}
							</div>
						)}
						<AskComposer onSend={sendEdit} disabled={applying !== null} placeholder="Reimagine: describe a change…" />
					</div>
				</aside>
			</div>
		</div>
	);
}

const OP_CLASS_LABEL: Record<string, string> = {
	adjust: "adjusted (no AI)",
	enhance: "AI-enhanced (same content)",
	segment: "background removed (subject untouched)",
	local: "region edited (outside unchanged)",
	reimagine: "reimagined by AI",
	generate: "generated by AI",
};
