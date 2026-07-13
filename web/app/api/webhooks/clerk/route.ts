import type { NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { readRuntimeEnv, userFetch } from "@/lib/hub";
import { syncIdentity } from "@/lib/identity";

const norm = (value: string) => value.trim().toLowerCase();
export async function POST(req: NextRequest) {
  let event: any;
  try {
    event = await verifyWebhook(req, { signingSecret: await readRuntimeEnv("CLERK_WEBHOOK_SECRET") });
  } catch (error) {
    console.error("clerk webhook: verification failed", error);
    return new Response("invalid signature", { status: 400 });
  }
  try {
    if (event.type === "user.created" || event.type === "user.updated") {
      const verified = (event.data.email_addresses ?? []).filter((row: any) => row.verification?.status === "verified");
      const emails = [...new Set(verified.map((row: any) => norm(row.email_address)))];
      if (!emails.length) return new Response("ok");
      const primary = verified.find((row: any) => row.id === event.data.primary_email_address_id);
      const res = await userFetch(event.data.id, "/api/user/sync", { method: "POST", body: JSON.stringify({ emails, ...(primary ? { primaryEmail: norm(primary.email_address) } : {}) }) });
      if (!res.ok) throw new Error(`hub sync failed: ${res.status}`);
    } else if (event.type === "organizationMembership.created") {
      const userId = event.data.public_user_data?.user_id;
      if (!userId) return new Response("ok");
      const identity = await syncIdentity(userId);
      const res = await userFetch(userId, "/api/adapter/org-member", { method: "POST", body: JSON.stringify({ clerkOrgId: event.data.organization.id, clerkUserId: userId, ...identity }) });
      if (!res.ok) throw new Error(`org adapter failed: ${res.status}`);
    }
    return new Response("ok");
  } catch (error) {
    console.error("clerk webhook: handling failed", error);
    return new Response("error", { status: 500 });
  }
}
