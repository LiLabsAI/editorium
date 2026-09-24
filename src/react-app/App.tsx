import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router";

import { api, type Me } from "./lib/api";
import { AlbumPage } from "./pages/AlbumPage";
import { ClaimPage } from "./pages/ClaimPage";
import { Dashboard } from "./pages/Dashboard";
import { EditorPage } from "./pages/EditorPage";
import { SharePage } from "./pages/SharePage";

/** One bootstrap per page load, even under StrictMode's double effects, so a
 * first visit never creates two guest accounts. */
let bootstrap: Promise<Me> | null = null;

function ensureSession(): Promise<Me> {
	bootstrap ??= (async () => {
		const me = await api.me();
		if (me.user) return me;
		await api.guest();
		return api.me();
	})();
	return bootstrap;
}

/** Public routes never create or use a session (share viewers stay anonymous). */
function isPublicRoute(pathname: string): boolean {
	return pathname.startsWith("/s/") || pathname === "/claim";
}

/** App shell: bootstraps a private guest session and routes the three product
 * surfaces + the public share viewer + the owner-claim page. */
function App() {
	const publicRoute = isPublicRoute(window.location.pathname);
	const [me, setMe] = useState<Me | null>(null);
	const [booted, setBooted] = useState(publicRoute);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (publicRoute) return;
		ensureSession()
			.then(setMe)
			.catch(() => setFailed(true))
			.finally(() => setBooted(true));
	}, [publicRoute]);

	if (!booted) {
		return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading Editorium…</div>;
	}
	if (failed) {
		return (
			<div className="flex h-screen items-center justify-center text-muted-foreground">
				Couldn't start a session. Please reload the page.
			</div>
		);
	}

	const projectName = me?.project?.name ?? "Project";

	return (
		<BrowserRouter>
			<Routes>
				<Route path="/" element={<Dashboard me={me} />} />
				<Route path="/albums/:albumId" element={<AlbumPage projectName={projectName} />} />
				<Route path="/albums/:albumId/images/:imageId" element={<EditorPage projectName={projectName} />} />
				<Route path="/s/:token" element={<SharePage />} />
				<Route path="/claim" element={<ClaimPage />} />
			</Routes>
		</BrowserRouter>
	);
}

export default App;
