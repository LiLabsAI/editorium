import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
	api,
	describeError,
	fileUrl,
	referenceFileUrl,
	type AlbumSummary,
	type Me,
	type ReferenceDto,
} from "../lib/api";
import { pluralize } from "../lib/history";
import { TopBar } from "../components/TopBar";

/** Dashboard (Screen A): workspace hero, Albums & References tabs, sort/search,
 * album management (create, rename, delete), and project-wide style references. */
export function Dashboard({ me }: { me: Me | null; onRefreshMe?: () => void }) {
	const navigate = useNavigate();
	const [tab, setTab] = useState<"albums" | "references">("albums");
	const [sort, setSort] = useState("newest");
	const [query, setQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const [albums, setAlbums] = useState<AlbumSummary[]>([]);
	const [references, setReferences] = useState<ReferenceDto[]>([]);
	const [projectName, setProjectName] = useState(me?.project?.name ?? "Project");
	const [creating, setCreating] = useState(false);
	const [uploadingRef, setUploadingRef] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState("");
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refInput = useRef<HTMLInputElement>(null);

	useEffect(() => {
		let stale = false;
		const timer = window.setTimeout(() => {
			api
				.albums(query || undefined, sort)
				.then((res) => {
					if (stale) return;
					setAlbums(res.albums);
					setProjectName(res.project.name);
					setError(null);
				})
				.catch((err) => !stale && setError(describeError(err)));
		}, query ? 250 : 0);
		return () => {
			stale = true;
			window.clearTimeout(timer);
		};
	}, [query, sort]);

	const loadReferences = useCallback(async () => {
		try {
			const res = await api.references();
			setReferences(res.references);
		} catch (err) {
			setError(describeError(err));
		}
	}, []);

	useEffect(() => {
		if (tab === "references") void loadReferences();
	}, [tab, loadReferences]);

	async function createAlbum() {
		setCreating(true);
		setError(null);
		try {
			const { album } = await api.createAlbum();
			navigate(`/albums/${album.id}`);
		} catch (err) {
			setError(describeError(err));
		} finally {
			setCreating(false);
		}
	}

	async function commitRename(albumId: string) {
		const trimmed = editingTitle.trim();
		setEditingId(null);
		if (!trimmed) return;
		try {
			await api.renameAlbum(albumId, trimmed);
			setAlbums((list) => list.map((a) => (a.id === albumId ? { ...a, title: trimmed } : a)));
		} catch (err) {
			setError(describeError(err));
		}
	}

	async function confirmDelete(albumId: string) {
		try {
			await api.deleteAlbum(albumId);
			setAlbums((list) => list.filter((a) => a.id !== albumId));
			setConfirmDeleteId(null);
		} catch (err) {
			setError(describeError(err));
		}
	}

	async function onUploadReferences(files: FileList | null) {
		if (!files?.length) return;
		setUploadingRef(true);
		setError(null);
		try {
			for (const f of Array.from(files)) {
				const { reference } = await api.uploadReference(f);
				setReferences((list) => [reference, ...list]);
			}
		} catch (err) {
			setError(describeError(err));
		} finally {
			setUploadingRef(false);
		}
	}

	async function removeReference(refId: string) {
		try {
			await api.deleteReference(refId);
			setReferences((list) => list.filter((r) => r.id !== refId));
		} catch (err) {
			setError(describeError(err));
		}
	}

	const initial = useMemo(() => (projectName || "P")[0].toUpperCase(), [projectName]);

	return (
		<div className="flex min-h-screen flex-col">
			<TopBar projectName={projectName} me={me} />
			<main className="mx-auto w-full max-w-6xl flex-1 px-6">
				<section className="flex items-center gap-5 py-10">
					<div
						aria-hidden
						className="flex size-20 items-center justify-center rounded-2xl text-3xl font-medium text-white"
						style={{
							background: "linear-gradient(135deg, oklch(0.55 0.05 80), oklch(0.35 0.03 240))",
						}}
					>
						{initial}
					</div>
					<div>
						{me?.user && (
							<p className="mb-1 text-xs text-muted-foreground">
								{me.user.plan} plan · {pluralize(me.user.credits, "credit")}
							</p>
						)}
						<h1 className="flex items-center gap-1.5 text-3xl font-semibold tracking-tight">{projectName}</h1>
					</div>
				</section>

				<div className="flex items-center justify-between border-b ed-hairline pb-3">
					<nav className="flex items-center gap-6" aria-label="Library sections">
						<button
							type="button"
							onClick={() => setTab("albums")}
							className={`text-lg ${tab === "albums" ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"}`}
							aria-current={tab === "albums" ? "page" : undefined}
						>
							Albums
						</button>
						<button
							type="button"
							onClick={() => setTab("references")}
							className={`text-lg ${tab === "references" ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"}`}
							aria-current={tab === "references" ? "page" : undefined}
						>
							References
						</button>
					</nav>
					{tab === "albums" ? (
						<div className="flex items-center gap-2">
							<select
								aria-label="Sort albums"
								value={sort}
								onChange={(e) => setSort(e.target.value)}
								className="rounded-lg bg-transparent px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
							>
								<option value="newest">By newest</option>
								<option value="oldest">By oldest</option>
								<option value="name">By name</option>
							</select>
							<button
								type="button"
								aria-label="Search albums"
								onClick={() => {
									setSearchOpen((v) => {
										if (v) setQuery("");
										return !v;
									});
								}}
								className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								<SearchIcon />
							</button>
						</div>
					) : (
						<div>
							<button
								type="button"
								disabled={uploadingRef}
								onClick={() => refInput.current?.click()}
								className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-85 disabled:opacity-40"
							>
								{uploadingRef ? "Uploading…" : "Add reference"}
							</button>
							<input
								ref={refInput}
								type="file"
								accept="image/png,image/jpeg,image/webp,image/gif"
								multiple
								hidden
								onChange={(e) => {
									void onUploadReferences(e.target.files);
									e.target.value = "";
								}}
							/>
						</div>
					)}
				</div>

				{tab === "albums" && searchOpen && (
					<div className="relative mt-3">
						<input
							autoFocus
							placeholder="Search albums"
							aria-label="Search albums"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							className="w-full rounded-xl border ed-hairline bg-card px-3 py-2 pr-8 text-sm outline-none focus:border-ring"
						/>
						{query && (
							<button
								type="button"
								aria-label="Clear search"
								onClick={() => setQuery("")}
								className="absolute right-2.5 top-2 text-sm text-muted-foreground hover:text-foreground"
							>
								×
							</button>
						)}
					</div>
				)}

				{error && (
					<p role="alert" className="mt-3 text-sm text-red-300">
						{error}
					</p>
				)}

				{tab === "albums" ? (
					<section className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-6 py-6">
						<button type="button" onClick={createAlbum} disabled={creating} className="group text-left">
							<div className="flex aspect-square items-center justify-center rounded-lg bg-secondary transition group-hover:bg-muted">
								<span className="text-3xl text-muted-foreground">+</span>
							</div>
							<p className="mt-2 text-sm font-medium">New album</p>
							<p className="text-sm text-muted-foreground">Upload or generate photos</p>
						</button>
						{albums.map((album) => (
							<div key={album.id} className="group relative">
								<button
									type="button"
									onClick={() => navigate(`/albums/${album.id}`)}
									className="block w-full text-left"
								>
									<div className="aspect-square overflow-hidden rounded-lg bg-secondary">
										{album.coverImageId ? (
											<img
												src={fileUrl(album.coverImageId, "thumb")}
												alt={album.title}
												loading="lazy"
												className="size-full object-cover transition group-hover:scale-[1.02]"
											/>
										) : (
											<div className="flex size-full items-center justify-center text-xs text-muted-foreground">
												Empty album
											</div>
										)}
									</div>
								</button>

								<div className="mt-2 flex items-start justify-between gap-2">
									<div className="min-w-0 flex-1">
										{editingId === album.id ? (
											<input
												autoFocus
												value={editingTitle}
												aria-label="Album title"
												onChange={(e) => setEditingTitle(e.target.value)}
												onBlur={() => void commitRename(album.id)}
												onKeyDown={(e) => {
													if (e.key === "Enter") void commitRename(album.id);
													if (e.key === "Escape") setEditingId(null);
												}}
												className="w-full rounded border ed-hairline bg-card px-1.5 py-0.5 text-sm outline-none focus:border-ring"
											/>
										) : (
											<p
												className="truncate text-sm font-medium"
												onDoubleClick={() => {
													setEditingId(album.id);
													setEditingTitle(album.title);
												}}
											>
												{album.title}
											</p>
										)}
										<p className="text-sm text-muted-foreground">
											{pluralize(album.imageCount, "image")} · {relative(album.createdAt)}
										</p>
									</div>

									{confirmDeleteId === album.id ? (
										<div className="flex items-center gap-1 text-xs">
											<button
												type="button"
												onClick={() => void confirmDelete(album.id)}
												className="rounded bg-red-500/80 px-1.5 py-0.5 text-white"
											>
												Delete
											</button>
											<button
												type="button"
												onClick={() => setConfirmDeleteId(null)}
												className="rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
											>
												Cancel
											</button>
										</div>
									) : (
										<div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
											<button
												type="button"
												title="Rename album"
												aria-label={`Rename ${album.title}`}
												onClick={() => {
													setEditingId(album.id);
													setEditingTitle(album.title);
												}}
												className="rounded p-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
											>
												✎
											</button>
											<button
												type="button"
												title="Delete album"
												aria-label={`Delete ${album.title}`}
												onClick={() => setConfirmDeleteId(album.id)}
												className="rounded p-1 text-xs text-muted-foreground hover:bg-muted hover:text-red-300"
											>
												✕
											</button>
										</div>
									)}
								</div>
							</div>
						))}
					</section>
				) : (
					<section className="py-6">
						{references.length === 0 ? (
							<div className="py-16 text-center">
								<p className="text-sm text-muted-foreground">
									Upload style, subject, or product reference photos here and attach up to 3 in edits or chat.
								</p>
								<button
									type="button"
									onClick={() => refInput.current?.click()}
									className="mt-4 rounded-full border ed-hairline px-4 py-1.5 text-sm transition hover:bg-muted"
								>
									Upload reference photo
								</button>
							</div>
						) : (
							<div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-5">
								{references.map((ref) => (
									<div key={ref.id} className="group relative">
										<div className="aspect-square overflow-hidden rounded-lg bg-secondary">
											<img
												src={referenceFileUrl(ref.id, "thumb")}
												alt={ref.title}
												loading="lazy"
												className="size-full object-cover"
											/>
										</div>
										<div className="mt-2 flex items-center justify-between gap-2">
											<div className="min-w-0">
												<p className="truncate text-sm font-medium">{ref.title}</p>
												<p className="text-xs text-muted-foreground">
													{ref.widthPx} × {ref.heightPx}
												</p>
											</div>
											<button
												type="button"
												aria-label={`Delete reference ${ref.title}`}
												onClick={() => void removeReference(ref.id)}
												className="rounded p-1 text-xs text-muted-foreground opacity-0 transition hover:bg-muted hover:text-red-300 group-hover:opacity-100 group-focus-within:opacity-100"
											>
												✕
											</button>
										</div>
									</div>
								))}
							</div>
						)}
					</section>
				)}
			</main>
		</div>
	);
}

function relative(date: string): string {
	const ts = new Date(date).getTime();
	if (!Number.isFinite(ts)) return "recently";
	const days = Math.max(0, Math.floor((Date.now() - ts) / 86_400_000));
	if (days < 1) return "today";
	if (days < 30) return `${pluralize(days, "day")} ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${pluralize(months, "month")} ago`;
	return `${pluralize(Math.floor(months / 12), "yr")} ago`;
}

function SearchIcon() {
	return (
		<svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
			<circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
			<path d="M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
		</svg>
	);
}
