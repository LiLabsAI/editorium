import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dashboard } from "./pages/Dashboard";
import { SharePage } from "./pages/SharePage";

function stubFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		const hit = Object.entries(routes).find(([prefix]) => url.includes(prefix));
		if (!hit) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
		return new Response(JSON.stringify(hit[1]), { status: 200 });
	});
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

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

	it("shows expired view cleanly when share fails", async () => {
		vi.stubGlobal("fetch", stubFetch({}));
		render(
			<MemoryRouter initialEntries={["/s/badtoken"]}>
				<Routes>
					<Route path="/s/:token" element={<SharePage />} />
				</Routes>
			</MemoryRouter>,
		);
		expect(await screen.findByText(/expired or was revoked/)).toBeInTheDocument();
	});

	it("switches to References tab on Dashboard and lists project references", async () => {
		vi.stubGlobal(
			"fetch",
			stubFetch({
				"/api/albums": { project: { id: "p1", name: "Studio" }, albums: [] },
				"/api/references": {
					references: [
						{
							id: "ref1",
							projectId: "p1",
							title: "Film Grain",
							r2KeyFull: "k1",
							r2KeyThumb: "k2",
							mime: "image/png",
							widthPx: 800,
							heightPx: 600,
							kind: "image",
							createdAt: new Date().toISOString(),
						},
					],
				},
			}),
		);
		render(
			<MemoryRouter>
				<Dashboard me={{ user: { id: "u1", name: "Guest", plan: "free", credits: 20 }, project: { id: "p1", name: "Studio" } }} />
			</MemoryRouter>,
		);
		fireEvent.click(screen.getByRole("button", { name: "References" }));
		expect(await screen.findByText("Film Grain")).toBeInTheDocument();
		expect(screen.getByText("800 × 600")).toBeInTheDocument();
	});
});
