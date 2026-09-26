import { vi } from "vitest";

// The key OpenNext's worker entrypoint (and initOpenNextCloudflareForDev) sets
// the per-request context under; getCloudflareContext() reads it back from
// globalThis. Installing it here lets tests run the REAL getCloudflareContext
// instead of mocking the module.
const CLOUDFLARE_CONTEXT = Symbol.for("__cloudflare-context__");

/** Install a Cloudflare context whose env is `env`, the way the deployed worker
 *  does. Returns a function that restores whatever was there before. */
export function installCloudflareContext(env: Record<string, unknown>): () => void {
  const scope = globalThis as unknown as Record<symbol, unknown>;
  const previous = scope[CLOUDFLARE_CONTEXT];
  scope[CLOUDFLARE_CONTEXT] = {
    env,
    cf: undefined,
    ctx: { waitUntil() {}, passThroughOnException() {}, props: {} },
  };
  return () => {
    if (previous === undefined) delete scope[CLOUDFLARE_CONTEXT];
    else scope[CLOUDFLARE_CONTEXT] = previous;
  };
}

/** A fetch double that enforces the arguments workerd enforces, for both the
 *  global fetch and a service binding's Fetcher.fetch: the URL must be absolute,
 *  and `redirect` must be "follow" or "manual" — workerd throws a TypeError on
 *  "error" (the production outage fixed in #37 hid behind a mock that accepted
 *  it). `respond` sees the validated URL and init. */
export function workerdFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  return vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)).href; // throws on a relative URL
    const redirect = init.redirect ?? "follow";
    if (redirect !== "follow" && redirect !== "manual") {
      throw new TypeError(
        `Invalid redirect value, must be one of "follow" or "manual" ("${redirect}" won't be implemented since it does not make sense at the edge; use "manual" instead).`,
      );
    }
    return respond(url, init);
  });
}
