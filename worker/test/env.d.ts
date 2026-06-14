// Test-suite ambient types.
//
// 1) Pull in the @cloudflare/vitest-pool-workers `cloudflare:test` module
//    declaration (env, runInDurableObject, …) — it lives at a non-default
//    subpath, so a triple-slash reference is the wiring TypeScript needs.
/// <reference types="@cloudflare/vitest-pool-workers/types" />

// 2) The test types reference `Cloudflare.Env` (the bindings shape). Bind it to
//    the worker's real Env interface so `env.TENANT` et al. are typed.
import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
