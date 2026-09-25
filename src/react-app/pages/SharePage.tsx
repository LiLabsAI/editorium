import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { api, shareFileUrl } from "../lib/api";
import { LogoMark } from "../components/TopBar";

/** Public share viewer (no session): image + "Made with Editorium" + download.
 * Everything is addressed by the share token, so revoking the link or turning
 * off downloads takes effect on the server, not just in this UI. */
export function SharePage() {
	const { token } = useParams<{ token: string }>();
	const [state, setState] = useState<
		{ status: "loading" } | { status: "gone" } | { status: "ready"; allowDownload: boolean; title: string }
	>({ status: "loading" });

	useEffect(() => {
		if (!token) return;
		api
			.publicShare(token)
			.then((res) => setState({ status: "ready", allowDownload: res.share.allowDownload, title: res.share.title }))
			.catch(() => setState({ status: "gone" }));
	}, [token]);

	if (state.status === "loading") {
		return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading…</div>;
	}
	if (state.status === "gone" || !token) {
		return (
			<div className="flex h-screen flex-col items-center justify-center gap-3">
				<LogoMark />
				<p className="text-muted-foreground">This link has expired or was revoked.</p>
				<Link to="/" className="text-sm underline">
					Open Editorium
				</Link>
			</div>
		);
	}

	return (
		<div className="flex h-screen flex-col ed-canvas-bg">
			<header className="flex h-12 items-center justify-between border-b ed-hairline px-4">
				<Link to="/" className="flex items-center gap-2 text-sm">
					<LogoMark />
					<span className="font-medium">Editorium</span>
				</Link>
				{state.allowDownload && (
					// Server sends Content-Disposition: attachment for the original.
					<a
						href={shareFileUrl(token, "original")}
						className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background"
					>
						Download
					</a>
				)}
			</header>
			<main className="flex flex-1 items-center justify-center p-8">
				<img
					src={shareFileUrl(token, "web")}
					alt={state.title || "Shared image"}
					className="max-h-full max-w-full rounded-lg shadow-2xl"
				/>
			</main>
			<footer className="pb-4 text-center text-xs text-muted-foreground">
				Made with Editorium — recognize, prompt, and edit every part of a photo.
			</footer>
		</div>
	);
}
