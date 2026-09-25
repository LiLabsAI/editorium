import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createImageFromBytes } from "../../src/worker/lib/operations";
import { call, createAlbum, guest, json, pngBytes, sseFrames, uploadPng, waitForJob } from "./helpers";

interface Turn {
	id: string;
	derived: boolean;
	request: { text: string; opClass: string | null; bboxes: Array<{ x: number }>; imageId: string | null };
	reply: {
		status: string;
		text: string;
		error: string | null;
		credits: number;
		refunded: boolean;
		result: { imageId: string; opClass: string | null; fidelity: number | null } | null;
	};
}

async function history(cookie: string, imageId: string) {
	return json<{ threadId: string; rootImageId: string; turns: Turn[] }>(await call(`/images/${imageId}/history`, {}, cookie));
}

async function setup() {
	const cookie = await guest();
	const albumId = await createAlbum(cookie);
	const image = await uploadPng(cookie, albumId, 64, 48);
	return { cookie, albumId, image };
}

describe("editor history (phase 5)", () => {
	it("starts with the original photo", async () => {
		const { cookie, image } = await setup();
		const h = await history(cookie, image.id);
		expect(h.rootImageId).toBe(image.id);
		expect(h.turns).toHaveLength(1);
		expect(h.turns[0]).toMatchObject({ derived: true, request: { opClass: "upload" } });
	});

	it("records a button action when it starts and links its result when it finishes", async () => {
		const { cookie, image } = await setup();
		const { jobId } = await json<{ jobId: string }>(await call(`/images/${image.id}/enhance`, { method: "POST" }, cookie));
		const job = await waitForJob(cookie, jobId);
		const h = await history(cookie, image.id);
		const turn = h.turns.find((t) => !t.derived)!;
		expect(turn.request).toMatchObject({ text: "Enhance", opClass: "enhance", imageId: image.id });
		expect(turn.reply.status).toBe("done");
		expect(turn.reply.credits).toBe(3);
		expect(turn.reply.result).toMatchObject({ imageId: job.resultImageId, opClass: "enhance" });

		// The branch belongs to the same family: same thread, same timeline.
		const fromBranch = await history(cookie, job.resultImageId!);
		expect(fromBranch.threadId).toBe(h.threadId);
		expect(fromBranch.turns.map((t) => t.id)).toEqual(h.turns.map((t) => t.id));
	});

	it("keeps failures visible with a plain reason and the refund", async () => {
		const { cookie, image } = await setup();
		const { jobId } = await json<{ jobId: string }>(
			await call(`/images/${image.id}/edit`, { method: "POST", body: JSON.stringify({ prompt: "__mock_ignore_input__ x" }) }, cookie),
		);
		await waitForJob(cookie, jobId);
		const turn = (await history(cookie, image.id)).turns.find((t) => !t.derived)!;
		expect(turn.request.opClass).toBe("reimagine");
		expect(turn.reply).toMatchObject({
			status: "error",
			error: "The result didn't match your photo, so it wasn't saved.",
			refunded: true,
			result: null,
		});
	});

	it("records instant presets and region edits with their boxes", async () => {
		const { cookie, image } = await setup();
		const form = new FormData();
		form.append("file", new File([await pngBytes(64, 48)], "f.png", { type: "image/png" }));
		form.append("label", "Black & white");
		await call(`/images/${image.id}/filter-branch`, { method: "POST", body: form }, cookie);

		const bbox = { x: 0.5, y: 0.1, w: 0.25, h: 0.3 };
		const { instruction } = await json<{ instruction: { id: string } }>(
			await call(`/images/${image.id}/instructions`, { method: "POST", body: JSON.stringify({ text: "make the sun blue", bbox }) }, cookie),
		);
		const { jobId } = await json<{ jobId: string }>(
			await call(`/images/${image.id}/apply-instructions`, { method: "POST", body: JSON.stringify({ instructionIds: [instruction.id] }) }, cookie),
		);
		await waitForJob(cookie, jobId);

		const turns = (await history(cookie, image.id)).turns.filter((t) => !t.derived);
		expect(turns.map((t) => t.request.opClass)).toEqual(["adjust", "local"]);
		expect(turns[0]!.reply).toMatchObject({ status: "done", credits: 0 });
		expect(turns[1]!.request).toMatchObject({ text: "make the sun blue", bboxes: [bbox] });
		expect(turns[1]!.reply.status).toBe("done");
	});

	it("chat from the editor lands in the same history (questions and edits)", async () => {
		const { cookie, image } = await setup();
		const { threadId } = await history(cookie, image.id);
		const send = async (text: string) =>
			sseFrames(
				await (
					await call(`/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ text, attachedImageId: image.id }) }, cookie)
				).text(),
			);
		await send("what can you do?");
		const frames = await send("make the lighting warmer please");
		const tool = frames.find((f) => f.event === "tool")!;
		await waitForJob(cookie, tool.data.jobId as string);

		const turns = (await history(cookie, image.id)).turns.filter((t) => !t.derived);
		expect(turns.map((t) => t.request.opClass)).toEqual(["answer", "reimagine"]);
		expect(turns[0]!.reply.text.length).toBeGreaterThan(0);
		expect(turns[1]!.reply.status).toBe("done");
		expect(turns[1]!.reply.result?.imageId).toBeTruthy();
	});

	it("reconstructs history for photos made before it was recorded", async () => {
		const { cookie, albumId, image } = await setup();
		const me = await json<{ user: { id: string } }>(await call("/me", {}, cookie));
		const legacy = await createImageFromBytes(env, {
			userId: me.user.id,
			albumId,
			bytes: await pngBytes(64, 48),
			kind: "edited",
			label: "old golden hour edit",
			sourceImageId: image.id,
			rootImageId: image.id,
			operation: "filter",
		});
		const turns = (await history(cookie, image.id)).turns;
		const derived = turns.find((t) => t.reply.result?.imageId === legacy.imageId)!;
		expect(derived).toMatchObject({ derived: true, request: { text: "old golden hour edit", opClass: "adjust", imageId: image.id } });
	});

	it("never shows another user's photo history", async () => {
		const { image } = await setup();
		const stranger = await guest();
		expect((await call(`/images/${image.id}/history`, {}, stranger)).status).toBe(404);
	});
});
