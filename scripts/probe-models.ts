/**
 * Real-model contract probe (plans/phase4). Runs the PRODUCTION pixel code —
 * ImagesOps, the FLUX adapter and the fidelity guard — against the live
 * Images + Workers AI bindings (remote, via getPlatformProxy; nothing is
 * deployed) on test/fixtures/scene.jpg, and fails if any operation breaks
 * its contract. The mock provider can never catch a model ignoring its
 * input; this can. Uses a small amount of real AI usage.
 *
 *   pnpm probe:models            # outputs land in .probe/
 */
import fs from "node:fs";
import path from "node:path";

import { getPlatformProxy } from "wrangler";

import { assertFidelity, toPixelBox } from "../src/worker/lib/fidelity";
import { buildAlphaMask } from "../src/worker/lib/mask";
import { ImagesOps } from "../src/worker/lib/pixels";
import { editDims, referenceDims } from "../src/worker/lib/providers/types";
import { decodeImageOutput, WorkersAIProvider } from "../src/worker/lib/providers/workersai";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".probe");
fs.mkdirSync(out, { recursive: true });
const wrangler = JSON.parse(fs.readFileSync(path.join(root, "wrangler.json"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
const EDIT_MODEL: string = wrangler.vars.MODEL_EDIT;

const { env, dispose } = await getPlatformProxy<{ IMAGES: ImagesBinding; AI: Ai }>({
	configPath: path.join(root, "scripts/probe.wrangler.json"),
	remoteBindings: true,
});
const ops = new ImagesOps(env.IMAGES);
const provider = new WorkersAIProvider(env.AI, { moondream: "", vlm: "", t2i: "", llm: "", edit: EDIT_MODEL });
const source = new Uint8Array(fs.readFileSync(path.join(root, "test/fixtures/scene.jpg"))).buffer as ArrayBuffer;

let failures = 0;
async function check(name: string, fn: () => Promise<string>) {
	const started = Date.now();
	try {
		console.log(`✓ ${name} — ${await fn()} (${Date.now() - started} ms)`);
	} catch (error) {
		failures++;
		console.log(`✗ ${name} — ${error instanceof Error ? error.message : String(error)}`);
	}
}
const save = (file: string, bytes: ArrayBuffer) => fs.writeFileSync(path.join(out, file), new Uint8Array(bytes));

const working = await ops.normalize(source, 4096);
const { width, height } = await ops.dims(working.bytes);

await check("enhance (ESRGAN + sharpen)", async () => {
	const res = await ops.enhance(working.bytes);
	save("enhance.jpg", res.bytes);
	const d = await ops.dims(res.bytes);
	const s = await assertFidelity(ops, "enhance", working.bytes, res.bytes);
	return `${res.model}, ${width}x${height} → ${d.width}x${d.height}, r=${s!.r}`;
});

await check("remove background (segment)", async () => {
	const res = await ops.removeBackground(working.bytes);
	save("remove-bg.png", res.bytes);
	const s = await assertFidelity(ops, "segment", working.bytes, res.bytes);
	return `r=${s!.r} on ${s!.n} subject px`;
});

await check("local edit (FLUX on crop + composite)", async () => {
	const region = { x: 0.2, y: 0.42, w: 0.34, h: 0.38 }; // the blue house
	const inner = toPixelBox(region, width, height);
	const pad = Math.round(Math.max(inner.width, inner.height) * 0.35);
	const crop = {
		left: Math.max(0, inner.left - pad),
		top: Math.max(0, inner.top - pad),
		width: Math.min(width, inner.left + inner.width + pad) - Math.max(0, inner.left - pad),
		height: Math.min(height, inner.top + inner.height + pad) - Math.max(0, inner.top - pad),
	};
	const cropped = await ops.crop(working.bytes, crop);
	const ref = referenceDims(crop.width, crop.height);
	const reference = await ops.resize(cropped.bytes, ref.width, ref.height);
	const edited = await provider.editWithReference(reference, "Make the blue house red. Keep everything else exactly the same.", editDims(crop.width, crop.height));
	const feather = 12;
	const mask = await buildAlphaMask(crop.width, crop.height, { left: inner.left - crop.left, top: inner.top - crop.top, width: inner.width, height: inner.height }, feather);
	const result = await ops.composite(working.bytes, edited.data, mask, crop);
	save("local-edit.jpg", result.bytes);
	const grown = { x: (inner.left - feather) / width, y: (inner.top - feather) / height, w: (inner.width + 2 * feather) / width, h: (inner.height + 2 * feather) / height };
	const s = await assertFidelity(ops, "local", working.bytes, result.bytes, { regions: [grown] });
	return `outside region r=${s!.r}, mad=${s!.mad}, outliers=${s!.outliers}`;
});

await check("reimagine (FLUX with the photo)", async () => {
	const ref = referenceDims(width, height);
	const reference = await ops.resize(working.bytes, ref.width, ref.height);
	const edited = await provider.editWithReference(reference, "Make it look like golden hour. Keep the composition the same.", editDims(width, height));
	save("reimagine.png", edited.data);
	const s = await assertFidelity(ops, "reimagine", working.bytes, edited.data);
	return `luma r=${s!.r}, structure=${s!.structure}`;
});

await check("reimagine a large recolour (must pass on structure)", async () => {
	const ref = referenceDims(width, height);
	const reference = await ops.resize(working.bytes, ref.width, ref.height);
	const edited = await provider.editWithReference(
		reference,
		"Make the sky dark purple at night. Keep the people, composition, framing and lighting the same.",
		editDims(width, height),
	);
	save("reimagine-recolour.png", edited.data);
	const s = await assertFidelity(ops, "reimagine", working.bytes, edited.data);
	return `luma r=${s!.r}, structure=${s!.structure}`;
});

await check("negative control: text-only FLUX must FAIL the guard", async () => {
	const form = new FormData();
	form.append("prompt", "enhance this photo: increase sharpness, clarity and detail, professional camera quality");
	form.append("width", "1024");
	form.append("height", "768");
	const req = new Request("https://x", { method: "POST", body: form });
	const outImg = await decodeImageOutput(
		await (env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> }).run(EDIT_MODEL, {
			multipart: { body: req.body, contentType: req.headers.get("content-type") },
		}),
	);
	if (!outImg) throw new Error("model returned nothing");
	save("negative-control.png", outImg.data);
	try {
		const s = await assertFidelity(ops, "reimagine", working.bytes, outImg.data);
		throw new Error(`guard did NOT catch an input-less generation (r=${s!.r}, structure=${s!.structure})`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("fidelity_check_failed")) return "correctly rejected";
		throw error;
	}
});

await dispose();
console.log(failures === 0 ? "\nAll model contracts hold." : `\n${failures} contract(s) broken.`);
console.log(`Outputs: ${out}`);
process.exit(failures === 0 ? 0 : 1);
