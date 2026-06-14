import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;

// Lets `next dev` use the Cloudflare bindings (env from .dev.vars / wrangler).
initOpenNextCloudflareForDev();
