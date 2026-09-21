import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
