import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Vitest config for the Finch web app (the Next BFF + dashboard).
//
// These are UNIT tests, run in plain Node (not the OpenNext/workerd adapter):
//   - happy-dom gives the React component tests a DOM (scope formatter, panels).
//   - The crypto used by lib/assertion.ts is Node's global Web Crypto
//     (crypto.subtle / crypto.getRandomValues), present in Node 20+ — the same
//     primitives the worker's auth.ts uses, so the CONTRACT test exercises the
//     real HMAC on both sides.
//   - `server-only` is aliased to a no-op so lib/hub.ts imports cleanly under
//     test (in prod the react-server export condition makes it a no-op already).
//   - `@/*` mirrors tsconfig's path alias so imports resolve the same as Next.
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": root,
      "server-only": path.resolve(root, "test/stubs/empty.ts"),
      // The CONTRACT test imports the worker's REAL auth at runtime through this
      // alias (tsc sees the type shim in test/worker-auth.d.ts instead, avoiding
      // a cross-package DOM-lib vs workers-types clash). vitest transpiles the
      // worker source per-file with esbuild, so it runs the genuine HMAC.
      "@worker-auth": path.resolve(root, "../worker/src/auth.ts"),
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
});
