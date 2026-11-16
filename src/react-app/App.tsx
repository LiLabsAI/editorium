import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Link, Route, Routes, useLocation } from "react-router";

import { api, type Me } from "./lib/api";
import { jobEvents } from "./lib/events";
import { AlbumPage } from "./pages/AlbumPage";
import { ClaimPage } from "./pages/ClaimPage";
import { Dashboard } from "./pages/Dashboard";
import { EditorPage } from "./pages/EditorPage";
import { SharePage } from "./pages/SharePage";

/** Single bootstrap per attempt so StrictMode double effects don't create
 * duplicate guest accounts. Cleared on failure so retry recovers cleanly. */
let bootstrap: Promise<Me> | null = null;

function ensureSession(): Promise<Me> {
	bootstrap ??= (async () => {
		const me = await api.me();
		if (me.user) return me;
		await api.guest();
		return api.me();
	})().catch((err) => {
		bootstrap = null;
		throw err;
	});
	return bootstrap;
}

/** Public routes never create or use a session (share viewers stay anonymous). */
function isPublicRoute(pathname: string): boolean {
	return pathname.startsWith("/s/") || pathname === "/claim";
}

function NotFoundPage() {
	return (
		<div className="flex h-screen flex-col items-center justify-center gap-3 px-4 text-center">
			<h1 className="text-lg font-semibold">Page not found</h1>
			<p className="text-sm text-muted-foreground">The link may be broken or the item was removed.</p>
			<Link to="/" className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background">
				Back to Dashboard
			</Link>
		</div>
	);
}

function AppShell() {
	const location = useLocation();
	const publicRoute = isPublicRoute(location.pathname);
	const [me, setMe] = useState<Me | null>(null);
	const [booted, setBooted] = useState(publicRoute);
	const [failed, setFailed] = useState(false);

	const [retryNonce, setRetryNonce] = useState(0);

	const refreshMe = useCallback(() => {
		api.me()
			.then(setMe)
			.catch(() => {});
	}, []);

	useEffect(() => {
		if (publicRoute) return;
		let cancelled = false;
		ensureSession()
			.then((res) => {
				if (cancelled) return;
				setMe(res);
				setFailed(false);
				if (res.user) jobEvents.start();
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			})
			.finally(() => {
				if (!cancelled) setBooted(true);
			});
		return () => {
			cancelled = true;
		};
	}, [publicRoute, retryNonce]);

	// Refresh credit balance whenever a job finishes or fails over WebSocket.
	useEffect(() => {
		if (publicRoute) return;
		return jobEvents.subscribe((ev) => {
			if (ev.status === "done" || ev.status === "error") refreshMe();
		});
	}, [publicRoute, refreshMe]);

	if (!publicRoute && !booted) {
		return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading Editorium…</div>;
	}
	if (!publicRoute && failed) {
		return (
			<div className="flex h-screen flex-col items-center justify-center gap-3 px-4 text-center">
				<p className="text-sm text-muted-foreground">Couldn't start a session. Please try again.</p>
				<button
					type="button"
					onClick={() => {
						setBooted(false);
						setFailed(false);
						setRetryNonce((n) => n + 1);
					}}
					className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background"
				>
					Retry
				</button>
			</div>
		);
	}

	const projectName = me?.project?.name ?? "Project";

	return (
		<Routes>
			<Route path="/" element={<Dashboard me={me} onRefreshMe={refreshMe} />} />
			<Route path="/albums/:albumId" element={<AlbumPage projectName={projectName} me={me} />} />
			<Route
				path="/albums/:albumId/images/:imageId"
				element={<EditorPage projectName={projectName} me={me} onRefreshMe={refreshMe} />}
			/>
			<Route path="/s/:token" element={<SharePage />} />
			<Route path="/claim" element={<ClaimPage />} />
			<Route path="*" element={<NotFoundPage />} />
		</Routes>
	);
}

/** App shell: router-aware session bootstrap, live DO event sync, and routes. */
function App() {
	return (
		<BrowserRouter>
			<AppShell />
		</BrowserRouter>
	);
}

export default App;
