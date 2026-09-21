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
					bindings: { TEST_MIGRATIONS: migrations },
				},
				wrangler: { configPath: "./wrangler.json" },
			};
		}),
	],
	test: {
		include: ["test/worker/**/*.spec.ts"],
		setupFiles: ["./test/worker/setup.ts"],
	},
});
