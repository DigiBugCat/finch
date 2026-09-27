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
// (b) calling the hub with the right headers. Route handlers stay thin. The
// web's only hub-backed surface is the `finch login` approval page (/cli).
//
// Tenancy is single-user: a signed-in Clerk user's tenant is exactly their
// Clerk user id, and they are its owner. There is nothing to choose between
// and no other tenant the web ever signs for.

import "server-only";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { cache } from "react";
// The assertion signer lives in its own dependency-free module so it can be
// contract-tested against the hub's verifyAssertion (worker/src/auth.ts).
import { signAssertion } from "./assertion";


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

/** The subset of a Cloudflare service binding (Fetcher) the hub bridge uses. */
interface HubBinding {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** The FINCH_HUB service binding from the Cloudflare env, or undefined when
 *  not running under the adapter or the env doesn't bind it. */
async function hubBinding(): Promise<HubBinding | undefined> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = getCloudflareContext().env as Record<string, unknown>;
    const binding = env?.FINCH_HUB as Partial<HubBinding> | undefined;
    if (binding && typeof binding.fetch === "function") return binding as HubBinding;
  } catch {
    // not running under the Cloudflare adapter — no binding
  }
  return undefined;
}

const TENANT_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** True for a string the hub accepts as a tenant (or Clerk user) id. */
function validTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_RE.test(value);
}

/** The signed-in user's Finch tenant context, revalidated against the hub on
 *  every request. `tenant` is always the Clerk user id. */
export interface ResolvedTenant {
  tenant: string;
  userId: string;
  memberId: string;
  email: string;
}

async function readHubJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    throw new HttpError(502, "invalid response from hub");
  }
}

/**
 * Resolve the signed-in Clerk user to their tenant — their own Clerk user id —
 * and confirm with the hub's /api/member-context that they are its owner.
 *
 * A tenant that has never been set up answers `needsBootstrap`; the web then
 * retries with the user's verified primary email, which makes the hub create
 * the owner row for this user.
 */
async function resolveTenantUncached(): Promise<ResolvedTenant> {
  const { userId } = await auth();
  if (!userId) throw new HttpError(401, "unauthenticated");
  const tenant = userId;

  let res = await hubFetchAs(tenant, "/api/member-context", {
    method: "POST",
    body: JSON.stringify({ clerkUserId: userId }),
  });
  if (!res.ok) throw new HttpError(res.status, "could not resolve your Finch account");
  let data = await readHubJson(res);
  if (!data || typeof data !== "object") throw new HttpError(502, "invalid response from hub");

  if (data.needsBootstrap === true) {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(userId);
    const verified = user.emailAddresses.filter((e) => e.verification?.status === "verified");
    const primary = verified.find((e) => e.id === user.primaryEmailAddressId) ?? verified[0];
    if (!primary) throw new HttpError(403, "verify your email to finish setting up your account");
    res = await hubFetchAs(tenant, "/api/member-context", {
      method: "POST",
      body: JSON.stringify({ clerkUserId: userId, email: primary.emailAddress }),
    });
    if (!res.ok) throw new HttpError(res.status, "could not set up your Finch account");
    data = await readHubJson(res);
  }

  if (!data || typeof data !== "object" || !("member" in data)) {
    throw new HttpError(502, "invalid response from hub");
  }
  if (data.member === null) throw new HttpError(403, "not the owner of this account");
  if (typeof data.member !== "object" || Array.isArray(data.member)) {
    throw new HttpError(502, "invalid response from hub");
  }
  const { id, email, role, state } = data.member;
  // The hub reports exactly one kind of member: the active owner. Anything
  // else is a hub that does not speak this contract, so fail closed.
  if (
    typeof id !== "string" || !id ||
    typeof email !== "string" || !email ||
    role !== "owner" || state !== "active"
  ) {
    throw new HttpError(502, "invalid response from hub");
  }
  return { tenant, userId, memberId: id, email };
}
export const resolveTenant = process.env.NODE_ENV === "test" ? resolveTenantUncached : cache(resolveTenantUncached);


/** Return a canonical origin, or throw unless `hubUrl` is https: or a
 *  localhost/127.0.0.1 dev URL. Credentials and URL suffixes are refused so
 *  every authenticated request is built against an unambiguous origin. */
function normalizeHubUrl(hubUrl: string): string {
  let u: URL;
  try {
    u = new URL(hubUrl);
  } catch {
    throw new HttpError(500, "HUB_URL is not a valid URL");
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) {
    throw new HttpError(500, "HUB_URL must be an origin without credentials, path, query, or fragment");
  }
  if (u.protocol === "https:") return u.origin;
  const isLocalhost =
    u.hostname === "localhost" ||
    u.hostname === "127.0.0.1" ||
    u.hostname === "[::1]" ||
    u.hostname === "::1";
  if (u.protocol === "http:" && isLocalhost) return u.origin;
  throw new HttpError(500, "HUB_URL must be https (or http on localhost)");
}

function validateHubRequestIdentity(value: string, label: string): void {
  if (!validTenantId(value)) throw new HttpError(500, `invalid ${label}`);
}

function validateHubPath(path: string): void {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("#") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new HttpError(500, "invalid hub path");
  }
  const rawPathname = path.split("?", 1)[0];
  for (const rawSegment of rawPathname.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      throw new HttpError(500, "invalid hub path");
    }
    // WHATWG URLs normalize literal and percent-encoded dot segments, and
    // treat backslashes as separators. Refuse both so a nominal /api/* call
    // cannot be rewritten to another endpoint. Percent-encoded forward slashes
    // remain allowed because stable resource ids intentionally contain them.
    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(segment)
    ) {
      throw new HttpError(500, "invalid hub path");
    }
  }
}

/**
 * Call the hub control API as `tenant`: attach the service secret and a signed
 * assertion for that tenant, and fetch `${HUB_URL}${path}` — over the FINCH_HUB
 * service binding when deployed (see fetchHubNoRedirect). Returns the raw
 * Response (caller decides how to read it). Pass only a tenant the server
 * resolved itself (resolveTenant), never one taken from a request body.
 */
export async function hubFetchAs(
  tenant: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
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
  const hubOrigin = normalizeHubUrl(hubUrl);
  validateHubRequestIdentity(tenant, "tenant id");
  validateHubPath(path);

  const headers = new Headers(init.headers);
  headers.set("X-Finch-Service", serviceSecret);
  // Bind the tenant cryptographically: sign {tenant,exp} with the service
  // secret. The hub verifies this and ignores any raw X-Finch-Tenant.
  headers.set("X-Finch-Auth", await signAssertion(tenant, serviceSecret));
  if (init.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  // Control endpoints must never redirect: custom auth headers can otherwise
  // cross a trust boundary depending on the runtime's redirect implementation.
  return fetchHubNoRedirect(`${hubOrigin}${path}`, { ...init, headers });
}

/**
 * Fetch the hub with redirect-following disabled.
 *
 * `redirect: "error"` is NOT implemented by workers.dev's runtime — workerd
 * throws `TypeError: Invalid redirect value…` at call time, which took the
 * whole bridge down in production. `redirect: "manual"` is the supported way
 * to refuse to follow: the 3xx comes back as an ordinary response, headers
 * intact and never replayed to the redirect target, and we reject it here.
 * That preserves the guarantee the "error" mode was chosen for — our service
 * secret and signed assertion never cross an origin the hub didn't answer on.
 *
 * Deployed, the request rides the FINCH_HUB service binding (wrangler.jsonc):
 * it is handed straight to the hub Worker's fetch handler, never touching DNS,
 * the zone's routes or the public internet. The URL is still `${HUB_URL}${path}`
 * because the hub reads its own host from it (e.g. the `hub` origin cli-mint
 * returns). Only without a binding (`next dev`, unit tests) does this fall back
 * to a public fetch of the same URL.
 */
async function fetchHubNoRedirect(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const hub = await hubBinding();
  const request: RequestInit = { ...init, redirect: "manual" };
  const response = hub ? await hub.fetch(url, request) : await fetch(url, request);
  if (response.status >= 300 && response.status < 400) {
    throw new HttpError(502, "hub returned a redirect");
  }
  return response;
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
