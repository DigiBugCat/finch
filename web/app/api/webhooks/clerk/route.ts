import type { NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { HttpError, readRuntimeEnv, userFetch } from "@/lib/hub";
import { syncIdentity } from "@/lib/identity";
import { readBoundedBody } from "@/lib/request-body";

const norm = (value: string) => value.trim().toLowerCase();
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

function verifiedEmail(row: unknown): { id: string; email: string } | null {
  const value = record(row);
  const verification = record(value?.verification);
  if (verification?.status !== "verified" || !validId(value?.id)) return null;
  if (typeof value?.email_address !== "string") return null;
  const email = norm(value.email_address);
  const at = email.indexOf("@");
  if (
    email.length > 254 ||
    !EMAIL_RE.test(email) ||
    at <= 0 ||
    at > 64 ||
    email.length - at - 1 > 253
  ) return null;
  return { id: value.id, email };
}

export async function POST(req: NextRequest) {
  let event: unknown;
  try {
    const bytes = await readBoundedBody(req, MAX_WEBHOOK_BYTES);
    const verifiedRequest = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    });
    event = await verifyWebhook(verifiedRequest as unknown as NextRequest, { signingSecret: await readRuntimeEnv("CLERK_WEBHOOK_SECRET") });
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) {
      return new Response("webhook body too large", { status: 413 });
    }
    console.error("clerk webhook: verification failed", error);
    return new Response("invalid signature", { status: 400 });
  }
  try {
    const envelope = record(event);
    const type = envelope?.type;
    const data = record(envelope?.data);
    if (typeof type !== "string" || !data) return new Response("invalid event", { status: 400 });

    if (type === "user.created" || type === "user.updated") {
      if (!validId(data.id)) return new Response("invalid event", { status: 400 });
      const rows = data.email_addresses;
      if (!Array.isArray(rows) || rows.length > 100) {
        return new Response("invalid event", { status: 400 });
      }
      const verified = rows.map(verifiedEmail).filter((row) => row !== null);
      const emails = [...new Set(verified.map((row) => row.email))];
      if (!emails.length) return new Response("ok");
      const primary = verified.find((row) => row.id === data.primary_email_address_id);
      const res = await userFetch(data.id, "/api/user/sync", { method: "POST", body: JSON.stringify({ emails, ...(primary ? { primaryEmail: primary.email } : {}) }) });
      if (!res.ok) throw new Error(`hub sync failed: ${res.status}`);
    } else if (type === "organizationMembership.created") {
      const userId = record(data.public_user_data)?.user_id;
      const organizationId = record(data.organization)?.id;
      if (!validId(userId) || !validId(organizationId)) {
        return new Response("invalid event", { status: 400 });
      }
      const identity = await syncIdentity(userId);
      const res = await userFetch(userId, "/api/adapter/org-member", { method: "POST", body: JSON.stringify({ clerkOrgId: organizationId, clerkUserId: userId, ...identity }) });
      if (!res.ok) throw new Error(`org adapter failed: ${res.status}`);
    }
    return new Response("ok");
  } catch (error) {
    console.error("clerk webhook: handling failed", error);
    return new Response("error", { status: 500 });
  }
}
