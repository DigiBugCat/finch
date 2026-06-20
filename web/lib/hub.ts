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
// The assertion signer lives in its own dependency-free module so it can be
// contract-tested against the hub's verifyAssertion (worker/src/auth.ts).
import { signAssertion, signCliToken } from "./assertion";

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

/** True for a Clerk org admin membership role. Narrower than roleIsAdmin (no
 *  "owner" forms) — Clerk org memberships are only ever org:admin/org:member.
 *  Used by the user-management routes to guard the last-admin invariant. */
export function isClerkOrgAdmin(role: string | null | undefined): boolean {
  return role === "org:admin" || role === "admin";
}

/** Map the dashboard's role label (or a raw Clerk role) to a Clerk org role. */
export function toClerkOrgRole(role: string | undefined): "org:admin" | "org:member" {
  return role === "Admin" || role === "org:admin" ? "org:admin" : "org:member";
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

/** Mint a long-lived CLI token for the admin's tenant — the credential the
 *  `finch` CLI presents to /api/cli/*. Admin-only. Returns the token, the hub
 *  the CLI should target, and the expiry. The token is shown to the user once. */
export async function mintCliToken(): Promise<{
  token: string;
  hub: string;
  expiresAt: number;
}> {
  const ctx = await requireAdmin();
  const secret = await runtimeEnv("FINCH_SERVICE_SECRET");
  if (!secret) throw new HttpError(500, "FINCH_SERVICE_SECRET is not configured");
  const hub = (await runtimeEnv("HUB_URL")) || "https://finchmcp.com";
  const { token, expiresAt } = await signCliToken(ctx.tenant, secret);
  return { token, hub, expiresAt };
}

/** Throw 500 unless `hubUrl` is https: or a localhost/127.0.0.1 dev URL. Guards
 *  against a misconfigured cleartext HUB_URL leaking the service secret +
 *  signed assertion. Fail-closed: an unparseable URL is rejected too. */
function assertSecureHubUrl(hubUrl: string): void {
  let u: URL;
  try {
    u = new URL(hubUrl);
  } catch {
    throw new HttpError(500, "HUB_URL is not a valid URL");
  }
  if (u.protocol === "https:") return;
  const isLocalhost =
    u.hostname === "localhost" ||
    u.hostname === "127.0.0.1" ||
    u.hostname === "[::1]" ||
    u.hostname === "::1";
  if (u.protocol === "http:" && isLocalhost) return;
  throw new HttpError(500, "HUB_URL must be https (or http on localhost)");
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
  // FAIL CLOSED on a non-https HUB_URL. We send the X-Finch-Service root secret
  // and a signed tenant assertion on every call — a misconfigured cleartext
  // override would leak them on the wire. Allow https: always, and plain http
  // only for a localhost/127.0.0.1 dev hub. Reject everything else regardless
  // of how HUB_URL was set.
  assertSecureHubUrl(hubUrl);

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

/** Admin-only passthrough: require admin, then forward the request body to a
 *  hub path verbatim. Collapses the handful of routes that are pure proxies
 *  (acl, enroll, keys, settings, tags) into one call + a try/catch. */
export async function adminProxy(
  req: Request,
  hubPath: string,
  method: string,
): Promise<Response> {
  await requireAdmin();
  return hubProxy(hubPath, { method, body: await req.text() });
}

/** Turn a thrown HttpError (or anything) into a JSON Response for a handler.
 *  Expected errors (HttpError, incl. our 4xx) keep their structured message so
 *  the UI can surface it. Anything else is an unexpected 500 — log the real
 *  message server-side, but return a generic body so we never leak raw
 *  exception text (stack-adjacent details, secrets in messages) to clients. */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error("finch bridge: unhandled error", err);
  return Response.json({ error: "internal error" }, { status: 500 });
}
