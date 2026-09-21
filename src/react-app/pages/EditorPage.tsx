import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { api, fileUrl, type ImageDto } from "../lib/api";
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

	// Fresh state per photo (the old editor leaked zoom/selection across routes).
	useEffect(() => {
		editorStore.set({ tool: "region", selectedIds: [], hoveredId: null });
	}, [imageId]);

	const [versions, setVersions] = useState<Array<{ id: string; label: string; parentVersionId: string | null }>>([]);

	const loadAll = useCallback(async () => {
		if (!albumId || !imageId) return;
		const { image: img, versions: vers } = await api.image(imageId);
		setImage(img);
		setVersions(vers);
		try {
			const f = await api.branchFamily(imageId);
			setFamily(f.images);
		} catch {
			setFamily([]);
		}
		const r = await api.albums();
		setAlbumTitle(r.albums.find((a) => a.id === albumId)?.title ?? "Album");
	}, [albumId, imageId]);

	useEffect(() => {
		loadAll();
	}, [loadAll]);

	async function download() {
		if (!image) return;
		const res = await fetch(fileUrl(image.id, "original"));
		const blob = await res.blob();
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = image.filenameLabel || "editorium";
		a.click();
		URL.revokeObjectURL(a.href);
	}

	async function share() {
		if (!image) return;
		const { url } = await api.share(image.id);
		const full = `${location.origin}${url}`;
		await navigator.clipboard?.writeText(full).catch(() => undefined);
		alert(`Share link copied:\n${full}`);
	}

	/** Region edit: draw a rect, describe the change, apply to that region. */
	async function regionEdit(rect: { x: number; y: number; w: number; h: number }, text: string) {
		if (!image || !albumId || applying) return;
		setApplying("Applying region edit…");
		try {
			await api.createInstruction(image.id, { text, bbox: rect });
			const { jobId } = await api.applyInstructions(image.id);
			for (let i = 0; i < 60; i++) {
				const { job } = await api.job(jobId);
				if (job.status === "done") {
					if (job.resultImageId) {
						navigate(`/albums/${albumId}/images/${job.resultImageId}`);
					}
					break;
				}
				if (job.status === "error") {
					setApplying("Edit failed: " + (job.error ?? "unknown error"));
					await new Promise((r) => setTimeout(r, 4000));
					break;
				}
				await new Promise((r) => setTimeout(r, 1500));
			}
		} catch (err) {
			setApplying("Edit failed: " + (err instanceof Error ? err.message : String(err)));
			await new Promise((r) => setTimeout(r, 4000));
		}
		setApplying(null);
	}

	/** Deterministic pixel presets (B&W, golden hour): perfect composition,
	 * instant, free — no AI model needed for color transforms. Creates a
	 * branched photo like every other edit. */
	async function applyFilter(kind: "bw" | "golden", label: string) {
		if (!image || !albumId || applying) return;
		setApplying(label + "…");
		try {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.src = fileUrl(image.id, "original", image.currentVersionId ?? undefined);
			await new Promise((res, rej) => {
				img.onload = res;
				img.onerror = () => rej(new Error("Could not load photo"));
			});
			const canvas = document.createElement("canvas");
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Canvas unavailable");
			ctx.drawImage(img, 0, 0);
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
				canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"),
			);
			const { imageId: newId } = await api.filterBranch(image.id, label, blob);
			navigate(`/albums/${albumId}/images/${newId}`);
		} catch (err) {
			setApplying("Filter failed: " + (err instanceof Error ? err.message : String(err)));
			await new Promise((r) => setTimeout(r, 4000));
		}
		setApplying(null);
	}

	/** The core loop: words → whole-photo edit → branched photo. */
	async function sendEdit(text: string) {
		if (!image || !albumId || applying) return;
		setApplying("Editing your photo…");
		try {
			const { jobId } = await api.editImage(image.id, text);
			for (let i = 0; i < 60; i++) {
				const { job } = await api.job(jobId);
				if (job.status === "done") {
					if (job.resultImageId) {
						navigate(`/albums/${albumId}/images/${job.resultImageId}`);
					}
					break;
				}
				if (job.status === "error") {
					setApplying("Edit failed: " + (job.error ?? "unknown error"));
					await new Promise((r) => setTimeout(r, 4000));
					break;
				}
				await new Promise((r) => setTimeout(r, 1500));
			}
		} catch (err) {
			setApplying("Edit failed: " + (err instanceof Error ? err.message : String(err)));
			await new Promise((r) => setTimeout(r, 4000));
		}
		setApplying(null);
	}

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
						<p>Describe any change and press send — you'll get a new photo beside the original. The original never changes.</p>
						<p className="mt-3 text-xs">Try: “make the wall white” · “turn the jacket into a denim jacket” · “make it look like golden hour”</p>
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
								onClick={() => sendEdit("enhance this photo: increase sharpness, clarity and detail, professional camera quality")}
								className="rounded-full border ed-hairline bg-secondary px-3 py-1.5 text-xs transition hover:bg-muted disabled:opacity-40"
							>
								✦ Enhance (AI)
							</button>
							<button
								disabled={applying !== null}
								onClick={() => sendEdit("remove the background completely, replace it with a clean white studio backdrop, keep the subject unchanged")}
								className="rounded-full border ed-hairline bg-secondary px-3 py-1.5 text-xs transition hover:bg-muted disabled:opacity-40"
							>
								Remove background (AI)
							</button>
						</div>
						{versions.length > 1 && (
							<select
								aria-label="Version history"
								value={image?.currentVersionId ?? ""}
								onChange={async (e) => {
									if (!image) return;
									await api.activateVersion(image.id, e.target.value);
									loadAll();
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
						{applying && (
							<div className="flex items-center gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-xs text-foreground" role="status">
								<span className="size-3 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
								{applying}
							</div>
						)}
						<AskComposer onSend={sendEdit} disabled={applying !== null} placeholder="Describe a change…" />
					</div>
				</aside>
			</div>
		</div>
	);
}
