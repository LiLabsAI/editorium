import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { Dashboard } from "./pages/Dashboard";

function stubFetch(): ReturnType<typeof vi.fn> {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/api/albums")) {
			return new Response(
				JSON.stringify({
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
				}),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({}), { status: 200 });
	});
}

describe("Dashboard", () => {
	it("renders the workspace hero, tabs and album cards", async () => {
		vi.stubGlobal("fetch", stubFetch());
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
		vi.unstubAllGlobals();
	});
});
