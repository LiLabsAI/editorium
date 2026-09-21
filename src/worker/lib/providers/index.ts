import { MockProvider } from "./mock";
import { WorkersAIProvider } from "./workersai";
import type { AIProvider } from "./types";

export * from "./types";

/**
 * Pick the provider for this environment. AI_MOCK=true (the default var)
 * keeps everything offline and deterministic; set it to "false" to route to
 * Workers AI using the MODEL_* vars from wrangler.json.
 */
export function getProvider(env: Env): AIProvider {
	if ((env.AI_MOCK ?? "true").toLowerCase() === "true") {
		return new MockProvider();
	}
	return new WorkersAIProvider(env.AI, {
		detect: env.MODEL_DETECT,
		vlm: env.MODEL_VLM,
		vlmSecondary: env.MODEL_VLM_SECONDARY,
		t2i: env.MODEL_T2I,
		llm: env.MODEL_LLM,
		inpaint: env.MODEL_INPAINT,
		img2img: env.MODEL_IMG2IMG,
		edit: env.MODEL_EDIT,
	});
}
