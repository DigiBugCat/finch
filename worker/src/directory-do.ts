/// <reference types="@cloudflare/workers-types" />
//
// DirectoryDO — the global clerkUserId → tenant index. It was written by the
// retired team features (workspace creation, org claims, invitations, member
// changes); after the single-user cut the hub only READS it, to find the
// tenant a signed-in Clerk user OWNS (api.ts ownedTenants, which re-verifies
// every row against the TenantDO before trusting it).
//
// The stored u:/e:/org: keys are left exactly as they are — nothing is
// deleted. The write ops are gone, so an unknown op is a 400.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

type Membership = { tenantId: string; memberId: string; role: string; state: string };
const response = (body: unknown, status = 200) => Response.json(body, { status });

export class DirectoryDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return response({ error: "POST only" }, 405);
    let a: any;
    try { a = await req.json(); } catch { return response({ error: "invalid JSON" }, 400); }
    switch (a.op) {
      case "listForUser": {
        const rows = await this.ctx.storage.get<Membership[]>(`u:${a.clerkUserId}`);
        return response({ memberships: rows ?? [] });
      }
      default:
        return response({ error: `unknown op: ${a.op}` }, 400);
    }
  }
}
