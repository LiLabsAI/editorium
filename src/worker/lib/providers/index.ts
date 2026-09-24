import { MockProvider } from "./mock";
import { WorkersAIProvider } from "./workersai";
import type { AIProvider } from "./types";

export * from "./types";

/**
 * Pick the provider for this environment. Production (wrangler.json) sets
 * AI_MOCK="false" and routes to Workers AI using the MODEL_* vars; tests set
 * AI_MOCK="true" for the offline, deterministic mock.
 */
export function getProvider(env: Env): AIProvider {
	if (isMock(env)) {
		return new MockProvider();
	}
	return new WorkersAIProvider(env.AI, {
		moondream: env.MODEL_DETECT_MOONDREAM,
		vlm: env.MODEL_VLM,
		vlmSecondary: env.MODEL_VLM_SECONDARY,
		t2i: env.MODEL_T2I,
		llm: env.MODEL_LLM,
		edit: env.MODEL_EDIT,
	});
}

export function isMock(env: Env): boolean {
	return String(env.AI_MOCK ?? "true").toLowerCase() === "true";
}
