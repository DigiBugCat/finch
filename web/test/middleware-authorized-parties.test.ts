// REGRESSION: middleware.ts called clerkMiddleware(handler) with no options, so
// authorizedParties was undefined and @clerk/backend's
// assertAuthorizedPartiesClaim short-circuits on an empty list — the `azp` claim
// naming the origin a session token was minted for was NEVER validated. Every
// tenant gets <slug>.finchmcp.com and a service with auth "public" serves
// arbitrary tenant HTML there, so an attacker owns a cookie-sharing sibling
// origin: mint a session JWT there, exfiltrate it, replay it server-side with
// `Sec-Fetch-Site: same-origin` (which the CSRF guard accepts by design) against
// POST /api/finch/cli-token, and you hold a ~30-day tenant-admin credential for
// the victim's workspace. The azp pin is the only thing that separates those two
// origins, so it is asserted here rather than left to review.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

// Capture what middleware.ts hands clerkMiddleware without running Clerk.
let capturedOptions: unknown;
vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (handler: unknown, options: unknown) => {
    capturedOptions = options;
    return handler;
  },
  createRouteMatcher: () => () => false,
}));

/** Load middleware.ts fresh under the given env and resolve the options Clerk
 *  would see for a request. The options are a callback (the Cloudflare env is
 *  bound per request under OpenNext), so it must be invoked, not read. */
async function optionsFor(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  capturedOptions = undefined;
  vi.resetModules();
  await import("@/middleware");
  expect(typeof capturedOptions).toBe("function");
  return await (capturedOptions as (req: NextRequest) => Promise<unknown> | unknown)(
    new Request("https://finchmcp.com/dashboard") as unknown as NextRequest,
  ) as { authorizedParties?: string[] };
}

const ENV_KEYS = [
  "NEXT_PUBLIC_APP_ORIGIN",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]] as const));

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("clerkMiddleware authorizedParties", () => {
  it("pins a non-empty, non-wildcard origin on a pk_live instance", async () => {
    const options = await optionsFor({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsuZmluY2htY3AuY29tJA",
    });

    const parties = options.authorizedParties;
    expect(Array.isArray(parties)).toBe(true);
    expect(parties!.length).toBeGreaterThan(0);
    for (const party of parties!) {
      // A wildcard is as good as unset: *.finchmcp.com matches every tenant slug.
      expect(party).not.toContain("*");
      expect(new URL(party).origin).toBe(party); // exact origin, no path
      expect(new URL(party).protocol).toBe("https:");
    }
    expect(parties).toContain("https://finchmcp.com");
  });

  it("prefers the per-env configured origin so staging/dev are not pinned to prod", async () => {
    const options = await optionsFor({
      NEXT_PUBLIC_APP_ORIGIN: "https://finch-web-staging.example.workers.dev",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abc",
    });
    expect(options.authorizedParties).toEqual([
      "https://finch-web-staging.example.workers.dev",
    ]);
  });

  it("leaves an unconfigured dev instance on Clerk's default", async () => {
    // pk_test's frontend API is on accounts.dev, so no tenant host is same-site
    // with it; pinning a guessed origin here would break local dev instead.
    const options = await optionsFor({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abc",
    });
    expect(options.authorizedParties).toBeUndefined();
  });
});
