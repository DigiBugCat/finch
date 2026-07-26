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
        ],
      },
    ];
  },
};

export default nextConfig;

// Lets `next dev` use the Cloudflare bindings (env from .dev.vars / wrangler).
initOpenNextCloudflareForDev();
