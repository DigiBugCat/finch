/// <reference types="@cloudflare/workers-types" />
//
// Finch hub — the thin control plane. "We handle auth + routing + hosting,
// you handle the logic." This Worker resolves the tenant, then either:
//   - serves the control API (/api/*, /join) — see api.ts
//   - relays MCP / agent traffic to the per-MACHINE ApplianceDO, gated by a
//     finch_ key check against the tenant's TenantDO.
//
// Tenancy: every request belongs to a tenant (a Clerk org id, or user id).
//   - Control-plane requests (from the web app) carry X-Finch-Tenant explicitly
//     — that IS the real tenant id, so control-plane TenantDOs are keyed by it.
//   - MCP / relay traffic carries only a vanity HOST slug (<slug>.finchmcp.com),
//     which is NOT the tenant id. The relay resolves the slug to the tenant id
//     via the singleton RouterDO (slug→tenantId index) and keys TenantDO +
//     ApplianceDO by THAT tenant id. Unknown slug FAILS CLOSED (404). The
//     DEFAULT_TENANT fallback exists ONLY for local dev (env.DEV === "1").

import { ApplianceDO } from "./appliance-do";
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

export { ApplianceDO, TenantDO, RouterDO };

export interface Env {
  // Durable Object namespaces.
  APPLIANCE: DurableObjectNamespace; // per-machine WS relay (ApplianceDO)
  TENANT: DurableObjectNamespace; // per-tenant control-plane state (TenantDO)
  ROUTER: DurableObjectNamespace; // singleton slug→tenantId index (RouterDO)

  // Secrets / vars (wrangler vars in dev via .dev.vars; secrets in prod).
  FINCH_SERVICE_SECRET: string; // web-app -> control API shared secret
  TICKET_SECRET: string; // HMAC key for join tickets + per-machine connect-tokens
  // SEPARATE HMAC key for the browser login-wall session cookie (kind:"session").
  // Kept distinct from TICKET_SECRET so a leaked session signer can NOT forge a
  // join/connect/portal grant (and vice-versa). Set per env via
  //   wrangler secret put SESSION_SECRET --env <staging|production>
  // In dev/test it's injected as a var fixture (see wrangler.test.jsonc).
  SESSION_SECRET: string;
  DEFAULT_TENANT?: string; // DEV-ONLY tenant fallback when no slug resolves
  DEV?: string; // "1" in the dev env; gates the DEFAULT_TENANT fallback
  WEB_URL?: string; // dashboard base URL — the `finch login` device page lives at <WEB_URL>/cli
  AI: Ai; // Workers AI binding — powers the /chat test interface
  SELF: Fetcher; // self service-binding — /chat relays MCP back through our own appliance path

  // Where GET /releases/<asset> redirects to fetch the agent binary. Defaults to
  // the project's GitHub Releases "latest" assets; override per-env if binaries
  // are hosted elsewhere (e.g. an R2 bucket).
  RELEASES_BASE?: string;

  // Cloudflare Rate Limiting bindings (unsafe.bindings ratelimit). Optional so
  // tests / `wrangler dev` without the binding still run (limiter() no-ops when
  // absent). RELAY_LIMIT gates per-(tenant,IP) on the MCP relay BEFORE the
  // checkKey DO round-trip; JOIN_LIMIT gates per-IP on /join.
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
// from summing past DO heap. Enforced here pre-stub AND in ApplianceDO.fetch.
const MAX_RELAY_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB

// Browser login-wall session cookie lifetime (12h). The cookie is the long-lived
// proof a browser already cleared the Clerk wall; the portal hand-off grant that
// mints it is short (~60s, single-use). 12h balances "don't re-login constantly"
// against the blast radius of a stolen cookie (also revocable via sessionEpoch).
const SESSION_TTL_SECONDS = 12 * 60 * 60;

// The login-wall cookie name. HttpOnly + Secure + SameSite=Lax + Path=/, and
// HOST-scoped (no Domain attribute) so a cookie minted for <slug>.finchmcp.com
// can't be replayed against a sibling tenant's slug host.
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
 *  pinned-machine and load-balanced branches. It decides whether the login wall
 *  applies, per the contract's core rule:
 *    1. Bearer finch_ present                 → pass (MCP/key plane; relayMcp's
 *       checkKey gate is the real authority — the wall is BYPASSED).
 *    2. svc-authed (FINCH_SERVICE_SECRET + a valid assertion for THIS tenant)
 *                                              → pass (dashboard test-in-chat).
 *    3. appliance.auth === "public"            → pass (explicit open opt-out).
 *    4. otherwise (a browser, no finch_ bearer) → browserGate: a valid
 *       finch_session cookie passes as browserAuthed; else 302 to the login wall.
 *  Returns {wall} to short-circuit, or {browserAuthed} to let relayMcp proceed.
 *  We resolve the appliance's auth mode via the SAME checkKey op the relay uses
 *  (public:true short-circuits) so the two can never disagree. A browserAuthed
 *  pass authorizes the RELAY (it cleared the wall); relayMcp still strips the key
 *  and records the call, but does NOT re-run the per-key checkKey gate. */
async function maybeBrowserGate(
  req: Request,
  env: Env,
  tenant: string,
  slug: string,
  appliance: string,
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

  // 3. Public appliance → no wall (the explicit opt-out). We ask checkKey with an
  //    empty hash: a public appliance returns {public:true} regardless of key.
  //    (A slug host with no usable slug — dev fallback — also has none to bind a
  //    cookie to; skip the wall there too rather than bounce to a dead slug. The
  //    relay's own checkKey then enforces the key gate as before.)
  if (!slug) return { browserAuthed: false };
  const probe = await tenantOp<{ public?: boolean }>(env, tenant, "checkKey", {
    hash: "",
    appliance,
  });
  if (probe?.public) return { browserAuthed: false };

  // 4. A browser on a private appliance → require the session cookie.
  return browserGate(req, env, tenant, slug, originalPathAndQuery);
}

/** browserGate — the login-wall decision for a relay request that is NOT a
 *  finch_ bearer call, NOT service-authed, and NOT a public appliance (the
 *  caller checks those first). For such a request (a plain browser hit on a
 *  PRIVATE appliance) we require a valid finch_session cookie bound to THIS
 *  tenant+slug whose epoch matches the tenant's current sessionEpoch. A valid
 *  cookie passes as {browserAuthed:true} (relayMcp skips the key gate); a
 *  missing/invalid/stale cookie 302s to the Clerk-gated portal start page. The
 *  cookie is the ONLY thing checked here; the appliance-private check is upstream. */
async function browserGate(
  req: Request,
  env: Env,
  tenant: string,
  slug: string,
  originalPathAndQuery: string,
): Promise<GateDecision> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) {
    const sess = await verifySession(cookie, env.SESSION_SECRET);
    if (
      sess &&
      sess.kind === "session" &&
      sess.tenant === tenant &&
      sess.slug === slug
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
  // the dashboard origin; the portal page re-mints a portal grant for this slug
  // and hands the browser back to /__finch/cb here. `rd` carries the original
  // path+query so the user lands where they meant to after login.
  const webBase = (env.WEB_URL || "https://finchmcp.com").replace(/\/+$/, "");
  const target =
    `${webBase}/portal/start?slug=${encodeURIComponent(slug)}` +
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
 *  so a bad encoding degrades to "wrong machine" rather than a 500. */
function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** Extract the vanity host slug for an MCP/relay request.
 *  `<slug>.finchmcp.com` -> `<slug>`. Returns "" for the apex, `www`,
 *  `*.workers.dev`, localhost, or anything without a usable subdomain. */
function slugFromHost(host: string): string {
  const h = (host || "").split(":")[0].toLowerCase();
  const labels = h.split(".").filter(Boolean);
  // <slug>.finchmcp.com -> ["<slug>", "finchmcp", "com"]
  if (labels.length >= 3 && labels[labels.length - 2] === "finchmcp") {
    const sub = labels[0];
    if (sub && sub !== "www") return sub;
  }
  return "";
}

/** Resolve the tenant id for an MCP/relay request from the host slug.
 *  slug -> RouterDO.lookup -> tenant id. FAILS CLOSED: an unknown slug returns
 *  null (the caller turns that into a 404). The DEFAULT_TENANT fallback is
 *  consulted ONLY in dev (env.DEV === "1") so prod never silently falls back. */
async function resolveTenant(host: string, env: Env): Promise<string | null> {
  const slug = slugFromHost(host);
  if (slug) {
    const tenant = await routerLookup(env, slug);
    if (tenant) return tenant;
  }
  // No usable/registered slug (unregistered slug, apex, www, workers.dev,
  // localhost): fail closed in prod; dev-only DEFAULT_TENANT fallback otherwise.
  if (env.DEV === "1" && env.DEFAULT_TENANT) return env.DEFAULT_TENANT;
  return null;
}

/** Tenant DO stub for a tenant id. */
function tenantStub(env: Env, tenant: string) {
  return env.TENANT.get(env.TENANT.idFromName(tenant));
}

/** Per-machine relay DO stub. Keyed `${tenant}:${appliance}:${machine}`. */
function machineStub(
  env: Env,
  tenant: string,
  appliance: string,
  machine: string,
) {
  return env.APPLIANCE.get(
    env.APPLIANCE.idFromName(`${tenant}:${appliance}:${machine}`),
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

    // ---- /chat — a tiny test chat that drives an appliance's MCP tools via a
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
    const tenant = await resolveTenant(host, env);
    if (!tenant) {
      return json(404, {
        error: "tenant could not be resolved from host",
        host,
      });
    }

    // ---- Login-wall hand-off endpoints. RESERVED paths, handled BEFORE the
    //      appliance relay so a slug named "__finch" can never shadow them
    //      (mirrors how _connect/releases are reserved). Both run on the slug
    //      host (<slug>.finchmcp.com), where the tenant is already resolved. ----
    if (path === "/__finch/cb" && req.method === "GET") {
      return handleFinchCb(req, env, url, host, tenant);
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

    const appliance = parts[0];
    const second = parts[1];

    // The path segment is percent-ENCODED, but the control plane (api.ts /
    // tenant-do.ts) stores the machine name DECODED. Decode at the edge so the
    // connect-token assertion (payload.machine === machine) and the ApplianceDO
    // idFromName key both compare against the same value the box joined under —
    // otherwise a non-ASCII or spaced name (e.g. "My Mac" → "My%20Mac") 401s on
    // _connect and routes to the wrong (empty) DO → 503 on mcp. We re-encode
    // only when building outward URL strings. (code-review #11)
    const machine = second ? safeDecode(second) : "";

    // /<appliance>/<machine>/_connect  — agent dials in (WS upgrade).
    // /<appliance>/<machine>/mcp        — public MCP call to a specific machine.
    // /<appliance>/mcp                  — load-balanced across the appliance.

    // Agent registration: /<appliance>/<machine>/_connect
    if (second && parts[2] === "_connect") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      // AUTHENTICATE THE AGENT CHANNEL before forwarding to the relay DO. The
      // agent presents the per-machine connect-token (minted at /join) as
      // ?ct=<token>. We verify the HMAC + expiry AND assert it was issued for
      // exactly this resolved route (kind+tenant+appliance+machine). FAIL CLOSED
      // → 401 — without this anyone who guesses a slug/appliance/machine could
      // hijack the relay socket and harvest callers' finch_ keys.
      const ct = url.searchParams.get("ct") || "";
      const payload = ct ? await verifyToken(ct, env.TICKET_SECRET) : null;
      if (
        !payload ||
        payload.kind !== "connect" ||
        payload.tenant !== tenant ||
        payload.appliance !== appliance ||
        payload.machine !== machine
      ) {
        return json(401, { error: "invalid or missing connect token" });
      }
      // Stash tenant/appliance/machine on the _connect URL so the relay DO can
      // serializeAttachment them (survives hibernation) and call markMachine.
      const connectUrl = new URL(req.url);
      connectUrl.searchParams.set("tenant", tenant);
      connectUrl.searchParams.set("appliance", appliance);
      connectUrl.searchParams.set("machine", machine);
      const stub = machineStub(env, tenant, appliance, machine);
      return stub.fetch(new Request(connectUrl.toString(), req));
    }

    // Generic public relay: forward ANY path under the appliance to the box —
    // finch is a protocol-agnostic tunnel, not MCP-only. /<app>/mcp (MCP),
    // /<app>/ and /<app>/index.html (a website), /<app>/api/... (any HTTP) all
    // relay. The optional <machine> pin is resolved POSITIONALLY: if the second
    // segment names a REGISTERED machine of this appliance, it pins that machine
    // and the upstream path is everything after it; otherwise the whole tail is
    // the upstream and we load-balance across the appliance's healthy pool.
    // (`_connect` is the one reserved segment, handled above before we get here.)
    if (appliance) {
      // LOGIN WALL (auth-by-request-type). For a browser hit (no finch_ bearer,
      // not svc-authed) on a PRIVATE appliance, bounce to the Clerk-gated portal
      // unless a valid finch_session cookie is present. finch_ key calls, the
      // dashboard's service-authed test-in-chat, and PUBLIC appliances all pass
      // through untouched. Computed once here; covers BOTH the pinned-machine and
      // the load-balanced branch below.
      const slug = slugFromHost(host);
      const originalPathAndQuery = path + (url.search || "");
      const gate = await maybeBrowserGate(
        req,
        env,
        tenant,
        slug,
        appliance,
        originalPathAndQuery,
      );
      if (gate.wall) return gate.wall;
      // A valid session cookie authorizes the relay as a web caller (cleared the
      // wall) — relayMcp skips the per-key checkKey gate for it, like svcAuthed.
      const browserAuthed = gate.browserAuthed;

      let pinned = "";
      if (second) {
        // `machine` is the DECODED name (safeDecode at the edge) — it matches the
        // stored registry entry and keys the ApplianceDO. A path whose first
        // segment merely COLLIDES with a machine name pins that machine; this
        // positional ambiguity is inherent to /<app>/<machine?>/<path> routing.
        const ex = await tenantOp<{ exists: boolean }>(
          env,
          tenant,
          "machineExists",
          { appliance, machine },
        );
        if (ex?.exists) pinned = machine;
      }

      if (pinned) {
        // Specific machine: upstream = everything after <appliance>/<machine>.
        const upstream = parts.slice(2).join("/");
        return relayMcp(req, env, ctx, tenant, appliance, pinned, path, upstream, browserAuthed);
      }

      // Load-balanced across the appliance. Upstream = everything after
      // <appliance> (the resolved <machine> is injected by relayMcp so the DO's
      // two-segment strip yields this path; an empty tail yields "/"). Pick the
      // WHOLE healthy pool (shuffled) and FAIL OVER inside relayMcp on a
      // stale-pick "appliance offline" 503. (code-review #12)
      const upstream = parts.slice(1).join("/");
      const pool = await pickHealthyPool(env, tenant, appliance);
      if (!pool.length) {
        // No healthy machine at all. Record this 503 too, so a load-balanced
        // offline call is just as visible in the dashboard (logs / recentCalls /
        // err) as a specific-machine offline 503. Best-effort caller attribution.
        const caller = await callerLabel(req, env, tenant, appliance);
        ctx.waitUntil(
          tenantOp(env, tenant, "recordCall", {
            appliance,
            machine: "—",
            status: 503,
            ms: 0,
            caller,
            route: path,
          }).catch(() => {}),
        );
        return json(503, { error: "appliance offline", appliance });
      }
      return relayMcp(req, env, ctx, tenant, appliance, pool, path, upstream, browserAuthed);
    }

    return json(404, { error: "not found", path });
  },
};

/** The shuffled pool of online machine names for an appliance (load-balance +
 *  failover). Uses the UNIFIED liveness rule (connected AND not pending) so the
 *  picker and the dashboard agree. Reads TenantDO getState. Empty if none. */
async function pickHealthyPool(
  env: Env,
  tenant: string,
  appliance: string,
): Promise<string[]> {
  const state = await tenantOp(env, tenant, "getState");
  const ap = (state?.appliances ?? []).find((a: any) => a.id === appliance);
  if (!ap) return [];
  const machines: any[] = ap.machines ?? [];
  // online = holds a live socket AND approved (matches tenant-do machineOnline).
  const healthy = machines.filter(
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
  appliance: string,
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
      { hash, appliance },
    );
    return check.keyLabel || "finch_key";
  } catch {
    return "finch_key";
  }
}

/** Extract a Bearer finch_ key, check it against the tenant's TenantDO, relay to
 *  the per-machine ApplianceDO, and record the call. 401 if the key is absent or
 *  not allowed for this appliance. `machineOrPool` is a single machine name (the
 *  specific-machine route) or a shuffled candidate pool (the LB route) that we
 *  fail over on a DO "appliance offline" 503. `browserAuthed` is set when the
 *  caller already cleared the browser login wall with a valid finch_session
 *  cookie — that authorizes the relay (we skip the per-key checkKey gate, exactly
 *  like the service-authed dashboard path), label the caller "web", and still
 *  strip credentials + record the call. */
async function relayMcp(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  tenant: string,
  appliance: string,
  machineOrPool: string | string[],
  route: string,
  upstream: string,
  browserAuthed = false,
): Promise<Response> {
  // THROTTLE FIRST — before the checkKey DO round-trip. A well-formed-but-wrong
  // Bearer finch_ otherwise forces a checkKey + state load per request; gating
  // per-(tenant,IP) here makes a cheap DO-invocation DoS expensive. (security M5)
  const ip = clientIp(req);
  if (!(await rateLimitOk(env.RELAY_LIMIT, `${tenant}:${ip}`))) {
    return json(429, { error: "rate limited" });
  }

  // REQUEST-SIZE CAP — reject oversized bodies before buffering them into a DO.
  // content-length is client-controlled/absent for chunked, so this is a cheap
  // first gate; ApplianceDO enforces the real limit on the buffered string. (#16)
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
  // gate. The wall already proved the appliance is reachable by this session.
  if (!svcAuthed && !browserAuthed) {
    // ALWAYS consult the TenantDO — even with NO bearer — because a PUBLIC
    // appliance (an open webpage) must be reachable without a key. We parse the
    // bearer when present (empty hash when absent) and let checkKey decide:
    //   public appliance        → allowed regardless of key (check.public)
    //   key appliance, no key    → not allowed, no bearer presented → 401
    //   key appliance, bad key   → not allowed, reason-mapped       → 403
    // So key-gated appliances behave EXACTLY as before; only public ones open up.
    const auth = req.headers.get("authorization") || "";
    const m = auth.match(/^Bearer\s+(finch_[A-Za-z0-9_-]+)$/);
    const hash = m ? await hashKey(m[1]) : "";
    const check = await tenantOp<{
      allowed: boolean;
      keyLabel: string;
      public?: boolean;
      reason?: "no-key" | "scope" | "acl" | "expired";
    }>(env, tenant, "checkKey", { hash, appliance });
    if (!check.allowed) {
      // No bearer at all on a key-gated appliance → the shape-level 401 (same as
      // before). A present-but-rejected key → 403 with the cause distinguished
      // ("unknown key" vs "known key, not granted by the tenant's ACL").
      if (!m) {
        return json(401, { error: "missing or malformed finch_ bearer key" });
      }
      const error =
        check.reason === "acl"
          ? "no ACL rule grants this key access to this appliance"
          : check.reason === "scope"
            ? "key scope does not include this appliance"
            : check.reason === "expired"
              ? "key has expired"
              : "key not allowed for this appliance";
      return json(403, { error });
    }
    caller = check.public ? "public" : check.keyLabel || "finch_key";
  }
  const pool =
    typeof machineOrPool === "string" ? [machineOrPool] : machineOrPool;

  // KEY-STRIP: the caller's finch_ key must NEVER cross the trust boundary into
  // the box's local upstream. Clone the headers and delete the Authorization
  // header (and any header that still carries a finch_ value) BEFORE building
  // the relay request. The agent strips hop-by-hop headers as defense-in-depth,
  // but the credential must be gone at the source. (If a box upstream needs its
  // own auth, inject a per-appliance secret downstream — never the caller key.)
  const relayHeaders = new Headers(req.headers);
  relayHeaders.delete("authorization");
  relayHeaders.delete("x-finch-service"); // never leak the service secret to a box
  relayHeaders.delete("x-finch-auth");
  for (const [name, value] of [...relayHeaders.entries()]) {
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
  let res = json(503, { error: "appliance offline", appliance });
  let usedMachine = pool[0];
  for (const machine of pool) {
    usedMachine = machine;
    // Normalize the forwarded URL to /<appliance>/<machine>/<rest>. ApplianceDO
    // strips exactly TWO leading segments to derive the upstream path. For the LB
    // entry (/<appliance>/mcp) the resolved <machine> isn't in the URL, so this
    // rewrite is what lets the DO yield "/mcp" instead of "/".
    const inUrl = new URL(req.url);
    inUrl.pathname =
      `/${appliance}/${encodeURIComponent(machine)}` +
      (upstream ? `/${upstream}` : "");
    const relayReq = new Request(inUrl.toString(), {
      method: req.method,
      headers: relayHeaders,
      body: bodyBytes,
    } as RequestInit);

    const stub = machineStub(env, tenant, appliance, machine);
    try {
      res = await stub.fetch(relayReq);
    } catch (e) {
      res = json(502, { error: `relay failed: ${e}` });
    }
    // FAIL OVER only on the DO's own "appliance offline" signal (no agent socket
    // for this machine) — a stale pick. Any other status (including an upstream
    // 503) is the box's real answer and is returned as-is. The DO tags its
    // offline 503 with X-Finch-Offline so we don't have to read the body.
    if (res.status === 503 && res.headers.get("X-Finch-Offline") === "1") {
      // Reconcile: the picked machine had no agent socket, so its persisted
      // liveness is stale. Mark it offline (here, where the tenant is known —
      // the public relay path doesn't carry tenant down to the DO) so the next
      // pick excludes it. Fire-and-forget. (code-review #12)
      ctx.waitUntil(
        tenantOp(env, tenant, "markMachine", {
          appliance,
          machine,
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
      appliance,
      machine: usedMachine,
      status: res.status,
      ms,
      caller,
      route,
    }).catch(() => {}),
  );

  return res;
}

/** GET /__finch/cb?g=<grant>&rd=<relpath> — the login-wall callback on the slug
 *  host. The Clerk-authed portal page (web) mints a short single-use PORTAL grant
 *  and hands the browser here. We:
 *    1. verifyToken(g, TICKET_SECRET) and assert kind==="portal".
 *    2. Bind it to THIS host: grant.tenant === resolved tenant AND grant.slug ===
 *       slugFromHost(host). A grant for another tenant/slug is refused (the slug
 *       host is the security boundary — a grant minted for X can't set a cookie
 *       on Y).
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
  host: string,
  tenant: string,
): Promise<Response> {
  const slug = slugFromHost(host);
  const rd = safeRelPath(url.searchParams.get("rd"));

  // Re-bounce target if anything is wrong: back through the Clerk-gated portal.
  const webBase = (env.WEB_URL || "https://finchmcp.com").replace(/\/+$/, "");
  const reBounce = () =>
    Response.redirect(
      `${webBase}/portal/start?slug=${encodeURIComponent(slug)}&rd=${encodeURIComponent(rd)}`,
      302,
    );

  const grantTok = url.searchParams.get("g") || "";
  if (!grantTok || !slug) return reBounce();

  const grant = await verifyToken(grantTok, env.TICKET_SECRET);
  if (
    !grant ||
    grant.kind !== "portal" ||
    grant.tenant !== tenant ||
    grant.slug !== slug ||
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
      slug,
      userId: grant.userId,
      epoch: epoch ?? 0,
      exp,
    } as TicketPayload,
    env.SESSION_SECRET,
  );

  // HOST-scoped cookie (NO Domain) so it can't be replayed against a sibling
  // tenant's slug host. HttpOnly + Secure + SameSite=Lax + Path=/.
  return new Response(null, {
    status: 302,
    headers: {
      location: rd,
      "set-cookie": `${SESSION_COOKIE}=${session}; HttpOnly; Secure; SameSite=Lax; Path=/`,
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
