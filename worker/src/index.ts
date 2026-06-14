/// <reference types="@cloudflare/workers-types" />
//
// Finch hub — the thin control plane. "We handle auth + routing + hosting,
// you handle the logic." This Worker authenticates (TODO: WorkOS + finch
// keys), then routes every request under /{id}/... to that appliance's
// Durable Object, which holds a hibernatable WebSocket to the box.

import { ApplianceDO } from "./appliance-do";

export { ApplianceDO };

export interface Env {
  APPLIANCE: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 0) {
      return new Response("finch hub — https://finchmcp.com\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // TODO(auth): before routing, terminate Clerk auth + finch-key auth here
    // (Clerk for human/owner identity + OAuth; finch_ keys for agent/tool
    // calls), resolve identity, inject X-Finch-User. The appliance app stays
    // auth-free and just reads the header.

    const id = parts[0];
    // One Durable Object per appliance id. The DO owns the agent's WebSocket,
    // online/offline state, and request/response correlation.
    const stub = env.APPLIANCE.get(env.APPLIANCE.idFromName(id));
    return stub.fetch(req);
  },
};
