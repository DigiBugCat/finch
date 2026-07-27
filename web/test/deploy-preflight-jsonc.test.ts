import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseJsonc, stripJsoncComments } from "@/scripts/jsonc.mjs";

describe("deploy preflight JSONC parser", () => {
  it("preserves comment markers inside quoted values while removing real comments", () => {
    const parsed = parseJsonc(`{
      // line comment
      "url": "https://example.com/a//b",
      "note": "keep // this /* too */ after text",
      "escaped": "quote: \\\" // still quoted",
      /* block
         comment */
      "enabled": true
    }`);
    expect(parsed).toEqual({
      url: "https://example.com/a//b",
      note: "keep // this /* too */ after text",
      escaped: 'quote: " // still quoted',
      enabled: true,
    });
  });

  it("rejects an unterminated block comment", () => {
    expect(() => stripJsoncComments('{"ok":true} /*')).toThrow(/unterminated/i);
  });

  it("keeps production telemetry and workers.dev deployment invariants pinned", () => {
    const config = parseJsonc(readFileSync(resolve(import.meta.dirname, "../wrangler.jsonc"), "utf8"));
    const production = config.env.production;
    expect(production.observability.enabled).toBe(false);
    expect(production.logpush).toBe(false);
    expect(production.workers_dev).toBe(false);
  });

  it("pins the production Clerk azp audience to the exact app origin", () => {
    // deploy-preflight.mjs fails closed on this var; the value itself is the
    // one middleware.ts passes as authorizedParties, and a wildcard there would
    // re-admit tokens minted on a tenant's <slug>.finchmcp.com.
    const config = parseJsonc(readFileSync(resolve(import.meta.dirname, "../wrangler.jsonc"), "utf8"));
    const origin = config.env.production.vars.NEXT_PUBLIC_APP_ORIGIN;
    expect(origin).toBe("https://finchmcp.com");
    expect(origin).not.toContain("*");
  });
});

// REGRESSION: the app shipped no frame protection at all — only HSTS. /cli and
// /aviary/authorize are one-click consent screens seeded from ?code=, and
// approving /cli mints a ~30-day TENANT-ADMIN token bound to the approver's
// workspace. SameSite offered no protection because every tenant gets
// <slug>.finchmcp.com and can serve arbitrary HTML there, so an attacker's
// frame is SAME-SITE; the resulting POST is same-origin, so middleware's
// Sec-Fetch-Site guard passes by design. Unauthenticated attacker + one victim
// click = tenant takeover, which is why these headers are load-bearing.
describe("security response headers", () => {
  it("denies framing on every route, for modern and legacy browsers", async () => {
    const { default: nextConfig } = await import("@/next.config");
    const rules = await nextConfig.headers!();
    const all = rules.find((r: any) => r.source === "/:path*");
    if (!all) throw new Error("no header rule covering /:path*");

    const byKey = new Map<string, string>(
      all.headers.map((h: any) => [h.key.toLowerCase(), h.value]),
    );
    expect(byKey.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(byKey.get("x-frame-options")).toBe("DENY");
    expect(byKey.get("strict-transport-security")).toContain("max-age=");
    expect(byKey.get("referrer-policy")).toBeTruthy();
    expect(byKey.get("x-content-type-options")).toBe("nosniff");
  });
});
