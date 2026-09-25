import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditComposer } from "./components/EditComposer";
import { HistoryPanel } from "./components/HistoryPanel";
import type { HistoryTurn } from "./lib/api";
import { composerMode, regionWords, singleTarget } from "./lib/history";

const DEFAULT_REPLY: HistoryTurn["reply"] = {
	status: "done",
	text: "",
	error: null,
	credits: 0,
	refunded: false,
	result: null,
};

function turn(
	partial: Omit<Partial<HistoryTurn>, "reply"> & { request: HistoryTurn["request"]; reply: Partial<HistoryTurn["reply"]> },
): HistoryTurn {
	return {
		id: partial.id ?? crypto.randomUUID(),
		createdAt: "2026-09-25T10:00:00.000Z",
		derived: partial.derived ?? false,
		request: partial.request,
		reply: Object.assign({}, DEFAULT_REPLY, partial.reply),
	};
}

const original = turn({
	derived: true,
	request: { text: "Original photo", opClass: "upload", bboxes: [], imageId: null },
	reply: { result: { imageId: "root", label: "photo.jpg", opClass: null, model: null, fidelity: null, exists: true } },
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const handlers = {
	onOpen: vi.fn(),
	onRetry: vi.fn(),
	onEditPrompt: vi.fn(),
	onRegionize: vi.fn(),
	onHighlight: vi.fn(),
};

describe("composer helpers", () => {
	it("flags a whole-photo prompt that names one object (the green-drink case)", () => {
		expect(singleTarget("Please add the eye contact lenses")).toBe("the eye contact");
		expect(singleTarget("make the drink green")).toBe("the drink");
		expect(singleTarget("make the eyes blue")).toBe("the eyes");
		expect(singleTarget("turn his jacket into denim")).toBe("the jacket");
		expect(singleTarget("make the lighting warmer")).toBeNull();
		expect(singleTarget("what is in the photo?")).toBeNull();
	});

	it("states the mode and cost before sending", () => {
		expect(composerMode("make it golden", false).kind).toBe("reimagine");
		expect(composerMode("what is this?", false).kind).toBe("ask");
		expect(composerMode("make it red", true)).toMatchObject({ kind: "region", label: "Edit region" });
	});

	it("describes regions in words", () => {
		expect(regionWords({ x: 0, y: 0, w: 0.2, h: 0.2 })).toBe("upper left");
		expect(regionWords({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBe("center");
	});
});

describe("HistoryPanel", () => {
	it("shows tips while only the original exists", () => {
		render(<HistoryPanel turns={[original]} live={null} currentImageId="root" {...handlers} />);
		expect(screen.getByText(/Every result is a new photo/)).toBeInTheDocument();
	});

	it("shows a finished edit with its guarantee, and a failure with its refund", () => {
		const done = turn({
			request: { text: "make the drink green", opClass: "local", bboxes: [{ x: 0, y: 0.6, w: 0.3, h: 0.3 }], imageId: "root" },
			reply: {
				credits: 2,
				result: { imageId: "b1", label: "Edited drink", opClass: "local", model: "flux", fidelity: 1, exists: true },
			},
		});
		const failed = turn({
			request: { text: "add contact lenses", opClass: "reimagine", bboxes: [], imageId: "root" },
			reply: { status: "error", error: "The result didn't match your photo, so it wasn't saved.", credits: 2, refunded: true },
		});
		render(<HistoryPanel turns={[original, done, failed]} live={null} currentImageId="root" {...handlers} />);

		expect(screen.getByText("Region edit · lower left")).toBeInTheDocument();
		expect(screen.getByText(/Outside the region unchanged · fidelity 1.00 · 2 credits/)).toBeInTheDocument();
		expect(screen.getByText("The result didn't match your photo, so it wasn't saved.")).toBeInTheDocument();
		expect(screen.getByText("2 credits refunded")).toBeInTheDocument();

		fireEvent.click(screen.getAllByText("Retry")[1]!);
		expect(handlers.onRetry).toHaveBeenCalledWith(failed);
		fireEvent.click(screen.getByText("Open"));
		expect(handlers.onOpen).toHaveBeenCalledWith("b1");
	});

	it("shows pending work in place", () => {
		const running = turn({ request: { text: "Enhance", opClass: "enhance", bboxes: [], imageId: "root" }, reply: { status: "running" } });
		render(<HistoryPanel turns={[original, running]} live={null} currentImageId="root" {...handlers} />);
		expect(screen.getByRole("status")).toHaveTextContent("Enhancing…");
	});

	it("filters chat from edits", () => {
		const q = turn({ request: { text: "what is this?", opClass: "answer", bboxes: [], imageId: "root" }, reply: { text: "A portrait." } });
		render(<HistoryPanel turns={[original, q]} live={null} currentImageId="root" {...handlers} />);
		fireEvent.click(screen.getByRole("button", { name: "edits" }));
		expect(screen.queryByText("A portrait.")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "chat" }));
		expect(screen.getByText("A portrait.")).toBeInTheDocument();
	});
});

describe("EditComposer", () => {
	it("shows the selected box as context and the region mode", () => {
		render(
			<EditComposer
				imageId="root"
				imageLabel="photo.jpg"
				selection={{ x: 0, y: 0.6, w: 0.3, h: 0.3 }}
				onClearSelection={vi.fn()}
				value="make it green"
				onChange={vi.fn()}
				onSubmit={vi.fn()}
				busy={false}
				lastPrompt={null}
				wantsRegion={false}
			/>,
		);
		expect(screen.getByText(/Box · lower left/)).toBeInTheDocument();
		expect(screen.getByText("Edit region")).toBeInTheDocument();
	});

	it("suggests a region when a whole-photo prompt names one object", () => {
		render(
			<EditComposer
				imageId="root"
				imageLabel="photo.jpg"
				selection={null}
				onClearSelection={vi.fn()}
				value="make the drink green"
				onChange={vi.fn()}
				onSubmit={vi.fn()}
				busy={false}
				lastPrompt={null}
				wantsRegion={false}
			/>,
		);
		expect(screen.getByText(/draw a box around it first/)).toBeInTheDocument();
	});

	it("recalls the last prompt with the up arrow", () => {
		const onChange = vi.fn();
		render(
			<EditComposer
				imageId="root"
				imageLabel="photo.jpg"
				selection={null}
				onClearSelection={vi.fn()}
				value=""
				onChange={onChange}
				onSubmit={vi.fn()}
				busy={false}
				lastPrompt="make the drink green"
				wantsRegion={false}
			/>,
		);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
		expect(onChange).toHaveBeenCalledWith("make the drink green");
	});
});
