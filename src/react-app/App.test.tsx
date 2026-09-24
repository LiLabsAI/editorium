import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dashboard } from "./pages/Dashboard";
import { SharePage } from "./pages/SharePage";
import { Route, Routes } from "react-router";

function stubFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		const hit = Object.entries(routes).find(([prefix]) => url.includes(prefix));
		if (!hit) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
		return new Response(JSON.stringify(hit[1]), { status: 200 });
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("Dashboard", () => {
	it("renders the workspace hero, tabs and album cards", async () => {
		vi.stubGlobal(
			"fetch",
			stubFetch({
				"/api/albums": {
					project: { id: "p1", name: "Test Project" },
					albums: [
						{
							id: "a1",
							title: "Enhanced Portrait",
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
							coverImageId: null,
							imageCount: 2,
						},
					],
				},
			}),
		);
		render(
			<MemoryRouter>
				<Dashboard me={null} />
			</MemoryRouter>,
		);

		expect(screen.getByRole("heading", { name: /Project/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /New album/ })).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.getByText("Enhanced Portrait")).toBeInTheDocument();
		});
		expect(screen.getByText(/2 images/)).toBeInTheDocument();
	});

	it("shows an error instead of failing silently", async () => {
		vi.stubGlobal("fetch", stubFetch({}));
		render(
			<MemoryRouter>
				<Dashboard me={null} />
			</MemoryRouter>,
		);
		expect(await screen.findByRole("alert")).toBeInTheDocument();
	});
});

describe("SharePage", () => {
	it("loads media by share token, never by image id or the authed route", async () => {
		const fetchMock = stubFetch({ "/api/public/share/tok123": { share: { allowDownload: true, title: "Beach" } } });
		vi.stubGlobal("fetch", fetchMock);
		render(
			<MemoryRouter initialEntries={["/s/tok123"]}>
				<Routes>
					<Route path="/s/:token" element={<SharePage />} />
				</Routes>
			</MemoryRouter>,
		);
		const img = await screen.findByRole("img", { name: "Beach" });
		expect(img.getAttribute("src")).toBe("/api/public/share/tok123/file?variant=web");
		expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
			"/api/public/share/tok123/file?variant=original",
		);
	});
});
