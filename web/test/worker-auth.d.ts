// Type shim for the worker's auth module, imported by the assertion CONTRACT
// test. The real implementation lives in ../../worker/src/auth.ts and is loaded
// at RUNTIME by vitest (via the `@worker-auth` alias in vitest.config.ts). We
// do NOT let web's `tsc` type-check the worker source directly: the worker
// compiles under @cloudflare/workers-types (lenient BufferSource), while web
// uses the DOM lib — the two clash on Uint8Array/BufferSource variance.
// Declaring the surface we use here keeps the contract test type-safe under
// web's tsconfig while the genuine worker code runs the actual HMAC at runtime.
declare module "@worker-auth" {
  export interface TenantAssertion {
    tenant: string;
    exp: number;
  }
  export function signAssertion(
    payload: TenantAssertion,
    secret: string,
  ): Promise<string>;
  export function verifyAssertion(
    token: string,
    secret: string,
  ): Promise<string | null>;
}
