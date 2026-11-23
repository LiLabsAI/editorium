import { describe, expect, it } from "vitest";

import { encodePng } from "../../src/worker/lib/mask";
import { compilePresetPrompt, findBuiltInPreset } from "../../src/worker/lib/presets";
import type { PresetDto } from "../../src/shared/presets";
import { call, createAlbum, credits, guest, json, uploadPng, waitForJob } from "./helpers";

/** Build a synthetic PNG with a distinct center subject over a uniform background
 * so PngOps.removeBackground separates subject vs background cleanly. */
async function uploadSubjectPhoto(cookie: string, albumId: string): Promise<{ id: string }> {
	const w = 64;
	const h = 48;
	const rgba = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const isSubject = x >= 18 && x <= 46 && y >= 10 && y <= 40;
			if (isSubject) {
				rgba[i] = 190 + ((x * 3) % 40);
				rgba[i + 1] = 80 + ((y * 2) % 40);
				rgba[i + 2] = 60;
				rgba[i + 3] = 255;
			} else {
				rgba[i] = 25;
				rgba[i + 1] = 35;
				rgba[i + 2] = 45;
				rgba[i + 3] = 255;
			}
		}
	}
	const bytes = await encodePng(w, h, 4, rgba);
	const form = new FormData();
	form.append("file", new File([bytes], "subject.png", { type: "image/png" }));
	const res = await call(`/albums/${albumId}/upload`, { method: "POST", body: form }, cookie);
	expect(res.status).toBe(201);
	const { image } = await json<{ image: { id: string } }>(res);
	return image;
}

describe("Preset system (filters, hidden-prompt AI effects, hybrids & custom CRUD)", () => {
	it("lists built-in filters, AI effects, and hybrids, and compiles hidden prompts server-side", async () => {
		const cookie = await guest();
		const res = await call("/presets", {}, cookie);
		expect(res.status).toBe(200);
		const { presets } = await json<{ presets: PresetDto[] }>(res);

		const filters = presets.filter((p) => p.kind === "filter");
		const aiEffects = presets.filter((p) => p.kind === "ai_effect");
		const hybrids = presets.filter((p) => p.kind === "hybrid");
		expect(filters.length).toBe(12);
		expect(aiEffects.length).toBe(11);
		expect(hybrids.length).toBe(2);
		expect(filters.every((p) => p.creditCost === 0 && p.isBuiltIn)).toBe(true);
		expect(aiEffects.every((p) => p.creditCost === 2 && Boolean(p.aiMeta?.remixPrompt))).toBe(true);
		expect(hybrids.every((p) => p.creditCost === 2 && Boolean(p.adjustments))).toBe(true);

		const neon = findBuiltInPreset("builtin:ai-neon-noir");
		expect(neon?.recipe).toBeTruthy();
		const compiled = compilePresetPrompt(neon!.recipe!, {
			intensity: "bold",
			extraPrompt: "keep coat red",
			paletteHexes: ["#06b6d4", "#d946ef"],
		});
		expect(compiled).toContain("dramatic, vivid, full-strength");
		expect(compiled).toContain("Additional creative direction: keep coat red.");
		expect(compiled).toContain("#06b6d4, #d946ef");
		expect(compiled).toContain("Keep the subject's identity");
	});

	it("validates and persists extended WebGL2 preset adjustments (fade, grain, bloom, split-toning)", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const image = await uploadPng(cookie, albumId, 64, 48);

		const res = await call(
			`/images/${image.id}/adjustments`,
			{
				method: "PATCH",
				body: JSON.stringify({
					adjustments: {
						fade: 0.25,
						grain: 0.2,
						bloom: 0.35,
						sepia: 0.15,
						splitShadowHue: 195,
						splitShadowAmt: 0.28,
						splitHighlightHue: 34,
						splitHighlightAmt: 0.2,
						presetId: "builtin:cinestill-800t",
						presetIntensity: 0.8,
					},
				}),
			},
			cookie,
		);
		expect(res.status).toBe(200);
		const data = await json<{ adjustmentsJson: string }>(res);
		expect(data.adjustmentsJson).toContain('"presetId":"builtin:cinestill-800t"');
		expect(data.adjustmentsJson).toContain('"bloom":0.35');
		expect(data.adjustmentsJson).toContain('"splitShadowHue":195');
	});

	it("supports custom preset CRUD, enforces ownership isolation, and protects built-ins", async () => {
		const alice = await guest();
		const bob = await guest();

		// Invalid empty filter preset rejected.
		const badFilter = await call(
			"/presets",
			{ method: "POST", body: JSON.stringify({ name: "Empty", kind: "filter", adjustments: {} }) },
			alice,
		);
		expect(badFilter.status).toBe(400);

		// Invalid AI preset missing promptTemplate rejected.
		const badAi = await call(
			"/presets",
			{ method: "POST", body: JSON.stringify({ name: "No prompt", kind: "ai_effect" }) },
			alice,
		);
		expect(badAi.status).toBe(400);

		// Built-ins cannot be modified or deleted.
		expect(
			(
				await call(
					"/presets/builtin:portra-400",
					{ method: "PATCH", body: JSON.stringify({ name: "Hacked" }) },
					alice,
				)
			).status,
		).toBe(400);
		expect((await call("/presets/builtin:portra-400", { method: "DELETE" }, alice)).status).toBe(400);

		// Alice creates a custom GPU filter preset.
		const createRes = await call(
			"/presets",
			{
				method: "POST",
				body: JSON.stringify({
					name: "Alice Warm Film",
					category: "film",
					kind: "filter",
					description: "Custom warm grain",
					adjustments: { temperature: 0.24, fade: 0.2, grain: 0.18 },
				}),
			},
			alice,
		);
		expect(createRes.status).toBe(201);
		const { preset } = await json<{ preset: PresetDto }>(createRes);
		expect(preset.isBuiltIn).toBe(false);
		expect(preset.creditCost).toBe(0);
		expect(preset.slug).toBe("alice-warm-film");

		// Bob cannot see, edit, or delete Alice's preset.
		const bobList = await json<{ presets: PresetDto[] }>(await call("/presets", {}, bob));
		expect(bobList.presets.some((p) => p.id === preset.id)).toBe(false);
		expect(
			(await call(`/presets/${preset.id}`, { method: "PATCH", body: JSON.stringify({ name: "Stolen" }) }, bob))
				.status,
		).toBe(404);
		expect((await call(`/presets/${preset.id}`, { method: "DELETE" }, bob)).status).toBe(404);

		// Alice favorites, renames, then deletes her preset.
		const patchRes = await call(
			`/presets/${preset.id}`,
			{ method: "PATCH", body: JSON.stringify({ name: "Alice 35mm", isFavorite: true }) },
			alice,
		);
		expect(patchRes.status).toBe(200);
		const { preset: updated } = await json<{ preset: PresetDto }>(patchRes);
		expect(updated.name).toBe("Alice 35mm");
		expect(updated.isFavorite).toBe(true);

		expect((await call(`/presets/${preset.id}`, { method: "DELETE" }, alice)).status).toBe(200);
	});

	it("applies built-in AI effect, BiRefNet background preset, and hybrid preset with clean history provenance", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const image = await uploadSubjectPhoto(cookie, albumId);

		// Calling apply-preset on a client GPU filter returns 400 preset_requires_ai.
		const wrongKind = await call(
			`/images/${image.id}/apply-preset`,
			{ method: "POST", body: JSON.stringify({ presetId: "builtin:portra-400" }) },
			cookie,
		);
		expect(wrongKind.status).toBe(400);

		// 1. BiRefNet background-only preset protects subject pixels and tags model with +birefnet.
		const beforeCredits = await credits(cookie);
		const bgRes = await call(
			`/images/${image.id}/apply-preset`,
			{
				method: "POST",
				body: JSON.stringify({
					presetId: "builtin:ai-clean-studio",
					intensity: "balanced",
					extraPrompt: "soft floor shadow",
				}),
			},
			cookie,
		);
		expect(bgRes.status).toBe(202);
		const { jobId: bgJobId } = await json<{ jobId: string; presetName: string }>(bgRes);
		const bgJob = await waitForJob(cookie, bgJobId);
		expect(bgJob.status).toBe("done");
		expect(bgJob.resultImageId).toBeTruthy();
		expect(await credits(cookie)).toBe(beforeCredits - 2);

		const history = await json<{
			turns: Array<{
				request: { text: string; presetId?: string | null; presetName?: string | null };
				reply: { result?: { imageId: string; model?: string | null; presetId?: string | null; presetName?: string | null } | null };
			}>;
		}>(await call(`/images/${image.id}/history`, {}, cookie));
		const bgTurn = history.turns.find((t) => t.request.presetId === "builtin:ai-clean-studio");
		expect(bgTurn).toBeTruthy();
		expect(bgTurn!.request.text).toBe("Preset: Clean Studio (Balanced) · soft floor shadow");
		expect(bgTurn!.reply.result?.model).toContain("+birefnet");
		expect(bgTurn!.reply.result?.presetName).toBe("Clean Studio");

		// 2. Hybrid preset attaches live finishing GPU adjustments onto the new branch.
		const hybridRes = await call(
			`/images/${image.id}/apply-preset`,
			{
				method: "POST",
				body: JSON.stringify({ presetId: "builtin:hybrid-cinema-still", intensity: "subtle" }),
			},
			cookie,
		);
		expect(hybridRes.status).toBe(202);
		const { jobId: hybridJobId } = await json<{ jobId: string }>(hybridRes);
		const hybridJob = await waitForJob(cookie, hybridJobId);
		expect(hybridJob.status).toBe("done");
		expect(hybridJob.resultImageId).toBeTruthy();

		const hybridImg = await json<{ image: { adjustmentsJson: string | null } }>(
			await call(`/images/${hybridJob.resultImageId}`, {}, cookie),
		);
		expect(hybridImg.image.adjustmentsJson).toBeTruthy();
		expect(hybridImg.image.adjustmentsJson).toContain('"presetId":"builtin:hybrid-cinema-still"');
		expect(hybridImg.image.adjustmentsJson).toContain('"splitShadowAmt":0.22');
	});

	it("refunds credits atomically when a custom AI preset fails the fidelity guard, and blocks cross-user execution", async () => {
		const alice = await guest();
		const bob = await guest();
		const albumId = await createAlbum(alice);
		const image = await uploadPng(alice, albumId, 64, 48);

		// Create a custom AI preset whose prompt triggers the mock drift failure.
		const created = await json<{ preset: PresetDto }>(
			await call(
				"/presets",
				{
					method: "POST",
					body: JSON.stringify({
						name: "Drifting Test",
						kind: "ai_effect",
						promptTemplate: "__mock_ignore_input__ unrelated painting",
						opClass: "reimagine",
					}),
				},
				alice,
			),
		);

		// Bob cannot execute Alice's private custom preset on Bob's image.
		const bobAlbum = await createAlbum(bob);
		const bobImg = await uploadPng(bob, bobAlbum, 64, 48);
		const forbidden = await call(
			`/images/${bobImg.id}/apply-preset`,
			{ method: "POST", body: JSON.stringify({ presetId: created.preset.id }) },
			bob,
		);
		expect(forbidden.status).toBe(404);

		// Alice runs the drifting preset -> fidelity guard fails job and refunds 2 credits.
		const before = await credits(alice);
		const runRes = await call(
			`/images/${image.id}/apply-preset`,
			{ method: "POST", body: JSON.stringify({ presetId: created.preset.id }) },
			alice,
		);
		expect(runRes.status).toBe(202);
		const { jobId } = await json<{ jobId: string }>(runRes);
		const job = await waitForJob(alice, jobId);
		expect(job.status).toBe("error");
		expect(await credits(alice)).toBe(before);
	});

	it("applies AI presets inside a selected segment and blocks locked layers", async () => {
		const cookie = await guest();
		const albumId = await createAlbum(cookie);
		const image = await uploadSubjectPhoto(cookie, albumId);

		const segRes = await call(`/images/${image.id}/subject-mask`, { method: "POST" }, cookie);
		expect(segRes.status).toBe(201);
		const { segment } = await json<{ segment: { id: string } }>(segRes);

		// Lock the layer -> applying a preset on it must return 409 segment_locked without burning credits.
		expect(
			(await call(`/segments/${segment.id}`, { method: "PATCH", body: JSON.stringify({ locked: true }) }, cookie))
				.status,
		).toBe(200);
		const lockedRes = await call(
			`/images/${image.id}/apply-preset`,
			{ method: "POST", body: JSON.stringify({ presetId: "builtin:ai-neon-noir", segmentId: segment.id }) },
			cookie,
		);
		expect(lockedRes.status).toBe(409);

		// Unlock -> applying a preset scopes to local edit on that segment.
		expect(
			(await call(`/segments/${segment.id}`, { method: "PATCH", body: JSON.stringify({ locked: false }) }, cookie))
				.status,
		).toBe(200);
		const okRes = await call(
			`/images/${image.id}/apply-preset`,
			{ method: "POST", body: JSON.stringify({ presetId: "builtin:ai-neon-noir", segmentId: segment.id }) },
			cookie,
		);
		expect(okRes.status).toBe(202);
		const { jobId } = await json<{ jobId: string }>(okRes);
		const job = await waitForJob(cookie, jobId);
		expect(job.status).toBe("done");
		expect(job.resultImageId).toBeTruthy();
	});
});
