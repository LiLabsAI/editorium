import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { api, fileUrl, type AlbumSummary, type Me } from "../lib/api";
import { TopBar } from "../components/TopBar";

/** Dashboard (Screen A): workspace hero, Albums/References tabs, sort/filter/
 * search controls, card grid with the "New album" placeholder card. */
export function Dashboard({ me }: { me: Me | null }) {
	const navigate = useNavigate();
	const [tab, setTab] = useState<"albums" | "references">("albums");
	const [sort, setSort] = useState("newest");
	const [query, setQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const [albums, setAlbums] = useState<AlbumSummary[]>([]);
	const [projectName, setProjectName] = useState("Project");
	const [creating, setCreating] = useState(false);

	useEffect(() => {
		api.albums(query || undefined, sort).then((res) => {
			setAlbums(res.albums);
			setProjectName(res.project.name);
		});
	}, [query, sort]);

	async function createAlbum() {
		setCreating(true);
		try {
			const { album } = await api.createAlbum();
			navigate(`/albums/${album.id}`);
		} finally {
			setCreating(false);
		}
	}

	const initial = useMemo(() => (projectName || "P")[0].toUpperCase(), [projectName]);

	return (
		<div className="flex min-h-screen flex-col">
			<TopBar projectName={projectName} />
			<main className="mx-auto w-full max-w-6xl flex-1 px-6">
				<section className="flex items-center gap-5 py-10">
					{/* credits chip surfaces the SaaS metering (plan 13) */}
					<div
						aria-hidden
						className="flex size-20 items-center justify-center rounded-2xl text-3xl font-medium text-white"
						style={{
							background:
								"linear-gradient(135deg, oklch(0.55 0.05 80), oklch(0.35 0.03 240))",
						}}
					>
						{initial}
					</div>
					<div>
						{me?.user && (
							<p className="mb-1 text-xs text-muted-foreground">
								{me.user.plan} plan · {me.user.credits} credits
							</p>
						)}
						<h1 className="flex items-center gap-1.5 text-3xl font-semibold tracking-tight">
							{projectName}
							<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="text-muted-foreground">
								<path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
							</svg>
						</h1>
					</div>
				</section>

				<div className="flex items-center justify-between border-b ed-hairline pb-3">
					<nav className="flex items-center gap-6" aria-label="Library sections">
						<button
							onClick={() => setTab("albums")}
							className={`text-lg ${tab === "albums" ? "font-semibold text-foreground" : "text-muted-foreground"}`}
							aria-current={tab === "albums"}
						>
							Albums
						</button>
						<button
							onClick={() => setTab("references")}
							className={`text-lg ${tab === "references" ? "font-semibold text-foreground" : "text-muted-foreground"}`}
							aria-current={tab === "references"}
						>
							References
						</button>
					</nav>
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
						<select
							aria-label="Filter"
							defaultValue="all"
							className="rounded-lg bg-transparent px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
						>
							<option value="all">All</option>
						</select>
						<button
							aria-label="Search"
							onClick={() => setSearchOpen((v) => !v)}
							className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
						>
							<SearchIcon />
						</button>
					</div>
				</div>
				{searchOpen && (
					<input
						autoFocus
						placeholder="Search albums"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="mt-3 w-full rounded-xl border ed-hairline bg-card px-3 py-2 text-sm outline-none focus:border-ring"
					/>
				)}

				{tab === "albums" ? (
					<section className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-6 py-6">
						<button
							onClick={createAlbum}
							disabled={creating}
							className="group text-left"
						>
							<div className="flex aspect-square items-center justify-center rounded-lg bg-secondary transition group-hover:bg-muted">
								<span className="text-3xl text-muted-foreground">+</span>
							</div>
							<p className="mt-2 text-sm font-medium">New album</p>
							<p className="text-sm text-muted-foreground">Create images and videos</p>
						</button>
						{albums.map((album) => (
							<button
								key={album.id}
								onClick={() => navigate(`/albums/${album.id}`)}
								className="group text-left"
							>
								<div className="aspect-square overflow-hidden rounded-lg bg-secondary">
									{album.coverImageId ? (
										<img
											src={fileUrl(album.coverImageId, "thumb")}
											alt={album.title}
											loading="lazy"
											className="size-full object-cover transition group-hover:scale-[1.02]"
										/>
									) : null}
								</div>
								<p className="mt-2 truncate text-sm font-medium">{album.title}</p>
								<p className="text-sm text-muted-foreground">
									{album.imageCount} image{album.imageCount === 1 ? "" : "s"} ·{" "}
									{relative(album.createdAt)}
								</p>
							</button>
						))}
					</section>
				) : (
					<section className="py-16 text-center text-sm text-muted-foreground">
						Reference images you attach for consistent generations will appear here.
					</section>
				)}
			</main>
		</div>
	);
}

function relative(date: string): string {
	const days = Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);
	if (days < 1) return "today";
	if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
	return `${Math.floor(months / 12)} yr ago`;
}

function SearchIcon() {
	return (
		<svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
			<circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
			<path d="M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
		</svg>
	);
}
