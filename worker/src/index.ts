/// <reference types="@cloudflare/workers-types" />
//
// Finch hub — the thin control plane. "We handle auth + routing + hosting,
// you handle the logic." This Worker resolves the tenant, then either:
//   - serves the control API (/api/*, /join) — see api.ts
//   - relays MCP / agent traffic to the per-BOX BoxDO, gated by a
//     finch_ key check against the tenant's TenantDO.
//
// Tenancy: every request belongs to a tenant, and a tenant is one Clerk user
// (its id is their Clerk user id).
//   - Control-plane requests (from the web app) carry a signed assertion naming
//     the tenant id, so control-plane TenantDOs are keyed by it.
//   - MCP / relay traffic carries only a vanity HOST slug (<slug>.finchmcp.com),
//     which is NOT the tenant id. The relay resolves the slug to the tenant id
//     via the singleton RouterDO (slug→tenantId index) and keys TenantDO +
//     BoxDO by THAT tenant id. Unknown slug FAILS CLOSED (404). The
//     DEFAULT_TENANT fallback exists ONLY for local dev (env.DEV === "1").

import { BoxDO, readBoundedBody } from "./box-do";
import { TenantDO } from "./tenant-do";
import { RouterDO, routerLookup } from "./router-do";
import { handleApi, isApiPath, isLoopbackHost } from "./api";
import { installScript } from "./install-script";
import {
  hashKey,
  verifyToken,
  serviceOk,
  verifyAssertion,
  verifyClerkOAuthToken,
  callerAssertionsConfigured,
  callerAssertionJwks,
  selfTestCallerAssertion,
  signCallerAssertion,
} from "./auth";
import type { CallerAssertionClaims, CallerAuthMethod } from "./auth";

// AviaryEnrollmentDO and DirectoryDO are gone: wrangler migration v7 deletes
// both classes and their stored data (see wrangler.jsonc).
export { BoxDO, TenantDO, RouterDO };

export interface Env {
  // Durable Object namespaces.
  BOX: DurableObjectNamespace; // per-box WS relay (BoxDO)
  TENANT: DurableObjectNamespace; // per-tenant control-plane state (TenantDO)
  ROUTER: DurableObjectNamespace; // singleton slug→tenantId index (RouterDO)

  // Secrets / vars (wrangler vars in dev via .dev.vars; secrets in prod).
  FINCH_SERVICE_SECRET: string; // web-app -> control API shared secret
  TICKET_SECRET: string; // HMAC key for join tickets + per-box connect-tokens
  DEFAULT_TENANT?: string; // DEV-ONLY tenant fallback when no slug resolves
  DEV?: string; // "1" in the dev env; gates the DEFAULT_TENANT fallback
  // Explicit local-test escape hatch for plain HTTP. It is effective only when
  // DEV=1 as well; production and staging intentionally omit both values, so
  // the public hub fails closed before reading an unencrypted request body.
  ALLOW_INSECURE_HTTP?: string;
  WEB_URL?: string; // web base URL — the `finch login` device page lives at <WEB_URL>/cli
  CLERK_ISSUER?: string; // Clerk OAuth AS base (e.g. https://<slug>.clerk.accounts.dev) — enables the MCP OAuth plane (RFC 9728 discovery + Clerk-token bearers); unset = feature off
  CLERK_USERINFO?: Fetcher; // optional service binding; tests/local deployments may avoid public userinfo fetches
  // ES256 caller assertions injected into requests after Finch authenticates
  // them. PRIVATE_JWKS is a secret JSON JWKS containing one or more EC P-256
  // private keys; ACTIVE_KID selects the current signer. Keeping old keys in
  // the set publishes them from /.well-known/finch-jwks.json during rotation.
  FINCH_ASSERTION_PRIVATE_JWKS?: string;
  FINCH_ASSERTION_ACTIVE_KID?: string;
  FINCH_ASSERTION_ISSUER?: string;
  VANITY_SUFFIXES?: string; // comma-separated first-party custom-hostname suffixes, e.g. "aviary.run"
  VANITY_TENANT?: string; // only this tenant may claim VANITY_SUFFIXES hostnames
  CF_API_TOKEN?: string; // secret: Cloudflare for SaaS API token (never log)
  CF_SAAS_ZONE_ID?: string; // finchmcp.com zone id for SaaS custom-hostname provisioning
  BYO_CNAME_TARGET?: string; // CNAME target shown to BYO-domain customers
  // Self service-binding: POST /api/cli/call relays an MCP call back through
  // our own public relay path (a direct fetch to our own host is blocked).
  SELF: Fetcher;

  // Agent release binaries, served directly at GET /releases/<asset> (uploaded
  // by the release workflow). Preferred over RELEASES_BASE: the repo is private,
  // so a GitHub redirect 404s for anonymous callers.
  RELEASES?: R2Bucket;

  // Fallback redirect target for GET /releases/<asset> when the RELEASES
  // binding is absent (local dev, tests). Defaults to the project's GitHub
  // Releases "latest" assets.
  RELEASES_BASE?: string;

  // Cloudflare Rate Limiting bindings (unsafe.bindings ratelimit). Optional so
  // tests / `wrangler dev` without the binding still run (limiter() no-ops when
  // absent). RELAY_LIMIT gates per-(tenant,IP) on the MCP relay BEFORE any DO
  // round-trip (box pin / route check / checkKey); its budget (600/60s) is sized for a
  // web page's sub-resource burst — one HTML hit fans out to many asset requests
  // that all share the (tenant,IP) bucket. JOIN_LIMIT gates per-IP on /join.
  RELAY_LIMIT?: RateLimiter;
  JOIN_LIMIT?: RateLimiter;
}

/** Cloudflare Rate Limiting binding surface (not in workers-types yet). */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/** Apply a rate limiter if bound; fail OPEN if the binding is absent (dev/test)
 *  so the limiter is purely additive. Returns true if the request is allowed. */
export async function rateLimitOk(
  limiter: RateLimiter | undefined,
  key: string,
): Promise<boolean> {
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true; // never fail a request because the limiter errored
  }
}

/** Best-effort client IP for rate-limit keying (Cloudflare-set header). */
export function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for") ||
    "unknown"
  );
}

/** Finch's public transport boundary. Cloudflare normally presents production
 * requests as HTTPS/WSS, but enforcing that assumption here prevents a route,
 * zone, or client misconfiguration from silently turning plain HTTP into an
 * accepted relay path. The escape hatch exists only for local dev and isolated
 * tests; deploy preflight forbids it in staging/production. */
export function secureTransport(req: Request, env: Env): boolean {
  const url = new URL(req.url);
  if (url.protocol === "https:") return true;
  if (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1"
  ) {
    return true;
  }
  return env.DEV === "1" && env.ALLOW_INSECURE_HTTP === "1";
}

// Max relay request body we'll buffer into a DO (#16 / security L9). The DO
// buffers the whole body via req.text(); a few-MB cap keeps concurrent POSTs
// from summing past DO heap. Enforced here pre-stub AND in BoxDO.fetch.
const MAX_RELAY_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB

// Max body accepted by the legacy /register fallback. That branch runs BEFORE
// tenant resolution and RELAY_LIMIT, so it is the cheapest unauthenticated path
// into this Worker; RFC 7591 client metadata is a handful of fields.
const MAX_DCR_BODY_BYTES = 64 * 1024; // 64 KiB

// Caller-controlled copies are removed before any relay authentication runs;
// only the Worker may inject this header after a successful auth decision.
const CALLER_ASSERTION_HEADER = "x-finch-assertion";
const CALLER_ASSERTION_TTL_SECONDS = 60;
const RESERVED_CALLER_IDENTITY_HEADERS = new Set([
  CALLER_ASSERTION_HEADER,
  "x-finch-caller",
  "x-finch-user",
  "x-finch-tenant",
  "x-finch-auth-method",
  "x-finch-session",
  "x-finch-principal",
]);

// Reserved BoxDO surfaces. The DO strips two path segments, so ANY relayed
// upstream whose first segment is one of these lands on a control surface
// instead of the hosted app. The authenticated _connect branch is the only
// legitimate way onto that surface; anything arriving at the generic relay with
// one of these as its upstream head is probing, so it 404s at the edge.
// (A two-segment /<service>/_connect used to slip past the parts[2] === "_connect"
// check — parts has no leading empty element — and hijack the agent socket.)
const RESERVED_BOX_UPSTREAM = new Set(["_connect", "_control"]);

function isReservedUpstream(upstream: string): boolean {
  const head = upstream.split("/").filter(Boolean)[0];
  return !!head && RESERVED_BOX_UPSTREAM.has(head);
}

function stripUntrustedCallerIdentity(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (
      RESERVED_CALLER_IDENTITY_HEADERS.has(name) ||
      name.startsWith("x-finch-identity-")
    ) {
      headers.delete(name);
    }
  }
}

interface RelayCaller {
  sub: string;
  authMethod: CallerAuthMethod;
  actor?: string;
  keyId?: string;
  keyLabel?: string;
}

function callerAssertionConfig(env: Env) {
  return {
    activeKid: env.FINCH_ASSERTION_ACTIVE_KID,
    privateJwks: env.FINCH_ASSERTION_PRIVATE_JWKS,
  };
}

/** Stable, tenant-scoped audience understood by AviaryMCP's FinchAuth. */
export function callerAssertionAudience(tenant: string, service: string): string {
  return `finch:${tenant}:${service}`;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function requestBodySha256(body: BufferSource | null): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    body ?? new Uint8Array(0),
  );
  return base64url(new Uint8Array(digest));
}

/** Inject a Worker-minted assertion, or preserve legacy behavior when the
 *  assertion feature is entirely unconfigured. A partial/broken config throws;
 *  callers convert that into a 503 rather than silently losing authentication. */
async function injectCallerAssertion(
  headers: Headers,
  req: Request,
  env: Env,
  tenant: string,
  service: string,
  caller: RelayCaller | null,
  upstreamPath: string,
  body: BufferSource | null,
): Promise<void> {
  stripUntrustedCallerIdentity(headers);
  if (!caller) return; // public/anonymous relay: never claim an authenticated identity
  const config = callerAssertionConfig(env);
  if (!callerAssertionsConfigured(config)) return; // backward-compatible rollout
  if (!env.FINCH_ASSERTION_ISSUER) {
    throw new Error("FINCH_ASSERTION_ISSUER is required");
  }
  const now = Math.floor(Date.now() / 1000);
  const claims: CallerAssertionClaims = {
    iss: env.FINCH_ASSERTION_ISSUER,
    sub: caller.sub,
    aud: callerAssertionAudience(tenant, service),
    tenant,
    service,
    auth_method: caller.authMethod,
    method: req.method.toUpperCase(),
    upstream_path: upstreamPath,
    // URL parsing removes dot segments and gives the exact public path seen by
    // the Worker. Query parameters are deliberately not copied into identity.
    public_path: new URL(req.url).pathname || "/",
    body_sha256: await requestBodySha256(body),
    iat: now,
    nbf: now - 5,
    exp: now + CALLER_ASSERTION_TTL_SECONDS,
    jti: crypto.randomUUID(),
    ...(caller.actor ? { actor: caller.actor } : {}),
    ...(caller.keyId ? { key_id: caller.keyId } : {}),
    ...(caller.keyLabel ? { key_label: caller.keyLabel } : {}),
  };
  headers.set(
    CALLER_ASSERTION_HEADER,
    await signCallerAssertion(claims, config),
  );
}

// Default target for GET /releases/<asset>: the project's GitHub Releases
// "latest" download URL. Overridable via env.RELEASES_BASE.
const DEFAULT_RELEASES_BASE =
  "https://github.com/DigiBugCat/finch/releases/latest/download";

// Allow-listed release asset names — gates /releases so it can never become an
// arbitrary R2 read or open redirect. Matches the installer's platform binary
// names plus the checksum manifest used for verified local-mode downloads.
const RELEASE_ASSET_RE =
  /^(?:checksums\.txt|finch-(darwin|linux)-(amd64|arm64|armv6|armv7))$/;

// The OAuth scopes the MCP resource actually needs — identity only.
// verifyClerkOAuthToken reads only sub/user_id from Clerk's userinfo, so
// `openid` covers verification; `offline_access` keeps connectors connected via
// refresh tokens. Advertised in BOTH the 401 WWW-Authenticate scope hint and
// the RFC 9728 scopes_supported (single const so the two can't drift). Without
// these, claude.ai falls back to requesting every scope the AS supports —
// including public/private metadata the hub never reads — which both bloats
// the consent screen and overgrants the issued token.
// No `email`: the relay authorizes an OAuth caller by Clerk user id alone (it
// must be the tenant owner), so nothing at the door reads an email any more.
// `offline_access` stays despite the MCP auth spec's SHOULD NOT: the v1 SDK
// (@modelcontextprotocol/sdk) sends the challenge scope to /authorize verbatim
// and never adds it itself, so dropping it would leave those connectors with no
// refresh token — a manual reconnect every time the access token expires.
const MCP_SCOPES = ["openid", "offline_access"];

/** Percent-decode a path segment, tolerating a malformed encoding (a raw "%"
 *  in a name would make decodeURIComponent throw). Falls back to the raw value
 *  so a bad encoding degrades to "wrong box" rather than a 500. */
function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** Extract the routing host key for an MCP/relay request.
 *  `<slug>.finchmcp.com` -> `<slug>` (legacy bare-slug key).
 *  Any other multi-label hostname -> the full lowercase hostname (custom host).
 *  Returns "" for apex/www finchmcp.com, workers.dev, localhost/IP literals,
 *  single-label hosts, and anything without a usable public hostname. */
export function hostKeyFromHost(host: string): string {
  let h = (host || "").trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end >= 0) h = h.slice(1, end);
  } else {
    h = h.split(":")[0];
  }
  if (!h || h === "localhost" || h.includes(":")) return "";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("127.")) return "";
  const labels = h.split(".");
  if (labels.length < 2 || labels.some((label) => !label)) return "";
  if (h === "finchmcp.com" || h === "www.finchmcp.com") return "";
  if (h === "workers.dev" || h.endsWith(".workers.dev")) return "";
  if (
    labels.length === 3 &&
    labels[1] === "finchmcp" &&
    labels[2] === "com"
  ) {
    const sub = labels[0];
    if (sub && sub !== "www") return sub;
    return "";
  }
  return h;
}

/** Resolve the tenant id for an MCP/relay request from the host key.
 *  host key -> RouterDO.lookup -> tenant id. FAILS CLOSED: an unknown key returns
 *  a null tenant (the caller turns that into a 404). The DEFAULT_TENANT fallback
 *  is consulted ONLY in dev (env.DEV === "1") so prod never silently falls back. */
async function resolveTenant(host: string, env: Env): Promise<string | null> {
  const key = hostKeyFromHost(host);
  if (key) {
    const tenant = await routerLookup(env, key);
    if (tenant) return tenant;
  }
  // No usable/registered host key (unregistered slug/custom host, apex, www, workers.dev,
  // localhost): fail closed in prod; dev-only DEFAULT_TENANT fallback otherwise.
  if (env.DEV === "1" && env.DEFAULT_TENANT) return env.DEFAULT_TENANT;
  return null;
}

/** Tenant DO stub for a tenant id. */
function tenantStub(env: Env, tenant: string) {
  return env.TENANT.get(env.TENANT.idFromName(tenant));
}

/** Per-box relay DO stub. Keyed `${tenant}:${service}:${box}`. */
export function boxStub(
  env: Env,
  tenant: string,
  service: string,
  box: string,
) {
  return env.BOX.get(
    env.BOX.idFromName(`${tenant}:${service}:${box}`),
  );
}

/** Small JSON helper. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Call a TenantDO op via its internal fetch RPC. */
export async function tenantOp<T = any>(
  env: Env,
  tenant: string,
  op: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await tenantStub(env, tenant).fetch("https://tenant/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...args }),
  });
  return (await res.json()) as T;
}

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Reject insecure requests before authentication and, critically, before
    // any handler reads or buffers a request body. We do not redirect POSTs:
    // doing so could encourage a client to send a credential or payload over
    // plaintext once before retrying securely.
    if (!secureTransport(req, env)) {
      return new Response(
        JSON.stringify({ error: "HTTPS is required" }),
        {
          status: 426,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        },
      );
    }

    const url = new URL(req.url);
    const host = req.headers.get("host") || url.host;
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);

    // Public verification material for Finch caller assertions. This contains
    // only EC public coordinates; private `d` values never leave the secret
    // binding. When signing is disabled for a backwards-compatible deployment,
    // the endpoint is absent rather than advertising an unusable empty set.
    if (path === "/.well-known/finch-jwks.json") {
      const config = callerAssertionConfig(env);
      if (!callerAssertionsConfigured(config)) {
        return json(404, { error: "caller assertions are not configured" });
      }
      try {
        // This is stronger than a shape check: it imports the configured active
        // private key, signs an internal fixed-scope token, and verifies it with
        // the exact public JWKS below. The helper caches success per isolate and
        // never exposes the token or private material.
        const activeKid = await selfTestCallerAssertion(
          config,
          env.FINCH_ASSERTION_ISSUER || "",
        );
        const body = callerAssertionJwks(config);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            "content-type": "application/jwk-set+json",
            "cache-control": "public, max-age=300",
            "x-finch-active-kid": activeKid,
          },
        });
      } catch (error) {
        console.error(
          "caller assertion JWKS unavailable",
          error instanceof Error ? error.message : String(error),
        );
        return json(503, { error: "caller assertion signer unavailable" });
      }
    }

    // ---- Control plane: /api/* and /join -> api.ts ----
    if (isApiPath(path)) {
      return handleApi(req, env, host);
    }

    if (parts.length === 0) {
      return new Response("finch hub — https://finchmcp.com\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // ---- GET /install — the curl|sh agent installer (unauthenticated; the
    //      pipe carries no key). This is the target of the enroll one-liner
    //      `curl -fsSL <host>/install | sh && finch join --ticket <tkt>`. It
    //      installs the `finch` binary onto PATH; the operator then runs the
    //      `finch join --ticket …` half that the install string appends. ----
    if (path === "/install" && req.method === "GET") {
      const scheme = isLoopbackHost(host) ? "http" : "https";
      return new Response(installScript(`${scheme}://${host}`), {
        status: 200,
        headers: {
          "content-type": "text/x-shellscript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // ---- GET /releases/<asset> — serve a published agent binary or its
    //      checksums.txt manifest. The installer fetches the platform binary;
    //      SDK local mode fetches both the binary and checksum manifest. Asset
    //      names are allow-listed (RELEASE_ASSET_RE), so this cannot expose an
    //      arbitrary R2 key or become an open redirect. A non-matching path
    //      falls through to normal routing. ----
    if (
      req.method === "GET" &&
      parts[0] === "releases" &&
      parts.length === 2 &&
      RELEASE_ASSET_RE.test(parts[1])
    ) {
      // Prefer the R2 bucket (binding RELEASES, uploaded by the release
      // workflow): the repo is private, so the GitHub redirect 404s for
      // anonymous callers — which silently broke the installer AND hub-pushed
      // updates. The redirect remains only as a fallback for envs without the
      // binding (local dev with RELEASES_BASE, tests).
      if (env.RELEASES) {
        const obj = await env.RELEASES.get(parts[1]);
        if (!obj) return json(404, { error: "release asset not found" });
        return new Response(obj.body, {
          headers: {
            "content-type":
              parts[1] === "checksums.txt"
                ? "text/plain; charset=utf-8"
                : "application/octet-stream",
            "content-length": String(obj.size),
            etag: obj.httpEtag,
            "cache-control": "public, max-age=300",
          },
        });
      }
      const base = (env.RELEASES_BASE || DEFAULT_RELEASES_BASE).replace(
        /\/+$/,
        "",
      );
      return Response.redirect(`${base}/${parts[1]}`, 302);
    }

    // ---- OAuth resource-server discovery (RFC 9728). OAuth-only MCP clients
    //      (claude.ai custom connectors) fetch this to find the authorization
    //      server (Clerk), dynamically register there, and run the code flow —
    //      the finch_ key plane is untouched. The path suffix names the
    //      protected resource (/.well-known/oauth-protected-resource/<svc>/mcp).
    //      Served only when CLERK_ISSUER is configured. ----
    if (
      req.method === "GET" &&
      parts[0] === ".well-known" &&
      parts[1] === "oauth-protected-resource" &&
      env.CLERK_ISSUER
    ) {
      const suffix = parts.slice(2).join("/");
      const body = JSON.stringify({
        resource: `https://${host}${suffix ? `/${suffix}` : ""}`,
        // Point straight at Clerk, the real authorization server. The client
        // fetches Clerk's own RFC 8414 metadata (registration_endpoint
        // included) and records Clerk's `issuer` — the same value Clerk stamps
        // on the authorization response as `iss` (RFC 9207). A finch-hosted AS
        // document with any other issuer fails that check and current MCP SDKs
        // abort the flow, so the hub serves no AS metadata of its own (only a
        // byte-for-byte legacy /register fallback, below). Clients that DCR without a `scope` get Clerk's
        // instance default_scopes (must include openid + email — an instance
        // setting, not something the hub can inject any more).
        // Trailing slash stripped: the pointer must equal Clerk's `issuer`.
        authorization_servers: [env.CLERK_ISSUER.replace(/\/+$/, "")],
        bearer_methods_supported: ["header"],
        // The scopes THIS resource actually needs — identity only. MCP clients
        // (claude.ai) request the scopes advertised here (or in the 401
        // challenge's scope hint) instead of everything the AS supports, so
        // the consent screen stops asking for profile/metadata that the hub
        // never reads (verifyClerkOAuthToken consumes only sub/user_id).
        scopes_supported: MCP_SCOPES,
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      });
    }

    // ---- Legacy DCR fallback. Some Claude builds ignore the discovered
    //      registration_endpoint and POST /register on the MCP resource's own
    //      origin. Forward those, byte for byte, to Clerk's registration
    //      endpoint so they still get a Clerk client_id. No scope injection any
    //      more: Clerk's instance default_scopes covers scope-less clients.
    //      This runs before tenant resolution and rate limiting, so the body
    //      is capped tight; a real RFC 7591 document is a few KB. ----
    if (
      req.method === "POST" &&
      parts.length === 1 &&
      parts[0] === "register" &&
      env.CLERK_ISSUER
    ) {
      let raw: Uint8Array | undefined;
      try {
        raw = await readBoundedBody(req, MAX_DCR_BODY_BYTES);
      } catch {
        return json(400, { error: "invalid request body" });
      }
      if (raw === undefined) return json(413, { error: "request body too large" });
      return fetch(`${env.CLERK_ISSUER.replace(/\/+$/, "")}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
        redirect: "manual",
      });
    }

    // ---- MCP / relay plane. Tenant id resolves from the host slug via the
    //      singleton RouterDO (slug→tenantId). FAIL CLOSED on an unknown slug. ----
    const tenant = await resolveTenant(host, env);
    if (!tenant) {
      return json(404, {
        error: "tenant could not be resolved from host",
        host,
      });
    }

    const service = parts[0];
    const second = parts[1];

    // The path segment is percent-ENCODED, but the control plane (api.ts /
    // tenant-do.ts) stores the box name DECODED. Decode at the edge so the
    // connect-token assertion (payload.box === box) and the BoxDO
    // idFromName key both compare against the same value the box joined under —
    // otherwise a non-ASCII or spaced name (e.g. "My Mac" → "My%20Mac") 401s on
    // _connect and routes to the wrong (empty) DO → 503 on mcp. We re-encode
    // only when building outward URL strings. (code-review #11)
    const box = second ? safeDecode(second) : "";

    // /<service>/<box>/_connect  — agent dials in (WS upgrade).
    // /<service>/<box>/mcp        — public MCP call to a specific box.
    // /<service>/mcp                  — load-balanced across the service.

    // Agent registration: /<service>/<box>/_connect
    if (second && parts[2] === "_connect") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      // AUTHENTICATE THE AGENT CHANNEL before forwarding to the relay DO. The
      // agent presents the per-box connect-token (minted at /join) as
      // ?ct=<token>. We verify the HMAC + expiry AND assert it was issued for
      // exactly this resolved route (kind+tenant+service+box). FAIL CLOSED
      // → 401 — without this anyone who guesses a slug/service/box could
      // hijack the relay socket and harvest callers' finch_ keys.
      const ct = url.searchParams.get("ct") || "";
      const payload = ct ? await verifyToken(ct, env.TICKET_SECRET) : null;
      if (
        !payload ||
        payload.kind !== "connect" ||
        payload.tenant !== tenant ||
        payload.service !== service ||
        payload.box !== box
      ) {
        return json(401, { error: "invalid or missing connect token" });
      }
      // Stash tenant/service/box on the _connect URL so the relay DO can
      // serializeAttachment them (survives hibernation) and call markBox.
      const connectUrl = new URL(req.url);
      connectUrl.searchParams.set("tenant", tenant);
      connectUrl.searchParams.set("service", service);
      connectUrl.searchParams.set("box", box);
      // PROVE PROVENANCE TO THE DO. BoxDO cannot tell an upgrade that came
      // through this authenticated branch from one the public relay forwarded
      // (the relay carries ARBITRARY client paths, and /<service>/_connect
      // reaches the DO as relPath /_connect). Present the service secret, which
      // relayMcp strips from caller headers — same trust model as /_control.
      const connectHeaders = new Headers(req.headers);
      connectHeaders.set("X-Finch-Service", env.FINCH_SERVICE_SECRET);
      const stub = boxStub(env, tenant, service, box);
      return stub.fetch(
        new Request(connectUrl.toString(), {
          method: req.method,
          headers: connectHeaders,
        }),
      );
    }

    // Generic public relay: forward ANY path under the service to the box —
    // finch is a protocol-agnostic tunnel, not MCP-only. /<app>/mcp (MCP),
    // /<app>/ and /<app>/index.html (a website), /<app>/api/... (any HTTP) all
    // relay. The optional <box> pin is resolved POSITIONALLY: if the second
    // segment names a REGISTERED box of this service, it pins that box
    // and the upstream path is everything after it; otherwise the whole tail is
    // the upstream and we load-balance across the service's healthy pool.
    // (`_connect` is the one reserved segment, handled above before we get here.)
    if (service) {
      // SPOOF STRIP FIRST: no authentication or authorization path may observe
      // a caller-supplied Finch identity. The only assertion that can reach the
      // hosted service is minted later by relayMcp after auth succeeds.
      const untrustedHeaders = new Headers(req.headers);
      stripUntrustedCallerIdentity(untrustedHeaders);
      req = new Request(req, { headers: untrustedHeaders });

      // THROTTLE FIRST — per-(tenant,IP), BEFORE any DO round-trip. The box
      // pin lookup, the route check and the relay itself all hit Durable
      // Objects; gating here makes a cheap DO-invocation DoS expensive. There
      // is no browser login wall: a keyless browser gets the same JSON 401 as
      // any other keyless caller (relayMcp). relayMcp does NOT re-check this limiter
      // (it is only reachable through this gated path). Fails open in dev/test
      // (no binding). (security M5 / code-review #6)
      const ip = clientIp(req);
      if (!(await rateLimitOk(env.RELAY_LIMIT, `${tenant}:${ip}`))) {
        return json(429, { error: "rate limited" });
      }

      let pinned = "";
      if (second) {
        // `box` is the DECODED name (safeDecode at the edge) — it matches the
        // stored registry entry and keys the BoxDO. A path whose first
        // segment merely COLLIDES with a box name pins that box; this
        // positional ambiguity is INHERENT to /<app>/<box?>/<path> routing
        // once finch hosts arbitrary websites (e.g. /<app>/somepage must route to
        // a page named "somepage", not error). So we MUST NOT error when the
        // second segment is not a registered box: a stale/removed box pin
        // (or any non-box second segment) deliberately FALLS THROUGH to the
        // load-balanced branch below with that segment KEPT in the upstream path
        // (parts.slice(1)). (code-review #8 — accepted by design)
        const ex = await tenantOp<{ exists: boolean }>(
          env,
          tenant,
          "boxExists",
          { service, box },
        );
        if (ex?.exists) pinned = box;
      }

      if (pinned) {
        // Specific box: upstream = everything after <service>/<box>.
        const upstream = parts.slice(2).join("/");
        if (isReservedUpstream(upstream)) return json(404, { error: "not found" });
        return relayMcp(req, env, ctx, tenant, service, pinned, path, upstream);
      }

      // Load-balanced across the service. Upstream = everything after
      // <service> (the resolved <box> is injected by relayMcp so the DO's
      // two-segment strip yields this path; an empty tail yields "/"). Pick the
      // WHOLE healthy pool (shuffled) and FAIL OVER inside relayMcp on a
      // stale-pick "service offline" 503. (code-review #12)
      const upstream = parts.slice(1).join("/");
      if (isReservedUpstream(upstream)) return json(404, { error: "not found" });
      const pool = await pickHealthyPool(env, tenant, service);
      // No such service: a plain 404, before any credential is looked at.
      if (!pool) return json(404, { error: "no such service", service });
      if (!pool.length) {
        // No healthy box at all. Record this 503 too, so a load-balanced
        // offline call is just as visible in the dashboard (logs / recentCalls /
        // err) as a specific-box offline 503. Best-effort caller attribution.
        const caller = await callerLabel(req, env, tenant, service);
        ctx.waitUntil(
          tenantOp(env, tenant, "recordCall", {
            service,
            box: "—",
            status: 503,
            ms: 0,
            caller,
            route: path,
          }).catch(() => {}),
        );
        return json(503, { error: "service offline", service });
      }
      return relayMcp(req, env, ctx, tenant, service, pool, path, upstream);
    }

    return json(404, { error: "not found", path });
  },
};

/** The shuffled pool of online box names for a service (load-balance +
 *  failover). Uses the UNIFIED liveness rule (connected AND not pending) so the
 *  picker and the dashboard agree. Reads TenantDO getState. Empty if none is
 *  online; null if the tenant has no such service. */
export async function pickHealthyPool(
  env: Env,
  tenant: string,
  service: string,
): Promise<string[] | null> {
  const state = await tenantOp(env, tenant, "getState");
  const ap = (state?.services ?? []).find((a: any) => a.id === service);
  if (!ap) return null;
  const boxes: any[] = ap.boxes ?? [];
  // online = holds a live socket AND approved (matches tenant-do boxOnline).
  const healthy = boxes.filter(
    (m) => m.connected && m.state !== "pending",
  );
  // Fisher-Yates shuffle so load spreads and failover tries a fresh order.
  for (let i = healthy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [healthy[i], healthy[j]] = [healthy[j], healthy[i]];
  }
  return healthy.map((m) => m.name as string);
}

/** Best-effort caller attribution for a request: resolve the presented finch_
 *  key to its label via the TenantDO, falling back to "finch_key" / "anonymous".
 *  Never throws and never gates the response — used only to label metrics for
 *  outcomes (like the LB-offline 503) that don't go through relayMcp's auth. */
async function callerLabel(
  req: Request,
  env: Env,
  tenant: string,
  service: string,
): Promise<string> {
  try {
    const auth = req.headers.get("authorization") || "";
    const m = auth.match(/^Bearer\s+(finch_[A-Za-z0-9_-]+)$/);
    if (!m) return "anonymous";
    const hash = await hashKey(m[1]);
    const check = await tenantOp<{ allowed: boolean; keyLabel: string }>(
      env,
      tenant,
      "checkKey",
      { hash, service },
    );
    return check.keyLabel || "finch_key";
  } catch {
    return "finch_key";
  }
}

/** The relay's 401 OAuth `WWW-Authenticate: Bearer` challenge (RFC 6750 §3).
 *
 *  resource_metadata names the metadata document for the resource the client
 *  ACTUALLY requested — `/.well-known/oauth-protected-resource` + the request
 *  path, still percent-encoded — so the .well-known handler answers with
 *  `resource` equal to that URL. The MCP auth spec requires a client to reject
 *  metadata discovered this way whose `resource` differs from the URL it
 *  called; the old hard-coded `/<svc>/mcp` broke that for a pinned
 *  /<svc>/<box>/mcp and for every non-/mcp route. */
function relayBearerChallenge(req: Request): string {
  const u = new URL(req.url);
  return (
    `Bearer resource_metadata="https://${u.host}` +
    `/.well-known/oauth-protected-resource${u.pathname}", ` +
    `scope="${MCP_SCOPES.join(" ")}"`
  );
}

/** Authenticate a relay caller, relay to the per-box BoxDO, and record the
 *  call. Callers authenticate with a Bearer finch_ key (checked against the
 *  tenant's TenantDO), a Clerk OAuth access token belonging to the tenant
 *  OWNER, or the first-party service assertion POST /api/cli/call uses; a
 *  public service needs none. 401 if no credential is presented on a
 *  key-gated service, 403 if one is presented but not allowed. `boxOrPool` is
 *  a single box name (the specific-box route) or a shuffled candidate pool
 *  (the LB route) that we fail over on a DO "service offline" 503. */
async function relayMcp(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  tenant: string,
  service: string,
  boxOrPool: string | string[],
  route: string,
  upstream: string,
): Promise<Response> {
  // NOTE: the per-(tenant,IP) RELAY_LIMIT is applied by the caller at the TOP of
  // the `if (service)` block — BEFORE any DO round-trip — so it is
  // NOT re-checked here (relayMcp is only reachable through that gated path; a
  // second check would double-count the limiter). (security M5 / code-review #6)

  // REQUEST-SIZE CAP — reject oversized bodies before buffering them into a DO.
  // content-length is client-controlled/absent for chunked, so this is a cheap
  // first gate; BoxDO enforces the real limit on the buffered string. (#16)
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > MAX_RELAY_BODY_BYTES) {
    return json(413, { error: "request body too large" });
  }

  // TRUSTED INTERNAL RELAY: POST /api/cli/call (`finch call` / `finch tools`)
  // relays through the SELF binding with the service secret + a tenant
  // assertion (no finch_ key). serviceOk + verifyAssertion proves a first-party
  // caller acting for THIS resolved tenant, so we skip the per-key checkKey
  // gate. Only the hub itself and the web hold FINCH_SERVICE_SECRET.
  const svcAuthed =
    serviceOk(req, env) &&
    (await verifyAssertion(req.headers.get("x-finch-auth") || "", env.FINCH_SERVICE_SECRET)) ===
      tenant;

  let caller = "dashboard";
  let edgeCaller: RelayCaller | null = svcAuthed
    ? { sub: "service:finch-dashboard", authMethod: "service" }
    : null;
  // OAUTH PLANE: a non-finch_ bearer with CLERK_ISSUER configured is tried as a
  // Clerk OAuth access token (claude.ai custom connectors — they can't send
  // finch_ keys). A verified token whose Clerk user IS this tenant (tenant id
  // === their user id) authorizes the relay; any other verified identity is a
  // hard 403 (Finch is single-user: there are no shared members, org grants
  // or per-user app grants). An
  // unverifiable token falls through to the key gate, whose 401 carries the
  // resource_metadata challenge pointing back at Clerk.
  let oauthAuthed = false;
  if (!svcAuthed && env.CLERK_ISSUER) {
    const m = (req.headers.get("authorization") || "").match(
      /^Bearer\s+(?!finch_)(\S+)$/,
    );
    if (m) {
      const who = await verifyClerkOAuthToken(
        m[1],
        env.CLERK_ISSUER,
        env.CLERK_USERINFO,
      );
      const id = who?.sub || who?.user_id;
      if (who && id) {
        const gate = await tenantOp<{ allowed: boolean }>(env, tenant, "gateOauth", {
          clerkUserId: id,
          service,
        });
        if (!gate.allowed) {
          return json(403, { error: "token identity does not own this tenant" });
        }
        oauthAuthed = true;
        caller = `oauth:${id}`;
        edgeCaller = { sub: `user:${id}`, authMethod: "oauth" };
      } else if (who) {
        return json(403, { error: "token identity does not own this tenant" });
      }
    }
  }
  if (!svcAuthed && !oauthAuthed) {
    // ALWAYS consult the TenantDO — even with NO bearer — because a PUBLIC
    // service (an open webpage) must be reachable without a key. We parse the
    // bearer when present (empty hash when absent) and let checkKey decide:
    //   public service        → allowed regardless of key (check.public)
    //   key service, no key    → not allowed, no bearer presented → 401
    //   key service, bad key   → not allowed, reason-mapped       → 403
    // A key is allowed iff it exists (not revoked), has not expired, and its
    // scope is {all:true} or names the service — there are no ACL rules.
    // So key-gated services behave EXACTLY as before; only public ones open up.
    const auth = req.headers.get("authorization") || "";
    const m = auth.match(/^Bearer\s+(finch_[A-Za-z0-9_-]+)$/);
    const hash = m ? await hashKey(m[1]) : "";
    const check = await tenantOp<{
      allowed: boolean;
      keyLabel: string;
      keyId?: string;
      keyOwner?: string;
      public?: boolean;
      reason?: "no-key" | "expired" | "no-service" | "scope";
    }>(env, tenant, "checkKey", { hash, service });
    if (!check.allowed) {
      // No bearer at all on a key-gated service → the shape-level 401 (same as
      // before). A present-but-rejected key → 403 with the cause distinguished
      // (unknown key, expired key, or a scope that does not cover the service).
      if (!m) {
        // The 401 challenge is what OAuth-capable clients key on: it points at
        // our RFC 9728 metadata, which points at Clerk (discovery → DCR → code
        // flow). Bearer-key clients ignore it and behave exactly as before.
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (env.CLERK_ISSUER) {
          // scope is the client's PRIORITY-1 source for what to request
          // (claude.ai: challenge scope > resource-metadata scopes_supported >
          // everything the AS supports) — identity only, see MCP_SCOPES.
          headers["www-authenticate"] = relayBearerChallenge(req);
        }
        return new Response(
          JSON.stringify({ error: "missing or malformed finch_ bearer key" }),
          { status: 401, headers },
        );
      }
      const error =
        check.reason === "scope"
          ? "key scope does not include this service"
          : check.reason === "expired"
            ? "key has expired"
            : "key not allowed for this service";
      return json(403, { error });
    }
    caller = check.public ? "public" : check.keyLabel || "finch_key";
    edgeCaller = check.public
      ? null
      : {
          sub: `key:${check.keyId || check.keyLabel}`,
          authMethod: "finch_key",
          ...(check.keyOwner ? { actor: check.keyOwner } : {}),
          ...(check.keyId ? { keyId: check.keyId } : {}),
          ...(check.keyLabel ? { keyLabel: check.keyLabel } : {}),
        };
  }
  const pool =
    typeof boxOrPool === "string" ? [boxOrPool] : boxOrPool;

  // KEY-STRIP: the caller's finch_ key must NEVER cross the trust boundary into
  // the box's local upstream. Clone the headers and delete every header the hub
  // accepts a credential in BEFORE building the relay request. The agent strips
  // Authorization again as defense-in-depth, but the credential must be gone at
  // the source. (If a box upstream needs its own auth, inject a per-service
  // secret downstream — never the caller key.)
  //
  // The scrub is BY NAME, not by value. The hub reads a finch_ key or OAuth
  // token only from `Authorization: Bearer`, and the first-party service
  // secret + tenant assertion only from X-Finch-Service / X-Finch-Auth — so
  // those are what go.
  // Every other header is forwarded byte-for-byte. This used to also delete ANY
  // header whose value merely contained "finch_", which dropped MCP
  // 2026-07-28's Mcp-Name / Mcp-Param-* mirrors for a tool or argument named
  // like `finch_search`; the server then rejects the call as a header/body
  // mismatch (400 -32020). Those headers mirror the JSON-RPC body, which the
  // relay forwards untouched anyway, so scrubbing them protected nothing.
  const relayHeaders = new Headers(req.headers);
  relayHeaders.delete("authorization");
  relayHeaders.delete("proxy-authorization");
  // The whole X-Finch-* namespace is hub-reserved: X-Finch-Service (the service
  // secret), X-Finch-Auth, and the identity headers stripped at the edge. The
  // only one a box may ever see, X-Finch-Assertion, is minted AFTER this runs.
  for (const name of [...relayHeaders.keys()]) {
    if (name.startsWith("x-finch-")) relayHeaders.delete(name);
  }
  // A client may also copy the credential it presented into some other header
  // (X-Api-Key, a custom auth header). The hub never reads it there, but it must
  // still not reach the box, so drop any remaining header that contains the
  // exact bearer secret presented on THIS request. Matching the secret itself,
  // not the "finch_" prefix, keeps Mcp-Name: finch_status and friends intact.
  const presented = /^Bearer\s+(\S{16,})$/i.exec(req.headers.get("authorization") || "")?.[1];
  if (presented) {
    for (const [name, value] of [...relayHeaders.entries()]) {
      if (value.includes(presented)) relayHeaders.delete(name);
    }
  }
  // Buffer the body ONCE so we can replay it across failover candidates (a
  // streaming body can't be re-sent). Enforce the real size cap here too, since
  // content-length may be absent for a chunked request — and enforce it WHILE
  // reading: arrayBuffer() would materialize the whole upload before we could
  // measure it, so a chunked ~100 MB POST (the platform's body ceiling) would
  // sit in the isolate's 128 MB heap and take co-resident in-flight requests
  // down with it. readBoundedBody cancels the stream the moment the running
  // total would cross the cap, so at most MAX_RELAY_BODY_BYTES is ever held.
  let bodyBytes: Uint8Array | null = null;
  if (req.body) {
    let read: Uint8Array | undefined;
    try {
      read = await readBoundedBody(req, MAX_RELAY_BODY_BYTES);
    } catch {
      // read failure (client hung up / malformed chunking) — distinct from oversize
      return json(400, { error: "invalid request body" });
    }
    if (read === undefined) {
      return json(413, { error: "request body too large" });
    }
    bodyBytes = read;
  }
  try {
    const upstreamPath =
      (upstream ? `/${upstream}` : "/") + new URL(req.url).search;
    await injectCallerAssertion(
      relayHeaders,
      req,
      env,
      tenant,
      service,
      edgeCaller,
      upstreamPath,
      bodyBytes,
    );
  } catch (error) {
    // A requested assertion configuration is part of the auth boundary. Never
    // downgrade to an unsigned request if its signer is missing or malformed.
    console.error(
      "caller assertion signing failed",
      error instanceof Error ? error.message : String(error),
    );
    return json(503, { error: "caller assertion signer unavailable" });
  }

  const start = Date.now();
  let res = json(503, { error: "service offline", service });
  let usedBox = pool[0];
  for (const box of pool) {
    usedBox = box;
    // Normalize the forwarded URL to /<service>/<box>/<rest>. BoxDO
    // strips exactly TWO leading segments to derive the upstream path. For the LB
    // entry (/<service>/mcp) the resolved <box> isn't in the URL, so this
    // rewrite is what lets the DO yield "/mcp" instead of "/".
    const inUrl = new URL(req.url);
    inUrl.pathname =
      `/${service}/${encodeURIComponent(box)}` +
      (upstream ? `/${upstream}` : "");
    const relayReq = new Request(inUrl.toString(), {
      method: req.method,
      headers: relayHeaders,
      body: bodyBytes,
    } as RequestInit);

    const stub = boxStub(env, tenant, service, box);
    try {
      res = await stub.fetch(relayReq);
    } catch (e) {
      res = json(502, { error: `relay failed: ${e}` });
    }
    // FAIL OVER only on the DO's own "service offline" signal (no agent socket
    // for this box) — a stale pick. Any other status (including an upstream
    // 503) is the box's real answer and is returned as-is. The DO tags its
    // offline 503 with X-Finch-Offline so we don't have to read the body.
    if (res.status === 503 && res.headers.get("X-Finch-Offline") === "1") {
      // Reconcile: the picked box had no agent socket, so its persisted
      // liveness is stale. Mark it offline (here, where the tenant is known —
      // the public relay path doesn't carry tenant down to the DO) so the next
      // pick excludes it. Fire-and-forget. (code-review #12)
      ctx.waitUntil(
        tenantOp(env, tenant, "markBox", {
          service,
          box,
          connected: false,
        }).catch(() => {}),
      );
      continue; // try the next sibling
    }
    break;
  }
  const ms = Date.now() - start;

  // Fire-and-forget metrics; never block the response on the counter write.
  // Must use ctx.waitUntil — a bare unawaited promise is cancelled once the
  // response is returned, so the recordCall subrequest to TenantDO never commits.
  ctx.waitUntil(
    tenantOp(env, tenant, "recordCall", {
      service,
      box: usedBox,
      status: res.status,
      ms,
      caller,
      route,
    }).catch(() => {}),
  );

  return res;
}
