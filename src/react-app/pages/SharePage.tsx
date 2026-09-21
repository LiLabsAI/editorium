import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { api, fileUrl } from "../lib/api";
import { LogoMark } from "../components/TopBar";

/** Public share viewer (no auth): image + "Made with Editorium" + download. */
export function SharePage() {
	const { token } = useParams<{ token: string }>();
	const [state, setState] = useState<
		{ status: "loading" } | { status: "gone" } | { status: "ready"; imageId: string; allowDownload: boolean }
	>({ status: "loading" });

	useEffect(() => {
		if (!token) return;
		api.publicShare(token).then((res) => {
			if (res.share.imageId) {
				setState({ status: "ready", imageId: res.share.imageId, allowDownload: res.share.allowDownload });
			} else {
				setState({ status: "gone" });
			}
		}).catch(() => setState({ status: "gone" }));
	}, [token]);

	if (state.status === "loading") {
		return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading…</div>;
	}
	if (state.status === "gone") {
		return (
			<div className="flex h-screen flex-col items-center justify-center gap-3">
				<LogoMark />
				<p className="text-muted-foreground">This link has expired or was revoked.</p>
				<Link to="/" className="text-sm underline">Open Editorium</Link>
			</div>
		);
	}

	async function download() {
		const res = await fetch(`/api/public/images/${state.status === "ready" ? state.imageId : ""}`);
		const blob = await res.blob();
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = "editorium-image";
		a.click();
		URL.revokeObjectURL(a.href);
	}

	return (
		<div className="flex h-screen flex-col ed-canvas-bg">
			<header className="flex h-12 items-center justify-between border-b ed-hairline px-4">
				<Link to="/" className="flex items-center gap-2 text-sm">
					<LogoMark />
					<span className="font-medium">Editorium</span>
				</Link>
				{state.allowDownload && (
					<button onClick={download} className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background">
						Download
					</button>
				)}
			</header>
			<main className="flex flex-1 items-center justify-center p-8">
				<img
					src={state.status === "ready" ? fileUrl(state.imageId, "web") : ""}
					alt="Shared image"
					className="max-h-full max-w-full rounded-lg shadow-2xl"
				/>
			</main>
			<footer className="pb-4 text-center text-xs text-muted-foreground">
				Made with Editorium — recognize, prompt, and edit every part of a photo.
			</footer>
		</div>
	);
}
