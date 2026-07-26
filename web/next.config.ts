import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

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
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
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
