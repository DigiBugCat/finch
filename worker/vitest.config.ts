import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Vitest config for the Finch hub worker. We run the unit tests INSIDE the
// workerd runtime via @cloudflare/vitest-pool-workers so the tests exercise the
// real primitives the worker depends on:
//   - auth.ts uses Web Crypto (crypto.subtle / crypto.getRandomValues) — only
//     present in workerd, so the workers pool gives us the genuine runtime.
//   - tenant-do.ts extends DurableObject from "cloudflare:workers" and drives
//     ctx.storage — instantiable only inside a Workers isolate. The pool +
//     `cloudflare:test` env let us hit the real TenantDO + its SQLite storage.
//
// Two pieces must BOTH be wired (vitest 4 / pool-workers 0.16):
//   - cloudflareTest(...) — a Vite plugin that resolves the virtual
//     `cloudflare:test` module (env, runInDurableObject, …).
//   - cloudflarePool(...) — the test pool that runs each file in workerd.
// They share the same options object: the test-only wrangler config carries the
// DO bindings + SQLite migrations + test secret fixtures.
const workerOptions = {
  main: "./src/index.ts",
  wrangler: { configPath: "./test/wrangler.test.jsonc" },
};

export default defineConfig({
  plugins: [cloudflareTest(workerOptions)],
  test: {
    include: ["test/**/*.test.ts"],
    pool: cloudflarePool(workerOptions),
  },
});
