/// <reference types="@cloudflare/workers-types" />
//
// Finch hub — the thin control plane. "We handle auth + routing + hosting,
// you handle the logic." This Worker resolves the tenant, then either:
//   - serves the control API (/api/*, /join) — see api.ts
//   - relays MCP / agent traffic to the per-BOX BoxDO, gated by a
//     finch_ key check against the tenant's TenantDO.
//
// Tenancy: every request belongs to a tenant (a Clerk org id, or user id).
//   - Control-plane requests (from the web app) carry X-Finch-Tenant explicitly
//     — that IS the real tenant id, so control-plane TenantDOs are keyed by it.
//   - MCP / relay traffic carries only a vanity HOST slug (<slug>.finchmcp.com),
//     which is NOT the tenant id. The relay resolves the slug to the tenant id
//     via the singleton RouterDO (slug→tenantId index) and keys TenantDO +
//     BoxDO by THAT tenant id. Unknown slug FAILS CLOSED (404). The
//     DEFAULT_TENANT fallback exists ONLY for local dev (env.DEV === "1").

import { BoxDO } from "./box-do";
import { TenantDO } from "./tenant-do";
import { RouterDO, routerLookup } from "./router-do";
import { handleApi, isApiPath } from "./api";
import { handleChat } from "./chat";
import {
  hashKey,
  verifyToken,
  verifySession,
  signSession,
  serviceOk,
  verifyAssertion,
} from "./auth";
import type { TicketPayload } from "./auth";

export { BoxDO, TenantDO, RouterDO };

export interface Env {
  // Durable Object namespaces.
  BOX: DurableObjectNamespace; // per-box WS relay (BoxDO)
  TENANT: DurableObjectNamespace; // per-tenant control-plane state (TenantDO)
  ROUTER: DurableObjectNamespace; // singleton slug→tenantId index (RouterDO)

  // Secrets / vars (wrangler vars in dev via .dev.vars; secrets in prod).
  FINCH_SERVICE_SECRET: string; // web-app -> control API shared secret
  TICKET_SECRET: string; // HMAC key for join tickets + per-box connect-tokens
  // SEPARATE HMAC key for the browser login-wall session cookie (kind:"session").
  // Kept distinct from TICKET_SECRET so a leaked session signer can NOT forge a
  // join/connect/portal grant (and vice-versa). Set per env via
  //   wrangler secret put SESSION_SECRET --env <staging|production>
  // In dev/test it's injected as a var fixture (see wrangler.test.jsonc).
  SESSION_SECRET: string;
  DEFAULT_TENANT?: string; // DEV-ONLY tenant fallback when no slug resolves
  DEV?: string; // "1" in the dev env; gates the DEFAULT_TENANT fallback
  WEB_URL?: string; // dashboard base URL — the `finch login` device page lives at <WEB_URL>/cli
  VANITY_SUFFIXES?: string; // comma-separated first-party custom-hostname suffixes, e.g. "aviary.run"
  VANITY_TENANT?: string; // only this tenant may claim VANITY_SUFFIXES hostnames
  CF_API_TOKEN?: string; // secret: Cloudflare for SaaS API token (never log)
  CF_SAAS_ZONE_ID?: string; // finchmcp.com zone id for SaaS custom-hostname provisioning
  BYO_CNAME_TARGET?: string; // CNAME target shown to BYO-domain customers
  AI: Ai; // Workers AI binding — powers the /chat test interface
  SELF: Fetcher; // self service-binding — /chat relays MCP back through our own service path

  // Where GET /releases/<asset> redirects to fetch the agent binary. Defaults to
  // the project's GitHub Releases "latest" assets; override per-env if binaries
  // are hosted elsewhere (e.g. an R2 bucket).
  RELEASES_BASE?: string;

  // Cloudflare Rate Limiting bindings (unsafe.bindings ratelimit). Optional so
  // tests / `wrangler dev` without the binding still run (limiter() no-ops when
  // absent). RELAY_LIMIT gates per-(tenant,IP) on the MCP relay BEFORE any DO
  // round-trip (login-wall probe + checkKey); its budget (600/60s) is sized for a
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

// Max relay request body we'll buffer into a DO (#16 / security L9). The DO
// buffers the whole body via req.text(); a few-MB cap keeps concurrent POSTs
// from summing past DO heap. Enforced here pre-stub AND in BoxDO.fetch.
const MAX_RELAY_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB

// Browser login-wall session cookie lifetime (12h). The cookie is the long-lived
// proof a browser already cleared the Clerk wall; the portal hand-off grant that
// mints it is short (~60s, single-use). 12h balances "don't re-login constantly"
// against the blast radius of a stolen cookie (also revocable via sessionEpoch).
const SESSION_TTL_SECONDS = 12 * 60 * 60;

// The login-wall cookie name. HttpOnly + Secure + SameSite=Lax + Path=/, and
// HOST-scoped (no Domain attribute) so a cookie minted for one host key
// (<slug>.finchmcp.com, <box>.aviary.run, or a BYO hostname) can't be
// replayed against a sibling tenant's host.
const SESSION_COOKIE = "finch_session";

/** Parse a single cookie value out of a Cookie header. Returns "" if absent.
 *  Minimal + allocation-light; cookie values here are base64url envelopes (no
 *  special chars), so a plain name=value split per pair is sufficient. */
function readCookie(req: Request, name: string): string {
  const raw = req.headers.get("cookie");
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

/** Strip ONLY the finch_session login-wall cookie out of a Cookie header,
 *  preserving the hosted app's OWN cookies (e.g. app_sid). Parses the header into
 *  name=value pairs, drops the SESSION_COOKIE pair, and re-serializes the rest.
 *  Returns "" if nothing remains (caller then deletes the header). The login-wall
 *  cookie must never cross to the box, but a blanket "contains finch_" strip would
 *  delete the whole Cookie header and break every cookie-based hosted site. (#1) */
function stripSessionCookie(cookieHeader: string): string {
  const kept: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (name === SESSION_COOKIE) continue; // drop only the login-wall cookie pair
    const pair = part.trim();
    if (pair) kept.push(pair);
  }
  return kept.join("; ");
}

/** Validate a redirect target as a SAFE RELATIVE path (open-redirect guard).
 *  Accepts only a path that starts with a single "/" and is NOT a
 *  scheme-relative "//host" or a "/\host" (which browsers treat as a host). On
 *  anything else (absolute URL, empty, missing leading slash) returns "/". This
 *  is the SOLE gate on every `rd` we 302 to from the login-wall handlers. */
export function safeRelPath(rd: string | null | undefined): string {
  if (!rd || typeof rd !== "string") return "/";
  // Must be path-absolute and not protocol-relative / backslash-host.
  if (rd[0] !== "/" || rd[1] === "/" || rd[1] === "\\") return "/";
  // Reject control chars / whitespace that could smuggle a header or confuse a
  // parser; a legit path+query won't contain them.
  if (/[\x00-\x1f\x7f]/.test(rd)) return "/";
  return rd;
}

/** The login-wall decision: either a 302 to the wall (short-circuit the request)
 *  or a pass, optionally carrying `browserAuthed` — a valid session cookie that
 *  relayMcp must honor as an authorized caller (skipping the finch_ key gate, the
 *  same way a service-authed dashboard call does). */
type GateDecision =
  | { wall: Response }
  | { wall?: undefined; browserAuthed: boolean };

/** AUTH-BY-REQUEST-TYPE gate that runs RIGHT BEFORE relayMcp for both the
 *  pinned-box and load-balanced branches. It decides whether the login wall
 *  applies, per the contract's core rule:
 *    1. Bearer finch_ present                 → pass (MCP/key plane; relayMcp's
 *       checkKey gate is the real authority — the wall is BYPASSED).
 *    2. svc-authed (FINCH_SERVICE_SECRET + a valid assertion for THIS tenant)
 *                                              → pass (dashboard test-in-chat).
 *    3. service.auth === "public"            → pass (explicit open opt-out).
 *    4. otherwise (a browser, no finch_ bearer) → browserGate: a valid
 *       finch_session cookie passes as browserAuthed; else 302 to the login wall.
 *  Returns {wall} to short-circuit, or {browserAuthed} to let relayMcp proceed.
 *  We resolve the service's auth mode via the SAME checkKey op the relay uses
 *  (public:true short-circuits) so the two can never disagree. A browserAuthed
 *  pass authorizes the RELAY (it cleared the wall); relayMcp still strips the key
 *  and records the call, but does NOT re-run the per-key checkKey gate. */
async function maybeBrowserGate(
  req: Request,
  env: Env,
  tenant: string,
  hostKey: string,
  service: string,
  originalPathAndQuery: string,
): Promise<GateDecision> {
  // 1. A finch_ bearer means the MCP/key plane — checkKey inside relayMcp is the
  //    authority; never wall it. (Matches relayMcp's own bearer parse.)
  const auth = req.headers.get("authorization") || "";
  if (/^Bearer\s+finch_[A-Za-z0-9_-]+$/.test(auth)) {
    return { browserAuthed: false };
  }

  // 2. First-party service caller acting for THIS tenant (test-in-chat) — bypass.
  //    relayMcp re-derives svcAuthed itself, so we just don't wall it here.
  if (
    serviceOk(req, env) &&
    (await verifyAssertion(
      req.headers.get("x-finch-auth") || "",
      env.FINCH_SERVICE_SECRET,
    )) === tenant
  ) {
    return { browserAuthed: false };
  }

  // 3. Public service → no wall (the explicit opt-out). We ask checkKey with an
  //    empty hash: a public service returns {public:true} regardless of key.
  //    (A dev-fallback host with no usable host key also has none to bind a
  //    cookie to; skip the wall there too rather than bounce to a dead slug. The
  //    relay's own checkKey then enforces the key gate as before.) Gate this on
  //    env.DEV: an empty host key only ever arises via the DEV DEFAULT_TENANT
  //    fallback (resolveTenant fails closed in prod), so a prod build must never
  //    take this wall-skip even if misconfigured — fall through to browserGate.
  if (!hostKey) {
    if (env.DEV === "1") return { browserAuthed: false };
    // No host key in a non-dev build should be unreachable (resolveTenant 404s), but
    // if it happens, fail CLOSED: treat as a private service needing the wall.
    return browserGate(req, env, tenant, hostKey, originalPathAndQuery);
  }
  const probe = await tenantOp<{ public?: boolean }>(env, tenant, "checkKey", {
    hash: "",
    service,
  });
  if (probe?.public) return { browserAuthed: false };

  // 4. A browser on a private service → require the session cookie.
  return browserGate(req, env, tenant, hostKey, originalPathAndQuery);
}

/** browserGate — the login-wall decision for a relay request that is NOT a
 *  finch_ bearer call, NOT service-authed, and NOT a public service (the
 *  caller checks those first). For such a request (a plain browser hit on a
 *  PRIVATE service) we require a valid finch_session cookie bound to THIS
 *  tenant+slug whose epoch matches the tenant's current sessionEpoch. A valid
 *  cookie passes as {browserAuthed:true} (relayMcp skips the key gate); a
 *  missing/invalid/stale cookie 302s to the Clerk-gated portal start page. The
 *  cookie is the ONLY thing checked here; the service-private check is upstream. */
async function browserGate(
  req: Request,
  env: Env,
  tenant: string,
  hostKey: string,
  originalPathAndQuery: string,
): Promise<GateDecision> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) {
    const sess = await verifySession(cookie, env.SESSION_SECRET);
    if (
      sess &&
      sess.kind === "session" &&
      sess.tenant === tenant &&
      sess.slug === hostKey
    ) {
      // Stale-cookie check: the tenant can "sign everyone out" by bumping its
      // sessionEpoch; a cookie minted under an older epoch is treated as logged
      // out. A missing epoch on either side normalizes to 0.
      const { epoch } = await tenantOp<{ epoch: number }>(
        env,
        tenant,
        "sessionEpoch",
      );
      if ((sess.epoch ?? 0) === (epoch ?? 0)) {
        return { browserAuthed: true }; // valid cookie → relay as a web caller
      }
    }
  }
  // No valid session → bounce to the Clerk-gated portal start page. WEB_URL is
  // the dashboard origin; the portal page re-mints a portal grant for this host key
  // and hands the browser back to /__finch/cb here. `rd` carries the original
  // path+query so the user lands where they meant to after login.
  const webBase = (env.WEB_URL || "https://finchmcp.com").replace(/\/+$/, "");
  const target =
    `${webBase}/portal/start?slug=${encodeURIComponent(hostKey)}` +
    `&rd=${encodeURIComponent(safeRelPath(originalPathAndQuery))}`;
  return { wall: Response.redirect(target, 302) };
}

// Default target for GET /releases/<asset>: the project's GitHub Releases
// "latest" download URL. Overridable via env.RELEASES_BASE.
const DEFAULT_RELEASES_BASE =
  "https://github.com/DigiBugCat/finch/releases/latest/download";

// Allow-listed release asset names — gates the /releases redirect so it can
// never be turned into an open redirect. Matches the installer's
// `finch-${os}-${arch}` and GoReleaser's archive name_template.
const RELEASE_ASSET_RE = /^finch-(darwin|linux)-(amd64|arm64|armv6|armv7)$/;

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

/** Back-compat alias for tests / older local imports; prefer hostKeyFromHost. */
export const slugFromHost = hostKeyFromHost;

/** Resolve the tenant id for an MCP/relay request from the host key.
 *  host key -> RouterDO.lookup -> tenant id. FAILS CLOSED: an unknown key returns
 *  a null tenant (the caller turns that into a 404). The DEFAULT_TENANT fallback
 *  is consulted ONLY in dev (env.DEV === "1") so prod never silently falls back.
 *  Returns the RESOLVED host key alongside the tenant: hostKey is "" when the
 *  dev fallback supplied the tenant (the inbound host never resolved), so the
 *  login wall / cookie binding only ever operate on a key RouterDO vouched for —
 *  never on a merely-parsed hostname. */
async function resolveTenant(
  host: string,
  env: Env,
): Promise<{ tenant: string | null; hostKey: string }> {
  const key = hostKeyFromHost(host);
  if (key) {
    const tenant = await routerLookup(env, key);
    if (tenant) return { tenant, hostKey: key };
  }
  // No usable/registered host key (unregistered slug/custom host, apex, www, workers.dev,
  // localhost): fail closed in prod; dev-only DEFAULT_TENANT fallback otherwise.
  if (env.DEV === "1" && env.DEFAULT_TENANT) {
    return { tenant: env.DEFAULT_TENANT, hostKey: "" };
  }
  return { tenant: null, hostKey: "" };
}

/** Tenant DO stub for a tenant id. */
function tenantStub(env: Env, tenant: string) {
  return env.TENANT.get(env.TENANT.idFromName(tenant));
}

/** Per-box relay DO stub. Keyed `${tenant}:${service}:${box}`. */
function boxStub(
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
    const url = new URL(req.url);
    const host = req.headers.get("host") || url.host;
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);

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

    // ---- /chat — a tiny test chat that drives a service's MCP tools via a
    //      Workers AI model (a "does my endpoint work" check). ----
    if (path === "/chat" || path === "/chat/completions") {
      return handleChat(req, env, url);
    }

    // ---- GET /install — the curl|sh agent installer (unauthenticated; the
    //      pipe carries no key). This is the target of the enroll one-liner
    //      `curl -fsSL <host>/install | sh && finch join --ticket <tkt>`. It
    //      installs the `finch` binary onto PATH; the operator then runs the
    //      `finch join --ticket …` half that the install string appends. ----
    if (path === "/install" && req.method === "GET") {
      const scheme =
        host.startsWith("localhost") || host.startsWith("127.0.0.1")
          ? "http"
          : "https";
      return new Response(installScript(`${scheme}://${host}`), {
        status: 200,
        headers: {
          "content-type": "text/x-shellscript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // ---- GET /releases/finch-<os>-<arch> — redirect to the published agent
    //      binary. The installer fetches $HUB/releases/finch-<os>-<arch>; we 302
    //      to GitHub Releases (env.RELEASES_BASE) so the Worker needn't host
    //      binaries. The asset name is allow-listed (RELEASE_ASSET_RE) so this
    //      can never be an open redirect, and a non-matching /releases/* falls
    //      through to normal routing. ----
    if (
      req.method === "GET" &&
      parts[0] === "releases" &&
      parts.length === 2 &&
      RELEASE_ASSET_RE.test(parts[1])
    ) {
      const base = (env.RELEASES_BASE || DEFAULT_RELEASES_BASE).replace(
        /\/+$/,
        "",
      );
      return Response.redirect(`${base}/${parts[1]}`, 302);
    }

    // ---- MCP / relay plane. Tenant id resolves from the host slug via the
    //      singleton RouterDO (slug→tenantId). FAIL CLOSED on an unknown slug. ----
    const { tenant, hostKey } = await resolveTenant(host, env);
    if (!tenant) {
      return json(404, {
        error: "tenant could not be resolved from host",
        host,
      });
    }

    // ---- Login-wall hand-off endpoints. RESERVED paths, handled BEFORE the
    //      service relay so a slug named "__finch" can never shadow them
    //      (mirrors how _connect/releases are reserved). Both run on the slug
    //      host (<slug>.finchmcp.com), where the tenant is already resolved. ----
    if (path === "/__finch/cb" && req.method === "GET") {
      return handleFinchCb(req, env, url, hostKey, tenant);
    }
    if (path === "/__finch/logout" && req.method === "GET") {
      // Clear the session cookie (Max-Age=0) and 302 to a validated relative rd
      // (default "/"). Host-scoped clear: same attributes as the set, no Domain.
      const rd = safeRelPath(url.searchParams.get("rd"));
      return new Response(null, {
        status: 302,
        headers: {
          location: rd,
          "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
        },
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
      const stub = boxStub(env, tenant, service, box);
      return stub.fetch(new Request(connectUrl.toString(), req));
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
      // THROTTLE FIRST — per-(tenant,IP), BEFORE any DO round-trip. The login wall
      // below (maybeBrowserGate's checkKey probe + browserGate's sessionEpoch DO
      // call) and the relay itself all hit Durable Objects; gating here makes a
      // cheap DO-invocation DoS expensive. relayMcp does NOT re-check this limiter
      // (it is only reachable through this gated path). Fails open in dev/test
      // (no binding). (security M5 / code-review #6)
      const ip = clientIp(req);
      if (!(await rateLimitOk(env.RELAY_LIMIT, `${tenant}:${ip}`))) {
        return json(429, { error: "rate limited" });
      }

      // LOGIN WALL (auth-by-request-type). For a browser hit (no finch_ bearer,
      // not svc-authed) on a PRIVATE service, bounce to the Clerk-gated portal
      // unless a valid finch_session cookie is present. finch_ key calls, the
      // dashboard's service-authed test-in-chat, and PUBLIC services all pass
      // through untouched. Computed once here; covers BOTH the pinned-box and
      // the load-balanced branch below. hostKey comes from resolveTenant above —
      // it is the key RouterDO actually resolved ("" under the dev fallback), so
      // the wall never binds a cookie to an unregistered hostname.
      const originalPathAndQuery = path + (url.search || "");
      const gate = await maybeBrowserGate(
        req,
        env,
        tenant,
        hostKey,
        service,
        originalPathAndQuery,
      );
      if (gate.wall) return gate.wall;
      // A valid session cookie authorizes the relay as a web caller (cleared the
      // wall) — relayMcp skips the per-key checkKey gate for it, like svcAuthed.
      const browserAuthed = gate.browserAuthed;

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
        return relayMcp(req, env, ctx, tenant, service, pinned, path, upstream, browserAuthed);
      }

      // Load-balanced across the service. Upstream = everything after
      // <service> (the resolved <box> is injected by relayMcp so the DO's
      // two-segment strip yields this path; an empty tail yields "/"). Pick the
      // WHOLE healthy pool (shuffled) and FAIL OVER inside relayMcp on a
      // stale-pick "service offline" 503. (code-review #12)
      const upstream = parts.slice(1).join("/");
      const pool = await pickHealthyPool(env, tenant, service);
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
      return relayMcp(req, env, ctx, tenant, service, pool, path, upstream, browserAuthed);
    }

    return json(404, { error: "not found", path });
  },
};

/** The shuffled pool of online box names for a service (load-balance +
 *  failover). Uses the UNIFIED liveness rule (connected AND not pending) so the
 *  picker and the dashboard agree. Reads TenantDO getState. Empty if none. */
async function pickHealthyPool(
  env: Env,
  tenant: string,
  service: string,
): Promise<string[]> {
  const state = await tenantOp(env, tenant, "getState");
  const ap = (state?.services ?? []).find((a: any) => a.id === service);
  if (!ap) return [];
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

/** Extract a Bearer finch_ key, check it against the tenant's TenantDO, relay to
 *  the per-box BoxDO, and record the call. 401 if the key is absent or
 *  not allowed for this service. `boxOrPool` is a single box name (the
 *  specific-box route) or a shuffled candidate pool (the LB route) that we
 *  fail over on a DO "service offline" 503. `browserAuthed` is set when the
 *  caller already cleared the browser login wall with a valid finch_session
 *  cookie — that authorizes the relay (we skip the per-key checkKey gate, exactly
 *  like the service-authed dashboard path), label the caller "web", and still
 *  strip credentials + record the call. */
async function relayMcp(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  tenant: string,
  service: string,
  boxOrPool: string | string[],
  route: string,
  upstream: string,
  browserAuthed = false,
): Promise<Response> {
  // NOTE: the per-(tenant,IP) RELAY_LIMIT is applied by the caller at the TOP of
  // the `if (service)` block — BEFORE the login-wall DO round-trips — so it is
  // NOT re-checked here (relayMcp is only reachable through that gated path; a
  // second check would double-count the limiter). (security M5 / code-review #6)

  // REQUEST-SIZE CAP — reject oversized bodies before buffering them into a DO.
  // content-length is client-controlled/absent for chunked, so this is a cheap
  // first gate; BoxDO enforces the real limit on the buffered string. (#16)
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > MAX_RELAY_BODY_BYTES) {
    return json(413, { error: "request body too large" });
  }

  // TRUSTED INTERNAL RELAY: the dashboard's own "test in chat" panel relays via
  // the web's service secret + a tenant assertion (no finch_ key). serviceOk +
  // verifyAssertion proves a first-party caller acting for THIS resolved tenant,
  // so we skip the per-key checkKey gate. Only the web holds FINCH_SERVICE_SECRET.
  const svcAuthed =
    serviceOk(req, env) &&
    (await verifyAssertion(req.headers.get("x-finch-auth") || "", env.FINCH_SERVICE_SECRET)) ===
      tenant;

  let caller = svcAuthed ? "dashboard" : "web";
  // A browser that cleared the login wall (valid finch_session cookie) is an
  // authorized web caller — like svcAuthed, it bypasses the per-key checkKey
  // gate. The wall already proved the service is reachable by this session.
  if (!svcAuthed && !browserAuthed) {
    // ALWAYS consult the TenantDO — even with NO bearer — because a PUBLIC
    // service (an open webpage) must be reachable without a key. We parse the
    // bearer when present (empty hash when absent) and let checkKey decide:
    //   public service        → allowed regardless of key (check.public)
    //   key service, no key    → not allowed, no bearer presented → 401
    //   key service, bad key   → not allowed, reason-mapped       → 403
    // So key-gated services behave EXACTLY as before; only public ones open up.
    const auth = req.headers.get("authorization") || "";
    const m = auth.match(/^Bearer\s+(finch_[A-Za-z0-9_-]+)$/);
    const hash = m ? await hashKey(m[1]) : "";
    const check = await tenantOp<{
      allowed: boolean;
      keyLabel: string;
      public?: boolean;
      reason?: "no-key" | "scope" | "acl" | "expired";
    }>(env, tenant, "checkKey", { hash, service });
    if (!check.allowed) {
      // No bearer at all on a key-gated service → the shape-level 401 (same as
      // before). A present-but-rejected key → 403 with the cause distinguished
      // ("unknown key" vs "known key, not granted by the tenant's ACL").
      if (!m) {
        return json(401, { error: "missing or malformed finch_ bearer key" });
      }
      const error =
        check.reason === "acl"
          ? "no ACL rule grants this key access to this service"
          : check.reason === "scope"
            ? "key scope does not include this service"
            : check.reason === "expired"
              ? "key has expired"
              : "key not allowed for this service";
      return json(403, { error });
    }
    caller = check.public ? "public" : check.keyLabel || "finch_key";
  }
  const pool =
    typeof boxOrPool === "string" ? [boxOrPool] : boxOrPool;

  // KEY-STRIP: the caller's finch_ key must NEVER cross the trust boundary into
  // the box's local upstream. Clone the headers and delete the Authorization
  // header (and any header that still carries a finch_ value) BEFORE building
  // the relay request. The agent strips hop-by-hop headers as defense-in-depth,
  // but the credential must be gone at the source. (If a box upstream needs its
  // own auth, inject a per-service secret downstream — never the caller key.)
  const relayHeaders = new Headers(req.headers);
  relayHeaders.delete("authorization");
  relayHeaders.delete("x-finch-service"); // never leak the service secret to a box
  relayHeaders.delete("x-finch-auth");
  // Surgically remove ONLY the finch_session login-wall cookie from the Cookie
  // header, leaving the hosted app's own cookies (e.g. app_sid) intact. (#1)
  const cookieHeader = relayHeaders.get("cookie");
  if (cookieHeader) {
    const remaining = stripSessionCookie(cookieHeader);
    if (remaining) relayHeaders.set("cookie", remaining);
    else relayHeaders.delete("cookie");
  }
  for (const [name, value] of [...relayHeaders.entries()]) {
    // SKIP the cookie header — it's already sanitized above, and a hosted app's
    // own cookie value could legitimately contain "finch_"; only a bearer KEY is
    // the real secret. Strip any OTHER header still carrying a finch_ value.
    if (name === "cookie") continue;
    if (value.includes("finch_")) relayHeaders.delete(name);
  }

  // Buffer the body ONCE so we can replay it across failover candidates (a
  // streaming body can't be re-sent). Enforce the real size cap here too, since
  // content-length may be absent for a chunked request.
  let bodyBytes: ArrayBuffer | null = null;
  if (req.body) {
    bodyBytes = await req.arrayBuffer();
    if (bodyBytes.byteLength > MAX_RELAY_BODY_BYTES) {
      return json(413, { error: "request body too large" });
    }
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

/** GET /__finch/cb?g=<grant>&rd=<relpath> — the login-wall callback on the host
 *  host. The Clerk-authed portal page (web) mints a short single-use PORTAL grant
 *  and hands the browser here. We:
 *    1. verifyToken(g, TICKET_SECRET) and assert kind==="portal".
 *    2. Bind it to THIS host: grant.tenant === resolved tenant AND grant.slug
 *       carries the resolved host key. A grant for another tenant/host key is
 *       refused (the host is the security boundary — a grant minted for X can't
 *       set a cookie on Y). The signed field remains named `slug` for wire compat.
 *    3. Burn the jti (claimTicket) so a captured grant can't mint a second
 *       session — refuse on {ok:false} (replay).
 *    4. Mint a kind:"session" cookie (SESSION_SECRET) stamped with the tenant's
 *       CURRENT sessionEpoch, and 302 to the validated relative `rd`.
 *  Any failure → 302 back to the portal start (re-login) rather than a hard error,
 *  so a stale/expired grant just re-bounces through Clerk. */
async function handleFinchCb(
  req: Request,
  env: Env,
  url: URL,
  // The RESOLVED host key from resolveTenant ("" under the dev fallback) — the
  // grant/cookie binding below must only ever see a RouterDO-vouched key.
  hostKey: string,
  tenant: string,
): Promise<Response> {
  const rd = safeRelPath(url.searchParams.get("rd"));

  // Re-bounce target if anything is wrong: back through the Clerk-gated portal.
  const webBase = (env.WEB_URL || "https://finchmcp.com").replace(/\/+$/, "");
  const reBounce = () =>
    Response.redirect(
      `${webBase}/portal/start?slug=${encodeURIComponent(hostKey)}&rd=${encodeURIComponent(rd)}`,
      302,
    );

  const grantTok = url.searchParams.get("g") || "";
  if (!grantTok || !hostKey) return reBounce();

  const grant = await verifyToken(grantTok, env.TICKET_SECRET);
  if (
    !grant ||
    grant.kind !== "portal" ||
    grant.tenant !== tenant ||
    grant.slug !== hostKey ||
    !grant.userId
  ) {
    return reBounce();
  }

  // SINGLE-USE: burn the portal grant's jti before minting a session, so a
  // captured grant can't be replayed into a second cookie. A grant WITHOUT a jti
  // is refused outright (every portal grant the hub mints carries one).
  if (!grant.jti) return reBounce();
  const claim = await tenantOp<{ ok: boolean }>(env, tenant, "claimTicket", {
    jti: grant.jti,
    exp: grant.exp,
  });
  if (!claim.ok) return reBounce(); // replayed grant

  // Stamp the tenant's CURRENT sessionEpoch into the cookie so a later
  // "sign everyone out" (bumpSessionEpoch) invalidates it.
  const { epoch } = await tenantOp<{ epoch: number }>(
    env,
    tenant,
    "sessionEpoch",
  );
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const session = await signSession(
    {
      kind: "session",
      tenant,
      slug: hostKey,
      userId: grant.userId,
      epoch: epoch ?? 0,
      exp,
    } as TicketPayload,
    env.SESSION_SECRET,
  );

  // HOST-scoped cookie (NO Domain) so it can't be replayed against a sibling
  // tenant's slug host. HttpOnly + Secure + SameSite=Lax + Path=/. Max-Age makes
  // it a PERSISTENT cookie for the full session lifetime — without it the browser
  // treats it as a session cookie that dies when the tab closes (the 12h TTL
  // baked into the signed envelope would then be moot). (code-review #11)
  return new Response(null, {
    status: 302,
    headers: {
      location: rd,
      "set-cookie": `${SESSION_COOKIE}=${session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`,
    },
  });
}

/** The `finch` agent installer served at GET /install. The enroll one-liner is
 *  `curl -fsSL <host>/install | sh && finch join --ticket <tkt>`, so this script
 *  only needs to land the `finch` binary on PATH — the operator runs the
 *  `finch join --ticket …` half itself. Detects OS/arch and fetches the matching
 *  release binary from the hub-relative /releases path, then installs it. Kept
 *  POSIX-sh so it runs under `sh` on macOS and Linux. */
function installScript(base: string): string {
  return `#!/bin/sh
# finch agent installer — run via: curl -fsSL ${base}/install | sh
# Installs the 'finch' relay agent, then run:
#   finch join --hub ${base} --ticket <ticket> --upstream http://127.0.0.1:8000
set -eu

HUB="${base}"
BIN_DIR="\${FINCH_BIN_DIR:-/usr/local/bin}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  arm64|aarch64) arch="arm64" ;;
  armv7l|armv7) arch="armv7" ;;
  armv6l|armv6) arch="armv6" ;;
  *) echo "finch: unsupported architecture: $arch" >&2; exit 1 ;;
esac
case "$os" in
  darwin|linux) ;;
  *) echo "finch: unsupported OS: $os" >&2; exit 1 ;;
esac

url="$HUB/releases/finch-\${os}-\${arch}"
tmp="$(mktemp)"
echo "finch: downloading $url"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url"
else
  echo "finch: need curl or wget to install" >&2; exit 1
fi
chmod +x "$tmp"

if [ -w "$BIN_DIR" ]; then
  mv "$tmp" "$BIN_DIR/finch"
else
  echo "finch: installing to $BIN_DIR (needs sudo)"
  sudo mv "$tmp" "$BIN_DIR/finch"
fi

echo "finch: installed to $BIN_DIR/finch"
echo ""
echo "  Next:   finch login --hub $HUB     # log in (once)"
echo "  Then:   finch add <name> --service http://127.0.0.1:8000 && finch run"
echo ""
echo "  Driving finch with an AI agent? Run 'finch guide' for a full manual,"
echo "  or just tell it: \\"use finch — run 'finch guide' first.\\""
`;
}
