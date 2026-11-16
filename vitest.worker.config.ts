import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			const migrations = await readD1Migrations(
				fileURLToPath(new URL("./drizzle", import.meta.url)),
			);

			return {
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						// Never spend real AI usage in tests, and never depend on
						// a developer's .dev.vars (CI has none).
						AI_MOCK: "true",
						AUTH_SECRET: "test-only-secret-0123456789abcdef0123456789abcdef",
						OWNER_CLAIM_KEY: "test-owner-claim-key",
						OWNER_USER_ID: "owner-user-for-tests",
					},
				},
				wrangler: { configPath: "./wrangler.json" },
				remoteBindings: false,
			};
		}),
	],
	test: {
		include: ["test/worker/**/*.spec.ts"],
		setupFiles: ["./test/worker/setup.ts"],
	},
});
