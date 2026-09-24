import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { creditEvents, jobs, users } from "../../database/schema";
import { createDb } from "../../src/worker/lib/db";
import { chargeCredits, createJob, refundJob } from "../../src/worker/lib/jobs";
import { call, createAlbum, credits, guest, json, sseFrames, uploadPng, waitForJob } from "./helpers";

async function thread(cookie: string, albumId: string): Promise<string> {
	const res = await call(`/albums/${albumId}/threads`, { method: "POST", body: "{}" }, cookie);
	return (await json<{ thread: { id: string } }>(res)).thread.id;
}

async function chat(cookie: string, threadId: string, text: string) {
	const res = await call(`/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ text }) }, cookie);
	expect(res.status).toBe(200);
	return sseFrames(await res.text());
}

describe("chat agent (H2, H3, H4)", () => {
	it("a whole-photo edit from chat is queued, completes, and charges once", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		await uploadPng(cookie, albumId, 80, 60);
		const before = await credits(cookie);

		const frames = await chat(cookie, await thread(cookie, albumId), "make the wall bright blue please");
		const tool = frames.find((f) => f.event === "tool");
		expect(tool, "edit must be enqueued").toBeTruthy();
		const job = await waitForJob(cookie, tool!.data.jobId as string);
		expect(job.status).toBe("done");
		expect(job.resultImageId).toBeTruthy();
		expect(await credits(cookie)).toBe(before - 2);
	});

	it("text-to-image from chat works without a source photo", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const frames = await chat(cookie, await thread(cookie, albumId), "generate an image of a red fox in snow");
		const tool = frames.find((f) => f.event === "tool")!;
		const job = await waitForJob(cookie, tool.data.jobId as string);
		expect(job.status).toBe("done");
		const { images } = await json<{ images: Array<{ id: string; kind: string }> }>(
			await call(`/albums/${albumId}/images`, {}, cookie),
		);
		expect(images.map((i) => i.id)).toContain(job.resultImageId);
		expect(images[0]!.kind).toBe("generated");
	});

	it("token frames carry { value } so the client can render them live", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const frames = await chat(cookie, await thread(cookie, albumId), "what can you do?");
		const tokens = frames.filter((f) => f.event === "token");
		expect(tokens.length).toBeGreaterThan(0);
		expect(tokens.every((t) => typeof t.data.value === "string")).toBe(true);
		expect(frames.at(-1)!.event).toBe("done");
	});
});

describe("credits (H8, M11)", () => {
	it("insufficient credits is a 402 with no job and no ledger row", async () => {
		const cookie = await guest();
		const image = await uploadPng(cookie, await createAlbum(cookie));
		const me = await json<{ user: { id: string } }>(await call("/me", {}, cookie));
		const db = createDb(env.DB);
		await db.update(users).set({ creditBalance: 1 }).where(eq(users.id, me.user.id));
		const res = await call(`/images/${image.id}/edit`, { method: "POST", body: JSON.stringify({ prompt: "x" }) }, cookie);
		expect(res.status).toBe(402);
		expect(await db.select().from(jobs).where(eq(jobs.userId, me.user.id))).toHaveLength(0);
		expect(await db.select().from(creditEvents).where(eq(creditEvents.userId, me.user.id))).toHaveLength(0);
	});

	it("a failed batch edit is refunded exactly once", async () => {
		const cookie = await guest();
		const image = await uploadPng(cookie, await createAlbum(cookie));
		const before = await credits(cookie);
		await call(
			`/images/${image.id}/instructions`,
			{ method: "POST", body: JSON.stringify({ text: "__mock_fail__", bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }) },
			cookie,
		);
		const { jobId } = await json<{ jobId: string }>(
			await call(`/images/${image.id}/apply-instructions`, { method: "POST", body: "{}" }, cookie),
		);
		const job = await waitForJob(cookie, jobId);
		expect(job.status).toBe("error");
		expect(await credits(cookie)).toBe(before);
		// A redelivered failure must not refund twice.
		expect(await refundJob(createDb(env.DB), jobId)).toBe(0);
		expect(await credits(cookie)).toBe(before);
	});

	it("charge writes balance, ledger and job in one step", async () => {
		const cookie = await guest();
		const me = await json<{ user: { id: string } }>(await call("/me", {}, cookie));
		const db = createDb(env.DB);
		const jobId = await createJob(db, { type: "enhance", userId: me.user.id });
		const res = await chargeCredits(db, me.user.id, 3, "enhance", jobId);
		expect(res.ok).toBe(true);
		const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
		expect(job!.creditsCharged).toBe(3);
		const ledger = await db.select().from(creditEvents).where(eq(creditEvents.jobId, jobId));
		expect(ledger.map((l) => l.delta)).toEqual([-3]);
		expect(await refundJob(db, jobId)).toBe(3);
		expect(await refundJob(db, jobId)).toBe(0);
	});
});

describe("rate limiting (H9)", () => {
	it("the D1 backstop caps AI jobs per user per minute across all job types", async () => {
		const cookie = await guest();
		const image = await uploadPng(cookie, await createAlbum(cookie));
		const me = await json<{ user: { id: string } }>(await call("/me", {}, cookie));
		const db = createDb(env.DB);
		for (let i = 0; i < 12; i++) await createJob(db, { type: "segment", userId: me.user.id });
		const res = await call(`/images/${image.id}/resegment`, { method: "POST" }, cookie);
		expect(res.status).toBe(429);
		const rewrite = await call("/prompts/rewrite", { method: "POST", body: JSON.stringify({ text: "x" }) }, cookie);
		expect(rewrite.status).toBe(429);
	});
});

describe("region edits (M8)", () => {
	it("apply-instructions with ids applies only the new chip", async () => {
		const cookie = await guest();
		const image = await uploadPng(cookie, await createAlbum(cookie));
		const make = async (text: string) =>
			(
				await json<{ instruction: { id: string } }>(
					await call(
						`/images/${image.id}/instructions`,
						{ method: "POST", body: JSON.stringify({ text, bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } }) },
						cookie,
					),
				)
			).instruction.id;
		const stale = await make("old chip");
		const fresh = await make("new chip");
		const { jobId } = await json<{ jobId: string }>(
			await call(
				`/images/${image.id}/apply-instructions`,
				{ method: "POST", body: JSON.stringify({ instructionIds: [fresh] }) },
				cookie,
			),
		);
		expect((await waitForJob(cookie, jobId)).status).toBe("done");
		const { instructions } = await json<{ instructions: Array<{ id: string }> }>(
			await call(`/images/${image.id}/instructions`, {}, cookie),
		);
		expect(instructions.map((i) => i.id)).toEqual([stale]);
	});
});

describe("results keep the photo's shape (H6)", () => {
	it("an edit of a landscape photo produces a landscape branch", async () => {
		const cookie = await guest();
		const image = await uploadPng(cookie, await createAlbum(cookie), 400, 300);
		const { jobId } = await json<{ jobId: string }>(
			await call(`/images/${image.id}/edit`, { method: "POST", body: JSON.stringify({ prompt: "warmer light" }) }, cookie),
		);
		const job = await waitForJob(cookie, jobId);
		const { image: result } = await json<{ image: { widthPx: number; heightPx: number; sourceImageId: string } }>(
			await call(`/images/${job.resultImageId}`, {}, cookie),
		);
		expect(result.sourceImageId).toBe(image.id);
		expect(result.widthPx / result.heightPx).toBeCloseTo(4 / 3, 1);
	});
});
