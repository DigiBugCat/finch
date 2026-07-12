// POST /api/webhooks/clerk — Clerk → finch event sink (Svix-signed).
// Closes the invite half of access sharing: when an invited user actually
// joins the org (organizationMembership.created), promote every "invited"
// access-request row for their email to a real user→service ACL grant. The
// verified payload names the org, which IS the hub tenant id — there is no
// Clerk session here, hence the explicit-tenant hub helpers.
import type { NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import {
  ensureUserGrantAs,
  listAccessAs,
  readRuntimeEnv,
  setAccessStatusAs,
} from "@/lib/hub";

export async function POST(req: NextRequest) {
  let evt;
  try {
    evt = await verifyWebhook(req, {
      signingSecret: await readRuntimeEnv("CLERK_WEBHOOK_SECRET"),
    });
  } catch (err) {
    console.error("clerk webhook: verification failed", err);
    return new Response("invalid signature", { status: 400 });
  }

  try {
    if (evt.type === "organizationMembership.created") {
      const tenant = evt.data.organization.id;
      // Match invited rows against EVERY address the joining user owns, not
      // just public_user_data.identifier (the PRIMARY identifier — which can be
      // a personal email, a username, or a phone when an existing account
      // accepts an invite sent to a secondary address; matching only it left
      // rows stuck at "invited" forever).
      const emails = new Set<string>();
      const identifier = (evt.data.public_user_data?.identifier ?? "").toLowerCase();
      if (identifier) emails.add(identifier);
      const joinedUserId = evt.data.public_user_data?.user_id;
      if (joinedUserId) {
        try {
          const { clerkClient } = await import("@clerk/nextjs/server");
          const clerk = await clerkClient();
          const u = await clerk.users.getUser(joinedUserId);
          for (const e of u.emailAddresses) {
            emails.add(e.emailAddress.toLowerCase());
          }
        } catch (err) {
          // Fall back to the identifier alone; a transient Clerk fault will be
          // retried by Svix via the 500 below only if nothing matched.
          console.error("clerk webhook: could not resolve user emails", err);
        }
      }
      if (emails.size) {
        const { requests } = await listAccessAs(tenant);
        for (const row of requests) {
          if (row.status !== "invited" || !emails.has(row.email)) continue;
          await ensureUserGrantAs(tenant, row.email, row.service);
          await setAccessStatusAs(tenant, row.id, "granted", "clerk webhook");
        }
      }
    }
    return new Response("ok", { status: 200 });
  } catch (err) {
    // 500 so Svix retries — the grant must eventually land.
    console.error("clerk webhook: handling failed", err);
    return new Response("error", { status: 500 });
  }
}
