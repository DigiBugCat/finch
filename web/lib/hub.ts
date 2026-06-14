// lib/hub.ts — server-only bridge to the Finch hub control plane.
//
// The hub (../worker) is the source of truth. Its /api/* surface is
// service-secret authed and tenant-scoped:
//   X-Finch-Service: <FINCH_SERVICE_SECRET>   (must equal the hub's)
//   X-Finch-Auth:    <signed {tenant,exp}>     (HMAC-SHA256 with the SAME secret)
//
// The service secret proves "a first-party web worker is calling"; the SIGNED
// assertion cryptographically binds WHICH tenant the request acts as. We no
// longer send a raw, unsigned X-Finch-Tenant — the hub ignores it and trusts
// only the HMAC-signed assertion, so a leaked service secret alone can't be
// replayed for an arbitrary tenant.
//
// This module centralizes (a) resolving the tenant from the Clerk session and
// (b) calling the hub with the right headers. Route handlers stay thin.

import "server-only";
import { auth } from "@clerk/nextjs/server";

/** TTL of a signed tenant assertion (seconds). Short — each hub call mints a
 *  fresh one; this only bounds clock-skew tolerance / replay window. */
const ASSERTION_TTL_SECONDS = 120;

const te = new TextEncoder();

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign a {tenant,exp} assertion with the shared service secret (HMAC-SHA256).
 *  Wire format mirrors the hub's verifyAssertion: b64url(JSON) "." b64url(sig). */
async function signAssertion(
  tenant: string,
  secret: string,
): Promise<string> {
  const payload = {
    tenant,
    exp: Math.floor(Date.now() / 1000) + ASSERTION_TTL_SECONDS,
  };
  const body = bytesToB64url(te.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(body));
  return body + "." + bytesToB64url(new Uint8Array(sig));
}

/** A thrown HttpError short-circuits a route handler with a JSON response. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Read a runtime var from the Cloudflare env (OpenNext) or process.env.
 *  Under `next dev` getCloudflareContext throws/has no env, so we fall back. */
async function runtimeEnv(name: string): Promise<string | undefined> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = getCloudflareContext().env as Record<string, unknown>;
    const v = env?.[name];
    if (typeof v === "string" && v.length) return v;
  } catch {
    // not running under the Cloudflare adapter (e.g. `next dev`) — fall through
  }
  const pv = process.env[name];
  return typeof pv === "string" && pv.length ? pv : undefined;
}

/** What resolveTenant() returns: the tenant id plus the caller's identity and
 *  org role so handlers can authorize without re-calling Clerk. */
export interface ResolvedTenant {
  /** The hub tenant id — the Clerk org id, or the user id with no active org. */
  tenant: string;
  /** The signed-in Clerk user id. */
  userId: string;
  /** The active Clerk org id, or null for a personal (no-org) tenant. */
  orgId: string | null;
  /** The caller's role in the active org (e.g. "org:admin"/"org:member"), or
   *  null when there's no org. A personal tenant has no org role but the lone
   *  user is implicitly the owner. */
  role: string | null;
  /** True when the caller may perform admin/mutating actions for this tenant:
   *  a personal (no-org) tenant's sole user, or an org admin/owner. */
  isAdmin: boolean;
}

function roleIsAdmin(role: string | null | undefined): boolean {
  return (
    role === "org:admin" ||
    role === "admin" ||
    role === "org:owner" ||
    role === "owner"
  );
}

/**
 * Resolve the current tenant + caller authorization from the Clerk session.
 * The tenant = the Clerk org id, or the user id if there's no active org.
 * Throws 401 (HttpError) when the request is unauthenticated.
 */
export async function resolveTenant(): Promise<ResolvedTenant> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) throw new HttpError(401, "unauthenticated");
  // No active org → personal tenant; the lone user owns it (implicit admin).
  // With an org, admin rights require an admin/owner role.
  const isAdmin = !orgId || roleIsAdmin(orgRole);
  return {
    tenant: orgId ?? userId,
    userId,
    orgId: orgId ?? null,
    role: orgRole ?? null,
    isAdmin,
  };
}

/**
 * Authorize a mutating request. Returns the resolved tenant when the caller may
 * act as an admin for it; otherwise throws 401 (unauthenticated) or 403
 * (member without admin rights). Call this at the top of every mutating route.
 *
 * Authorization model: a personal (no-org) tenant's sole user is always
 * authorized; in an org, only admins/owners may mutate. Members are read-only.
 */
export async function requireAdmin(): Promise<ResolvedTenant> {
  const ctx = await resolveTenant();
  if (!ctx.isAdmin) {
    throw new HttpError(403, "admin role required");
  }
  return ctx;
}

/**
 * Call the hub control API for the current tenant. Resolves the tenant from
 * the Clerk session, attaches the service secret + tenant headers, and fetches
 * `${HUB_URL}${path}`. Returns the raw Response (caller decides how to read it).
 */
export async function hubFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { tenant } = await resolveTenant();

  const hubUrl = await runtimeEnv("HUB_URL");
  const serviceSecret = await runtimeEnv("FINCH_SERVICE_SECRET");
  if (!hubUrl) throw new HttpError(500, "HUB_URL is not configured");
  if (!serviceSecret) {
    throw new HttpError(500, "FINCH_SERVICE_SECRET is not configured");
  }

  const headers = new Headers(init.headers);
  headers.set("X-Finch-Service", serviceSecret);
  // Bind the tenant cryptographically: sign {tenant,exp} with the service
  // secret. The hub verifies this and ignores any raw X-Finch-Tenant.
  headers.set("X-Finch-Auth", await signAssertion(tenant, serviceSecret));
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return fetch(`${hubUrl}${path}`, { ...init, headers });
}

/** Call the hub and pass its JSON body + status straight back to the client. */
export async function hubProxy(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await hubFetch(path, init);
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
    },
  });
}

/** Turn a thrown HttpError (or anything) into a JSON Response for a handler. */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : "internal error";
  return Response.json({ error: message }, { status: 500 });
}
