import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/** Clerk loads clerk-js from the frontend API encoded in the publishable key
 *  (pk_<test|live>_<base64 of "<host>$">). Derive it per build rather than
 *  allowlisting `https://*.clerk.accounts.dev`, which is a shared multi-tenant
 *  dev domain — that wildcard would let any other Clerk dev instance's script
 *  execute on this origin. Returns "" if the key is absent or malformed, in
 *  which case the directive simply omits a Clerk host. */
function clerkScriptOrigin(): string {
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
  const encoded = key.replace(/^pk_(test|live)_/, "");
  if (encoded === key || !encoded) return "";
  try {
    const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$+$/, "");
    return /^[a-z0-9.-]+$/i.test(host) && host.includes(".") ? `https://${host}` : "";
  } catch {
    return "";
  }
}

/**
 * Content-Security-Policy.
 *
 * WHAT THIS DOES AND DOES NOT DO — read before hardening further.
 *
 * `script-src` carries 'unsafe-inline' and that is FORCED, not lazy: Next 15.5.20
 * emits the RSC flight payload as content-dependent inline <script> tags
 * (`self.__next_f.push(...)`). They change with page content, so hashes are not
 * viable. So this policy does NOT stop injected script from EXECUTING.
 *
 * What it does buy is CONTAINMENT of an injected script:
 *   - connect-src is closed, so it cannot exfiltrate to an attacker host
 *   - base-uri 'self' blocks <base href> hijacking every relative script URL
 *   - object-src 'none' kills <object>/<embed> payloads
 *   - form-action 'self' blocks posting credentials to an attacker endpoint
 *   - frame-src is closed, and frame-ancestors 'none' keeps the one-click
 *     consent pages (/cli, /aviary/authorize) unframeable — see the note below,
 *     that one is load-bearing rather than defence in depth.
 *
 * A nonce-based 'strict-dynamic' policy WOULD stop execution and Next does
 * support it (app-render reads the CSP off the request and threads a nonce
 * through). It is deliberately not used: a nonce only exists per request, so the
 * nine statically prerendered /docs/* pages would ship build-time HTML whose
 * inline scripts carry no nonce and would render blank. Adopting it means making
 * every HTML route dynamic. Revisit if a genuine user-content sink ever lands;
 * today the only dangerouslySetInnerHTML is over build-time literals.
 */
function contentSecurityPolicy(): string {
  const clerk = clerkScriptOrigin();
  const withClerk = (...sources: string[]) =>
    [...sources, ...(clerk ? [clerk] : [])].join(" ");
  // `next dev` compiles with eval-based source maps and a HMR client that uses
  // eval, so a policy without 'unsafe-eval' breaks local development outright.
  // Production builds need no eval — Clerk's own CSP helper draws the same line
  // on NODE_ENV, and grep finds no eval/new Function in the installed Clerk
  // packages. Never let this leak into a production build.
  const dev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${withClerk(
      "'self'",
      "'unsafe-inline'",
      ...(dev ? ["'unsafe-eval'"] : []),
      "https://challenges.cloudflare.com",
    )}`,
    `connect-src ${withClerk(
      "'self'",
      "https://clerk-telemetry.com",
      "https://*.clerk-telemetry.com",
      "https://img.clerk.com",
    )}`,
    "img-src 'self' data: blob: https://img.clerk.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "frame-src 'self' https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

const nextConfig: NextConfig = {
  // Browsers that have reached Finch securely must never downgrade future
  // dashboard/API requests (including tenant subdomains) to plaintext HTTP.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          // FRAME DENIAL IS LOAD-BEARING, NOT HYGIENE. /cli and
          // /aviary/authorize are one-click consent screens seeded from a query
          // parameter, and approving /cli mints a ~30-day TENANT-ADMIN token
          // bound to the approver's workspace.
          //
          // SameSite does not protect them: every tenant gets
          // <slug>.finchmcp.com, and a service with auth "public" serves
          // arbitrary tenant HTML there with no login wall. An attacker framing
          // finchmcp.com from their own subdomain is therefore SAME-SITE — the
          // session cookie rides along whatever its SameSite value — and the
          // resulting POST is same-origin, so middleware's Sec-Fetch-Site guard
          // passes by design (it cannot see ancestor frames).
          //
          // frame-ancestors covers modern browsers; X-Frame-Options covers the
          // rest. Nothing in this app is framed, so 'none'/DENY costs nothing.
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
          { key: "X-Frame-Options", value: "DENY" },
          // Don't leak ?code= consent tokens or dashboard paths to third parties.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;

// Lets `next dev` use the Cloudflare bindings (env from .dev.vars / wrangler).
initOpenNextCloudflareForDev();
