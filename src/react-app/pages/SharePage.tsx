import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { api, shareFileUrl, type ImageAdjustments } from "../lib/api";
import { LogoMark } from "../components/TopBar";

function cssFilterFromAdjustments(json?: string | null): string | undefined {
	if (!json) return undefined;
	try {
		const a = JSON.parse(json) as ImageAdjustments;
		const parts: string[] = [];
		const bright = 1 + (a.exposure ?? 0) * 0.35 + (a.shadows ?? 0) * 0.08 - (a.highlights ?? 0) * 0.05;
		if (Math.abs(bright - 1) > 0.01) parts.push(`brightness(${bright.toFixed(3)})`);
		const contrast = 1 + (a.contrast ?? 0) * 0.6 + (a.clarity ?? 0) * 0.15;
		if (Math.abs(contrast - 1) > 0.01) parts.push(`contrast(${contrast.toFixed(3)})`);
		const sat = 1 + (a.saturation ?? 0) * 0.8 + (a.vibrance ?? 0) * 0.4;
		if (Math.abs(sat - 1) > 0.01) parts.push(`saturate(${Math.max(0, sat).toFixed(3)})`);
		if (a.temperature && a.temperature > 0) parts.push(`sepia(${(a.temperature * 0.3).toFixed(3)})`);
		return parts.length ? parts.join(" ") : undefined;
	} catch {
		return undefined;
	}
}

type ShareViewState =
	| { token: string; status: "gone" }
	| { token: string; status: "ready"; allowDownload: boolean; title: string; adjustmentsJson?: string | null };

/** Public share viewer (no session): image + non-destructive look + download. */
export function SharePage() {
	const { token } = useParams<{ token: string }>();
	const [resolved, setResolved] = useState<ShareViewState | null>(null);
	const [failedToken, setFailedToken] = useState<string | null>(null);

	useEffect(() => {
		if (!token) return;
		let cancelled = false;
		api
			.publicShare(token)
			.then((res) => {
				if (!cancelled) {
					setResolved({
						token,
						status: "ready",
						allowDownload: res.share.allowDownload,
						title: res.share.title,
						adjustmentsJson: res.share.adjustmentsJson,
					});
				}
			})
			.catch(() => {
				if (!cancelled) setResolved({ token, status: "gone" });
			});
		return () => {
			cancelled = true;
		};
	}, [token]);

	if (!token) {
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
	if (!resolved || resolved.token !== token) {
		return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading…</div>;
	}
	if (resolved.status === "gone") {
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

	const imgError = failedToken === token;

	return (
		<div className="flex h-screen flex-col ed-canvas-bg">
			<header className="flex h-12 shrink-0 items-center justify-between border-b ed-hairline px-4">
				<Link to="/" className="flex items-center gap-2 text-sm">
					<LogoMark />
					<span className="font-medium">Editorium</span>
				</Link>
				{resolved.allowDownload && (
					<a
						href={shareFileUrl(token, "original")}
						className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background"
					>
						Download
					</a>
				)}
			</header>
			<main className="flex min-h-0 flex-1 items-center justify-center p-8">
				{imgError ? (
					<p className="text-sm text-muted-foreground">Could not load this image.</p>
				) : (
					<img
						src={shareFileUrl(token, "web")}
						alt={resolved.title || "Shared image"}
						style={{ filter: cssFilterFromAdjustments(resolved.adjustmentsJson) }}
						onError={() => setFailedToken(token)}
						className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
					/>
				)}
			</main>
			<footer className="pb-4 text-center text-xs text-muted-foreground">
				Made with Editorium — recognize, prompt, and edit every part of a photo.
			</footer>
		</div>
	);
}
