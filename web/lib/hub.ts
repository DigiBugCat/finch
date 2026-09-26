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
// web's only hub-backed surface is the `finch login` approval page (/cli), and
// its caller always acts as the owner of their own tenant.

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
 *  every request. */
export interface ResolvedTenant {
  tenant: string;
  userId: string;
  memberId: string;
  email: string;
  role: "owner" | "admin" | "member";
  isAdmin: boolean;
  /** The account a CLI token minted for this context acts as, for the
   *  approval screen. */
  account: { name: string; kind: "personal" | "team" };
}

async function readHubJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    throw new HttpError(502, "invalid response from hub");
  }
}

/** A tenant the signed-in user could act as: their personal tenant or one
 *  they actively own. */
interface Candidate {
  tenant: string;
  name: string;
  kind: "personal" | "team";
}

/** A hub-supplied display name if it is safe to show, else undefined. */
function displayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) return undefined;
  return name;
}

/**
 * The tenants other than their personal one that `userId` actively OWNS, in
 * the order the hub lists them.
 *
 * Asked of the hub's user-scoped /api/user/sync, the one place that knows
 * which tenants a user belongs to. Only its `tenants` list is read, never a
 * `tenant` pick: an older hub (full membership list) and a hub that has cut
 * workspaces both answer with the list, and the choice between the tenants is
 * made here from what they hold (see chooseTenant). Rows where the user is
 * not an active owner are dropped; co-owning a team counts as owning it.
 */
async function ownedTenants(userId: string): Promise<Candidate[]> {
  // No emails: this is a lookup, not an identity sync. An older hub binds
  // pending invitations for the emails it is sent, and there are none to bind.
  const res = await userFetch(userId, "/api/user/sync", {
    method: "POST",
    body: JSON.stringify({ emails: [] }),
  });
  if (!res.ok) throw new HttpError(res.status, "could not resolve your Finch account");
  const data = await readHubJson(res);
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.tenants)) {
    throw new HttpError(502, "invalid response from hub");
  }
  const owned: Candidate[] = [];
  for (const row of data.tenants) {
    if (
      !row || typeof row !== "object" ||
      row.tenantId === userId || !validTenantId(row.tenantId) ||
      row.role !== "owner" || row.state !== "active" ||
      owned.some((c) => c.tenant === row.tenantId)
    ) {
      continue;
    }
    owned.push({ tenant: row.tenantId, name: displayName(row.name) ?? row.tenantId, kind: "team" });
  }
  return owned;
}

/** True when `tenant` holds something its owner would lose track of: a
 *  service (and with it its boxes) or a finch_ key. */
async function holdsFleet(tenant: string): Promise<boolean> {
  const res = await hubFetchAs(tenant, "/api/state", { method: "GET" });
  if (!res.ok) throw new HttpError(res.status, "could not resolve your Finch account");
  const state = await readHubJson(res);
  if (
    !state || typeof state !== "object" ||
    !Array.isArray(state.services) || !Array.isArray(state.keys)
  ) {
    throw new HttpError(502, "invalid response from hub");
  }
  return state.services.length > 0 || state.keys.length > 0;
}

/**
 * The one tenant the signed-in user acts as. Workspace switching is gone, so
 * the choice must be deterministic and must never strand anyone's services
 * away from the CLI, which is now the only way to manage them:
 *
 * - Owns nothing beyond the personal tenant (almost everyone): the personal
 *   tenant, their Clerk user id, as before. Nothing is probed.
 * - Otherwise, whichever one of personal + owned holds services or keys. An
 *   empty team never displaces a personal tenant that holds the user's fleet,
 *   and a populated team wins over an empty personal tenant.
 * - None of them holds anything: the personal tenant, as before.
 * - More than one holds something: refuse rather than pick one silently.
 */
async function chooseTenant(userId: string): Promise<Candidate> {
  const personal: Candidate = { tenant: userId, name: userId, kind: "personal" };
  const owned = await ownedTenants(userId);
  if (owned.length === 0) return personal;
  const populated: Candidate[] = [];
  for (const candidate of [personal, ...owned]) {
    if (await holdsFleet(candidate.tenant)) populated.push(candidate);
  }
  if (populated.length === 0) return personal;
  if (populated.length === 1) return populated[0];
  const names = populated
    .map((c) => (c.kind === "personal" ? "your personal account" : `"${c.name}"`))
    .join(", ");
  throw new HttpError(
    409,
    `you own more than one Finch account with services or keys (${names}), ` +
      "and Finch now has one account per sign-in, so it cannot choose which one to log in to",
  );
}

/**
 * Resolve the signed-in Clerk user to one tenant (chooseTenant), then revalidate
 * their membership there with /api/member-context (request and response shape
 * unchanged). A tenant other than the personal one is accepted only for its
 * active owner, so a hub bug can never hand anyone else's tenant to this user.
 *
 * A personal tenant that has never been set up answers `needsBootstrap`; the
 * web then retries with the user's verified primary email, which makes the hub
 * create it with this user as its owner.
 */
async function resolveTenantUncached(): Promise<ResolvedTenant> {
  const { userId } = await auth();
  if (!userId) throw new HttpError(401, "unauthenticated");

  const chosen = await chooseTenant(userId);
  const tenant = chosen.tenant;
  let res = await hubFetchAs(tenant, "/api/member-context", {
    method: "POST",
    body: JSON.stringify({ clerkUserId: userId }),
  });
  if (!res.ok) throw new HttpError(res.status, "could not resolve your Finch account");
  let data = await readHubJson(res);
  if (!data || typeof data !== "object") throw new HttpError(502, "invalid response from hub");

  if (data.needsBootstrap === true && tenant === userId) {
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
  if (data.member === null) throw new HttpError(403, "not an active member of this account");
  if (typeof data.member !== "object" || Array.isArray(data.member)) {
    throw new HttpError(502, "invalid response from hub");
  }
  const { id, email, role, state } = data.member;
  if (
    typeof id !== "string" || !id ||
    typeof email !== "string" || !email ||
    (role !== "owner" && role !== "admin" && role !== "member") ||
    (state !== "active" && state !== "invited" && state !== "disabled")
  ) {
    throw new HttpError(502, "invalid response from hub");
  }
  if (state !== "active") throw new HttpError(403, "not an active member of this account");
  if (tenant !== userId && role !== "owner") {
    throw new HttpError(403, "not the owner of this account");
  }
  // A personal tenant's display name is just the Clerk user id, so it is
  // labelled with the member's email instead.
  const account = { name: chosen.kind === "personal" ? email : chosen.name, kind: chosen.kind };
  return { tenant, userId, memberId: id, email, role, isAdmin: role !== "member", account };
}
export const resolveTenant = process.env.NODE_ENV === "test" ? resolveTenantUncached : cache(resolveTenantUncached);

/** The resolved tenant, refusing a member without admin rights. */
export async function requireAdmin(): Promise<ResolvedTenant> {
  const ctx = await resolveTenant();
  if (!ctx.isAdmin) throw new HttpError(403, "admin role required");
  return ctx;
}


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
 * Like hubFetchAs, but signs a USER-scoped assertion (kind "user") naming the
 * Clerk user rather than a tenant. The hub accepts it only on its user-scoped
 * routes (here, /api/user/sync) and never as a tenant credential.
 */
export async function userFetch(
  clerkUserId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const hubUrl = await runtimeEnv("HUB_URL");
  const secret = await runtimeEnv("FINCH_SERVICE_SECRET");
  if (!hubUrl || !secret) throw new HttpError(500, "hub is not configured");
  const hubOrigin = normalizeHubUrl(hubUrl);
  validateHubRequestIdentity(clerkUserId, "Clerk user id");
  validateHubPath(path);
  const headers = new Headers(init.headers);
  headers.set("X-Finch-Service", secret);
  headers.set("X-Finch-Auth", await signAssertion(clerkUserId, secret, undefined, "user"));
  if (init.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
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
