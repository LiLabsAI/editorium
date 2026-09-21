import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router";

import { api, type Me } from "./lib/api";
import { Dashboard } from "./pages/Dashboard";
import { AlbumPage } from "./pages/AlbumPage";
import { EditorPage } from "./pages/EditorPage";
import { SharePage } from "./pages/SharePage";

/** App shell: bootstraps the session (demo sign-in for now) and routes the
 * three product surfaces + public share viewer. */
function App() {
	const [me, setMe] = useState<Me | null>(null);
	const [booted, setBooted] = useState(false);

	useEffect(() => {
		api.me()
			.then(async (res) => {
				if (!res.user) {
					await api.demoLogin();
					res = await api.me();
				}
				setMe(res);
			})
			.finally(() => setBooted(true));
	}, []);

	if (!booted) {
		return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading Editorium…</div>;
	}

	const projectName = me?.project?.name ?? "Project";

	return (
		<BrowserRouter>
			<Routes>
				<Route path="/" element={<Dashboard me={me} />} />
				<Route path="/albums/:albumId" element={<AlbumPage projectName={projectName} />} />
				<Route path="/albums/:albumId/images/:imageId" element={<EditorPage projectName={projectName} />} />
				<Route path="/s/:token" element={<SharePage />} />
			</Routes>
		</BrowserRouter>
	);
}

export default App;
