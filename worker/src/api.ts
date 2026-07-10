/// <reference types="@cloudflare/workers-types" />
//
// api.ts — Finch control-plane router. Pure routing + marshaling: it parses the
// HTTP request, authenticates it, calls the right TenantDO op via the DO's
// internal fetch RPC, and shapes the response into the canonical types. No
// business logic lives here — that's all in TenantDO.
//
// Auth model:
//   - Every /api/* route is SERVICE-authed: the web app proves itself with the
//     shared X-Finch-Service secret and names the tenant with X-Finch-Tenant.
//   - /join is the ONE exception — it's TICKET-authed (the box presents the
//     stateless join ticket it was handed at enroll). No service secret.

import { rateLimitOk, clientIp, json, tenantOp, boxStub, type Env } from "./index";
import {
  serviceOk,
  signToken,
  verifyToken,
  verifyAssertion,
  genJti,
} from "./auth";
import {
  routerLookup,
  routerRegister,
  routerUnregister,
  routerListForTenant,
  isValidHostKey,
  routerDeviceStart,
  routerDevicePoll,
  routerDeviceApprove,
  routerDeviceDescribe,
} from "./router-do";
import { signAssertion, verifyAssertionPayload } from "./auth";
import {
  handleAviaryEnrollmentApi,
  handleAviaryEnrollmentCliApi,
  isAviaryEnrollmentPath,
} from "./aviary-enrollment-api";

// A CLI token is a long-lived tenant assertion, distinguished from a per-call
// assertion by kind:"cli" + an epoch the tenant can bump to revoke. 30 days.
const CLI_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// Mint a CLI token bound to the tenant's CURRENT cliTokenEpoch (so a later
// "revoke all CLI tokens" invalidates it without rotating the global secret).
async function mintCliToken(
  env: Env,
  tenant: string,
  host: string,
): Promise<{ token: string; expiresAt: number; hub: string }> {
  const { epoch } = await tenantOp<{ epoch: number }>(env, tenant, "cliEpoch");
  const exp = Math.floor(Date.now() / 1000) + CLI_TOKEN_TTL_SECONDS;
  const token = await signAssertion(
    { tenant, exp, kind: "cli", epoch: epoch ?? 0 },
    env.FINCH_SERVICE_SECRET,
  );
  const scheme =
    host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  return { token, expiresAt: exp, hub: `${scheme}://${host}` };
}

/** Hex token of `bytes` random bytes. */
function randomToken(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** A short, human-friendly device code like "WXYZ-2K7Q" (no ambiguous chars). */
function randomUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I,O,0,1
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[b[i] % alphabet.length];
  return s.slice(0, 4) + "-" + s.slice(4);
}
import type {
  EnrollResp,
  JoinResp,
  RefreshResp,
  MintKeyResp,
  TenantState,
  PublicKey,
} from "./types";
import { LATEST_AGENT } from "./types";

// Join tickets are short-lived AND single-use (jti replay-checked at /join), so
// a 15-minute window is ample for the enroll → install → join flow while sharply
// bounding the replay surface a captured ticket exposes. (security M1)
const TICKET_TTL_SECONDS = 15 * 60; // join tickets live 15m
const CONNECT_TOKEN_TTL_SECONDS = 120; // per-box _connect grants live 120s
// The agent keeps its refresh token across the whole enrollment lifetime and
// trades it for fresh connect-tokens at /refresh, so it never re-uses the
// one-shot join ticket. 30 days bounds the credential while comfortably covering
// any realistic always-on uptime; a box removed from the dashboard is
// rejected at /refresh (boxExists) well before this elapses.
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d
// Browser login-wall portal grant: short + single-use (jti). 60s is ample for the
// portal page → /__finch/cb hand-off while sharply bounding the replay window of
// a captured grant (which is also burned on first use). (login-wall contract)
const PORTAL_GRANT_TTL_SECONDS = 60;
const DEFAULT_BYO_CNAME_TARGET = "finchmcp.com";

// Box-name clamp at the door (M1): bound length + charset before the name
// ever reaches the registry. Mirrors tenant-do's cleanBoxName.
const MAX_BOX_NAME = 64;
const BOX_NAME_RE = /^[A-Za-z0-9 ._\-]+$/;
function cleanBox(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > MAX_BOX_NAME) return null;
  if (!BOX_NAME_RE.test(name)) return null;
  return name;
}

function normalizeHostname(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function vanitySuffixes(env: Env): string[] {
  return (env.VANITY_SUFFIXES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function underSuffix(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function vanityTier(env: Env, hostname: string): boolean {
  return vanitySuffixes(env).some((suffix) => underSuffix(hostname, suffix));
}

function validateCustomHostname(hostname: string): boolean {
  return hostname.includes(".") && isValidHostKey(hostname);
}

function cfHeaders(env: Env): HeadersInit {
  return {
    authorization: `Bearer ${env.CF_API_TOKEN || ""}`,
    "content-type": "application/json",
  };
}

async function provisionCfHostname(
  env: Env,
  hostname: string,
): Promise<{ ok: boolean; ssl?: unknown; error?: unknown }> {
  if (!env.CF_API_TOKEN || !env.CF_SAAS_ZONE_ID) return { ok: true };
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_SAAS_ZONE_ID}/custom_hostnames`,
    {
      method: "POST",
      headers: cfHeaders(env),
      body: JSON.stringify({ hostname, ssl: { method: "http", type: "dv" } }),
    },
  );
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = { error: await res.text().catch(() => "") };
  }
  if (!res.ok || data?.success === false) {
    return { ok: false, error: data };
  }
  return { ok: true, ssl: data?.result?.ssl?.status };
}

async function bestEffortDeleteCfHostname(env: Env, hostname: string): Promise<void> {
  if (!env.CF_API_TOKEN || !env.CF_SAAS_ZONE_ID) return;
  try {
    const qs = new URLSearchParams({ hostname });
    const list = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_SAAS_ZONE_ID}/custom_hostnames?${qs}`,
      { method: "GET", headers: cfHeaders(env) },
    );
    const data: any = await list.json().catch(() => null);
    const id = data?.result?.[0]?.id;
    if (!list.ok || !id) return;
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_SAAS_ZONE_ID}/custom_hostnames/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: cfHeaders(env) },
    ).catch(() => {});
  } catch {
    // Best-effort cleanup only. Never log the CF token.
  }
}

/** True if this path is handled by the control API (vs the MCP/relay plane). */
export function isApiPath(path: string): boolean {
  return (
    path === "/join" ||
    path === "/refresh" ||
    path === "/api" ||
    path.startsWith("/api/")
  );
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/** Percent-decode a path segment, tolerating a malformed encoding (a lone "%"
 *  makes decodeURIComponent throw a URIError → an unhandled 500). Falls back to
 *  the raw value so a bad id degrades to a clean not-found/4xx. Mirrors index.ts's
 *  safeDecode. (code-review #15) */
function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export async function handleApi(
  req: Request,
  env: Env,
  host: string,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Aviary service-device enrollment is intentionally separate from the CLI
  // tenant-admin device flow. start/poll are proof-bound public routes;
  // describe/approve/deny authenticate inside their dedicated handler.
  if (isAviaryEnrollmentPath(path)) {
    return handleAviaryEnrollmentApi(req, env, host);
  }

  // ---- /join — ticket-authed (NOT service-authed) ----
  if (path === "/join") {
    if (method !== "POST") return json(405, { error: "POST only" });
    return handleJoin(req, env, host);
  }

  // ---- /refresh — refresh-token-authed (NOT service-authed). The box trades
  //      its long-lived per-box refresh token for a fresh connect-token,
  //      so steady-state reconnection never re-uses the one-shot join ticket. ----
  if (path === "/refresh") {
    if (method !== "POST") return json(405, { error: "POST only" });
    return handleRefresh(req, env, host);
  }

  // ---- /api/version — public, unauthenticated. The current agent version, so
  //      `finch update` can no-op when a box is already on the latest build.
  //      Mirrors the LATEST_AGENT literal the dashboard's update tooltip reads. ----
  if (path === "/api/version" && method === "GET") {
    return json(200, { latest: LATEST_AGENT });
  }

  // ---- /api/cli/* — authed by a CLI token (a long-lived tenant assertion the
  //      dashboard issues), presented as `Authorization: Bearer <token>`. NOT
  //      service-secret-authed: the assertion is itself HMAC-signed with
  //      FINCH_SERVICE_SECRET, so a valid one already proves tenant authorization
  //      (same trust as X-Finch-Auth). This lets the `finch` CLI enroll
  //      services from the box without the dashboard. ----
  if (path.startsWith("/api/cli/")) {
    // ---- Public device-authorization flow (`finch login`): the CLI has no
    //      credentials yet, so start/poll are unauthenticated. The browser
    //      (Clerk-authed) approves the short user_code out of band. device/start
    //      ALSO returns verification_uri_complete = <web>/cli?code=<user_code> to
    //      pre-fill the code for one-click UX. The security binding is preserved:
    //      /cli still requires a Clerk-authed, deliberate Approve click and shows
    //      the initiator's IP/UA context (anti-phishing) — pre-filling the code
    //      does not auto-approve. ----
    if (path === "/api/cli/device/start" && method === "POST") {
      // Throttle code CREATION per IP (you don't start many logins/min). Poll
      // is intentionally NOT throttled — it needs the 256-bit device_code and
      // the CLI legitimately polls every few seconds.
      if (!(await rateLimitOk(env.JOIN_LIMIT, `devstart:${clientIp(req)}`))) {
        return json(429, { error: "too many login attempts — try again shortly" });
      }
      const deviceCode = randomToken(32);
      const userCode = randomUserCode();
      // Capture the initiator's context so the approver can tell it's THEIR box.
      const reqIp = clientIp(req);
      const reqUa = (req.headers.get("user-agent") || "").slice(0, 200);
      const started = await routerDeviceStart(env, deviceCode, userCode, reqIp, reqUa);
      if (!started.ok) return json(429, { error: "too many pending logins — try again shortly" });
      const webBase = (env.WEB_URL || `https://${host}`).replace(/\/$/, "");
      return json(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${webBase}/cli`,
        // Pre-filled one-click link — the agent prefers this over verification_uri.
        // encodeURIComponent is defensive; userCode is [A-Z0-9-] and already safe.
        verification_uri_complete: `${webBase}/cli?code=${encodeURIComponent(userCode)}`,
        expires_in: 600,
        interval: 3,
      });
    }
    if (path === "/api/cli/device/poll" && method === "POST") {
      const body = await readJson(req);
      if (!body.device_code) return json(400, { error: "device_code required" });
      return json(200, await routerDevicePoll(env, String(body.device_code)));
    }

    // Throttle the AUTHENTICATED bearer routes per-IP (the CLI's real IP) — not
    // device/poll above, whose secret device_code is the real gate.
    if (!(await rateLimitOk(env.JOIN_LIMIT, `cli:${clientIp(req)}`))) {
      return json(429, { error: "rate limited" });
    }

    // Bearer must be a CLI token (kind:"cli") whose epoch still matches the
    // tenant's current cliTokenEpoch (else it was revoked).
    const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
    const payload = m ? await verifyAssertionPayload(m[1], env.FINCH_SERVICE_SECRET) : null;
    const cliTenant = payload && payload.kind === "cli" ? payload.tenant : null;
    if (!cliTenant) {
      return json(401, { error: "missing, invalid, or expired CLI token (Authorization: Bearer …)" });
    }
    const { epoch: curEpoch } = await tenantOp<{ epoch: number }>(env, cliTenant, "cliEpoch");
    if ((payload!.epoch ?? -1) !== (curEpoch ?? 0)) {
      return json(401, { error: "CLI token revoked — run `finch login` again" });
    }
    if (path === "/api/cli/hostnames") {
      return handleHostnames(req, env, cliTenant, method);
    }
    // GET /api/cli/whoami — validate a token + report the tenant it acts as.
    if (path === "/api/cli/whoami" && method === "GET") {
      return json(200, { ok: true, tenant: cliTenant });
    }
    // Tenant-admin, headless approval for Aviary service-device enrollment.
    // This is the same proof-bound transaction used by the browser flow; only
    // the approver authentication differs (revocable CLI token vs web BFF).
    if (path.startsWith("/api/cli/aviary/")) {
      return handleAviaryEnrollmentCliApi(req, env, host, cliTenant);
    }
    // POST /api/cli/token — an already-authed box mints a FRESH CLI token, so a
    // new box can be provisioned with no human in the loop:
    //   ssh newbox "finch login --token $(finch token)"
    // No new capability (the caller already holds a tenant CLI token); the new
    // token is epoch-bound and dies on "revoke all CLI tokens".
    if (path === "/api/cli/token" && method === "POST") {
      return json(200, await mintCliToken(env, cliTenant, host));
    }
    // POST /api/cli/enroll {name,group} — enroll a service, return its ticket.
    if (path === "/api/cli/enroll" && method === "POST") {
      return handleEnroll(req, env, cliTenant, host);
    }
    // POST /api/cli/approve {id} — clear the pending gate (the CLI token holder
    // is the tenant admin, so they can approve their own box from the box).
    if (path === "/api/cli/approve" && method === "POST") {
      const body = await readJson(req);
      if (!body.id) return json(400, { error: "id required" });
      const out = await tenantOp(env, cliTenant, "approve", { id: body.id });
      return json(out?.ok === false ? 404 : 200, out);
    }

    // POST /api/cli/auth {service, mode} — set a service's public-relay
    // access mode ("key" requires a finch_ bearer; "public" is an open webpage).
    if (path === "/api/cli/auth" && method === "POST") {
      const body = await readJson(req);
      if (!body.service) return json(400, { error: "service required" });
      const out = await tenantOp<{ ok: boolean; error?: string }>(
        env,
        cliTenant,
        "setAuth",
        { service: body.service, mode: body.mode },
      );
      if (out?.ok === false) {
        return json(out.error === "unknown service" ? 404 : 400, out);
      }
      return json(200, out);
    }

    // ---- Tenant control plane over the CLI token (it IS a tenant-admin
    //      credential, same as the dashboard) — so an agent can manage and
    //      REVOKE access without the dashboard. ----

    // GET /api/cli/state — full tenant state (fleet, keys, ACL) for finch fleet/keys.
    if (path === "/api/cli/state" && method === "GET") {
      return json(200, await tenantOp(env, cliTenant, "getState"));
    }
    // POST /api/cli/keys {label,scope,owner} — mint a client finch_ key (once).
    if (path === "/api/cli/keys" && method === "POST") {
      const b = await readJson(req);
      if (!b.label) return json(400, { error: "label required" });
      const out = await tenantOp<{ plaintext: string; key: PublicKey } | { error: string }>(
        env, cliTenant, "mintKey", { label: b.label, scope: b.scope, owner: b.owner },
      );
      if ("error" in out) return json(400, { error: out.error });
      return json(200, { key: out.plaintext, ...out.key });
    }
    // POST /api/cli/keys/revoke {id} — revoke a client finch_ key by id.
    if (path === "/api/cli/keys/revoke" && method === "POST") {
      const b = await readJson(req);
      if (!b.id) return json(400, { error: "id required" });
      const out = await tenantOp(env, cliTenant, "revokeBoxKey", { service: "", box: "", key: String(b.id) });
      return json(out?.ok === false ? 404 : 200, out);
    }
    // POST /api/cli/services/release {id} — remove a service.
    if (path === "/api/cli/services/release" && method === "POST") {
      const b = await readJson(req);
      if (!b.id) return json(400, { error: "id required" });
      const out = await tenantOp(env, cliTenant, "release", { id: String(b.id) });
      return json(out?.ok === false ? 404 : 200, out);
    }
    // POST /api/cli/revoke-tokens — de-authorize ALL CLI logins (incl. this one).
    if (path === "/api/cli/revoke-tokens" && method === "POST") {
      return json(200, await tenantOp(env, cliTenant, "revokeCliTokens"));
    }

    // POST /api/cli/call {service, method, params} — relay an MCP call to the
    // tenant's own service, so an agent can test it from the CLI (no throwaway
    // finch_ key). Relays via the SELF binding using a first-party service
    // assertion for cliTenant (the same trusted internal path the chat uses).
    if (path === "/api/cli/call" && method === "POST") {
      const b = await readJson(req);
      const service = String(b.service || "").trim();
      const rpcMethod = String(b.method || "").trim();
      if (!service || !rpcMethod) return json(400, { error: "service and method required" });
      const exp = Math.floor(Date.now() / 1000) + 120;
      const assertion = await signAssertion({ tenant: cliTenant, exp }, env.FINCH_SERVICE_SECRET);
      const scheme = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
      const res = await env.SELF.fetch(`${scheme}://${host}/${encodeURIComponent(service)}/mcp`, {
        method: "POST",
        headers: {
          "X-Finch-Service": env.FINCH_SERVICE_SECRET,
          "X-Finch-Auth": assertion,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: rpcMethod, params: b.params ?? {} }),
      });
      return new Response(await res.text(), {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
      });
    }

    return json(404, { error: "unknown CLI route", path });
  }

  // ---- Everything else under /api requires the service secret + a SIGNED
  //      tenant assertion. The shared service secret proves "a first-party web
  //      worker is calling"; the assertion cryptographically binds WHICH tenant
  //      this request acts as. We IGNORE any raw, unsigned X-Finch-Tenant — only
  //      the HMAC-signed X-Finch-Auth {tenant,exp} is trusted (verified with the
  //      same FINCH_SERVICE_SECRET). A leaked secret alone can't be replayed for
  //      an arbitrary tenant without also forging the signature; an expired
  //      assertion is rejected. ----
  if (!serviceOk(req, env)) {
    return json(401, { error: "bad or missing X-Finch-Service" });
  }
  const assertion = req.headers.get("X-Finch-Auth") || "";
  const tenant = await verifyAssertion(assertion, env.FINCH_SERVICE_SECRET);
  if (!tenant) {
    return json(401, {
      error: "missing, invalid, or expired tenant assertion (X-Finch-Auth)",
    });
  }

  const parts = path.split("/").filter(Boolean); // ["api", ...]
  const seg = parts.slice(1); // strip "api"

  if (seg.length === 1 && seg[0] === "hostnames") {
    return handleHostnames(req, env, tenant, method);
  }

  // GET /api/state
  if (method === "GET" && seg.length === 1 && seg[0] === "state") {
    const state = await tenantOp<TenantState>(env, tenant, "getState");
    return json(200, state);
  }

  // GET /api/slug-available?slug=foo — claim-free availability check for the
  // Hub-domain picker. Available if unowned, or already owned by THIS tenant.
  // POST /api/device-approve {userCode} — the dashboard (Clerk-authed) approves
  // a `finch login` device code: mint a CLI token for this tenant and stamp it
  // onto the pending code so the waiting CLI can poll it.
  // POST /api/cli-describe {userCode} — return the pending code's INITIATOR
  // context so the approver can confirm it's their own device (anti-phishing).
  if (method === "POST" && seg.length === 1 && seg[0] === "cli-describe") {
    if (!(await rateLimitOk(env.JOIN_LIMIT, `describe:${tenant}`))) {
      return json(429, { error: "rate limited" });
    }
    const body = await readJson(req);
    const userCode = String(body.userCode || "").trim();
    if (!userCode) return json(400, { error: "userCode required" });
    return json(200, await routerDeviceDescribe(env, userCode));
  }

  // POST /api/box-update {service, box} — push an out-of-band "update" frame to
  // a LIVE box's relay socket: the agent self-updates from this hub's /releases
  // and re-execs in place (dashboard "update now" button). Tenant-scoped by the
  // verified assertion; the box must exist in this tenant's registry (never
  // spins up a BoxDO for an unknown name). 503 X-Finch-Offline when the box has
  // no live agent socket — the dashboard falls back to the copy-paste hint.
  if (method === "POST" && seg.length === 1 && seg[0] === "box-update") {
    if (!(await rateLimitOk(env.JOIN_LIMIT, `boxupd:${tenant}`))) {
      return json(429, { error: "rate limited" });
    }
    const body = await readJson(req);
    const service = String(body.service || "").trim();
    const box = String(body.box || "").trim();
    if (!service || !box) return json(400, { error: "service and box required" });
    const reg = await tenantOp<{ exists: boolean }>(env, tenant, "boxExists", {
      service,
      box,
    });
    if (!reg?.exists) return json(404, { error: "unknown box" });
    // The DO's /_control gate re-checks this same secret (the public relay can
    // route arbitrary paths to the DO, so path alone is not trust).
    // The DO strips two leading path segments (/<service>/<box>/<rest>).
    const ctlPath = `/${encodeURIComponent(service)}/${encodeURIComponent(box)}/_control`;
    const res = await boxStub(env, tenant, service, box).fetch(
      `https://box${ctlPath}`,
      {
        method: "POST",
        headers: { "X-Finch-Service": env.FINCH_SERVICE_SECRET },
      },
    );
    return res;
  }

  if (method === "POST" && seg.length === 1 && seg[0] === "device-approve") {
    // Attempt limiter, keyed on the verified TENANT — the hub only sees the web
    // BFF's egress IP, so an IP key would collapse to one global bucket.
    if (!(await rateLimitOk(env.JOIN_LIMIT, `approve:${tenant}`))) {
      return json(429, { error: "rate limited" });
    }
    const body = await readJson(req);
    const userCode = String(body.userCode || "").trim();
    if (!userCode) return json(400, { error: "userCode required" });
    // The web BFF (Clerk-authed) passes the approver's email so the box can show
    // who it's signed in as. Best-effort — approval succeeds without it.
    const email = String(body.email || "").slice(0, 200);
    const { token } = await mintCliToken(env, tenant, host);
    const out = await routerDeviceApprove(env, userCode, tenant, token, email);
    if (!out.ok) {
      const msg =
        out.reason === "not-found"
          ? "that code wasn't found — check it and try again"
          : out.reason === "expired"
            ? "that code has expired — run `finch login` again"
            : out.reason === "already-used"
              ? "that code was already approved"
              : "could not approve code";
      return json(out.reason === "not-found" ? 404 : 400, { error: msg });
    }
    return json(200, { ok: true });
  }

  // POST /api/cli-mint — mint a CLI token for this tenant (Settings → CLI access
  // "Generate"). Epoch-bound, so a later cli-revoke kills it.
  if (method === "POST" && seg.length === 1 && seg[0] === "cli-mint") {
    return json(200, await mintCliToken(env, tenant, host));
  }

  // POST /api/cli-revoke — invalidate every outstanding CLI token for this
  // tenant (bumps cliTokenEpoch). The admin's NEXT `finch login` re-issues.
  if (method === "POST" && seg.length === 1 && seg[0] === "cli-revoke") {
    return json(200, await tenantOp(env, tenant, "revokeCliTokens"));
  }

  // POST /api/sessions-revoke — "sign everyone out" of the browser login wall:
  // bump the tenant's sessionEpoch so every live finch_session cookie (stamped
  // with the old epoch) is rejected at the relay gate (browserGate). The web BFF
  // calls this; mirrors cli-revoke for the CLI-token plane.
  if (method === "POST" && seg.length === 1 && seg[0] === "sessions-revoke") {
    return json(200, await tenantOp(env, tenant, "bumpSessionEpoch"));
  }

  // POST /api/portal-grant {slug,userId} — the login-wall hand-off. The Clerk-
  // gated portal page (web) calls this for a browser that hit a private service
  // with no session cookie. The TENANT is the security-critical part and comes
  // from the verified assertion (NOT the body); userId is carried for the cookie's
  // identity/audit. We VERIFY OWNERSHIP — routerLookup(slug) MUST resolve to this
  // tenant — so a tenant can't mint a portal grant for a slug it doesn't own (which
  // would let it set a session cookie on someone else's slug host). 403 otherwise.
  // Returns a short (~60s), single-use (jti) portal grant the browser carries to
  // <slug>.finchmcp.com/__finch/cb.
  if (method === "POST" && seg.length === 1 && seg[0] === "portal-grant") {
    const body = await readJson(req);
    const slug = String(body.slug || "").trim().toLowerCase();
    const userId = String(body.userId || "").trim();
    if (!slug || !userId) {
      return json(400, { error: "slug and userId required" });
    }
    // Ownership check: the slug must belong to THIS tenant (the assertion's
    // tenant). A slug owned by another tenant (or unregistered) is refused — a
    // portal grant for it could otherwise set a cookie on a foreign slug host.
    const owner = await routerLookup(env, slug);
    if (owner !== tenant) {
      return json(403, { error: "slug is not owned by this tenant" });
    }
    const exp = Math.floor(Date.now() / 1000) + PORTAL_GRANT_TTL_SECONDS;
    const grant = await signToken(
      { kind: "portal", tenant, slug, userId, exp, jti: genJti() },
      env.TICKET_SECRET,
    );
    return json(200, { grant });
  }

  if (method === "GET" && seg.length === 1 && seg[0] === "slug-available") {
    const slug = (url.searchParams.get("slug") || "").trim().toLowerCase();
    if (!slug) return json(400, { error: "slug required" });
    const owner = await routerLookup(env, slug);
    return json(200, { slug, available: owner === "" || owner === tenant });
  }

  // POST /api/enroll {name,group}
  if (method === "POST" && seg.length === 1 && seg[0] === "enroll") {
    return handleEnroll(req, env, tenant, host);
  }

  // POST /api/services/:id/release|approve|decline
  if (method === "POST" && seg[0] === "services" && seg.length === 3) {
    const id = safeDecode(seg[1]);
    const action = seg[2];
    if (action === "release" || action === "approve" || action === "decline") {
      const out = await tenantOp(env, tenant, action, { id });
      return json(out?.ok === false ? 404 : 200, out);
    }
    return json(404, { error: "unknown service action", action });
  }

  // PUT /api/services/:id/auth {mode} — set the public-relay access mode
  // ("key" requires a finch_ bearer; "public" is an open webpage). The dashboard
  // BFF half of the generic-HTTP-hosting feature (same op as `finch auth`).
  if (
    method === "PUT" &&
    seg[0] === "services" &&
    seg.length === 3 &&
    seg[2] === "auth"
  ) {
    const id = safeDecode(seg[1]);
    const body = await readJson(req);
    const out = await tenantOp<{ ok: boolean; error?: string }>(
      env,
      tenant,
      "setAuth",
      { service: id, mode: body.mode },
    );
    if (out?.ok === false) {
      return json(out.error === "unknown service" ? 404 : 400, out);
    }
    return json(200, out);
  }

  // PUT /api/services/:id/tags {tags}
  if (
    method === "PUT" &&
    seg[0] === "services" &&
    seg.length === 3 &&
    seg[2] === "tags"
  ) {
    const id = safeDecode(seg[1]);
    const body = await readJson(req);
    const out = await tenantOp(env, tenant, "setTags", {
      id,
      tags: body.tags ?? [],
    });
    return json(out?.ok === false ? 404 : 200, out);
  }

  // PUT /api/services/:id/group {group}
  if (
    method === "PUT" &&
    seg[0] === "services" &&
    seg.length === 3 &&
    seg[2] === "group"
  ) {
    const id = safeDecode(seg[1]);
    const body = await readJson(req);
    const out = await tenantOp(env, tenant, "setGroup", {
      id,
      group: String(body.group ?? ""),
    });
    return json(out?.ok === false ? 404 : 200, out);
  }

  // POST /api/keys {label,scope,owner}. scope is the STRUCTURED KeyScope
  // ({all:true} | {services:[...]}); TenantDO.mintKey validates every listed
  // service id exists and 400s on an unknown id. We pass it through and
  // surface the DO's error verbatim (no validation duplicated here).
  if (method === "POST" && seg.length === 1 && seg[0] === "keys") {
    const body = await readJson(req);
    if (!body.label) return json(400, { error: "label required" });
    const out = await tenantOp<
      { plaintext: string; key: PublicKey } | { error: string }
    >(env, tenant, "mintKey", {
      label: body.label,
      scope: body.scope,
      owner: body.owner,
    });
    if ("error" in out) return json(400, { error: out.error });
    const resp: MintKeyResp = {
      key: out.plaintext,
      label: out.key.label,
      scope: out.key.scope,
    };
    return json(200, resp);
  }

  // POST /api/boxes/:box/keys/revoke {service,key}
  if (
    method === "POST" &&
    seg[0] === "boxes" &&
    seg.length === 4 &&
    seg[2] === "keys" &&
    seg[3] === "revoke"
  ) {
    const box = safeDecode(seg[1]);
    const body = await readJson(req);
    if (!body.service || !body.key) {
      return json(400, { error: "service and key required" });
    }
    const out = await tenantOp(env, tenant, "revokeBoxKey", {
      service: body.service,
      box,
      key: body.key,
    });
    return json(out?.ok === false ? 404 : 200, out);
  }

  // POST /api/acl {src,dst}
  if (method === "POST" && seg.length === 1 && seg[0] === "acl") {
    const body = await readJson(req);
    if (!body.src || !body.dst) {
      return json(400, { error: "src and dst required" });
    }
    const out = await tenantOp(env, tenant, "addAcl", {
      src: body.src,
      dst: body.dst,
    });
    return json(200, out);
  }

  // DELETE /api/acl/:id
  if (method === "DELETE" && seg[0] === "acl" && seg.length === 2) {
    const id = safeDecode(seg[1]);
    const out = await tenantOp(env, tenant, "removeAcl", { id });
    return json(out?.ok === false ? 404 : 200, out);
  }

  // PUT /api/settings {key,val}
  if (method === "PUT" && seg.length === 1 && seg[0] === "settings") {
    const body = await readJson(req);
    if (!body.key) return json(400, { error: "key required" });
    const out = await tenantOp(env, tenant, "updateSetting", {
      key: body.key,
      val: body.val,
    });
    return json(out?.ok === false ? 400 : 200, out);
  }

  return json(404, { error: "no such control route", path, method });
}

async function handleHostnames(
  req: Request,
  env: Env,
  tenant: string,
  method: string,
): Promise<Response> {
  if (method === "GET") {
    const keys = await routerListForTenant(env, tenant);
    return json(200, { hostnames: keys.filter((key) => key.includes(".")) });
  }

  if (method !== "POST" && method !== "DELETE") {
    return json(405, { error: "GET, POST, or DELETE only" });
  }
  if (!(await rateLimitOk(env.JOIN_LIMIT, `hostnames:${tenant}`))) {
    return json(429, { error: "rate limited" });
  }

  const body = await readJson(req);
  const hostname = normalizeHostname(body.hostname);
  if (!validateCustomHostname(hostname)) {
    return json(400, { error: "invalid hostname" });
  }
  // Registration is inert until the domain owner points DNS at us and, for BYO
  // hostnames, Cloudflare validates + issues the cert. Collisions are first-come.
  if (
    hostname === "finchmcp.com" ||
    hostname.endsWith(".finchmcp.com") ||
    hostname === "workers.dev" ||
    hostname.endsWith(".workers.dev")
  ) {
    return json(400, { error: "reserved hostname family" });
  }

  const vanity = vanityTier(env, hostname);
  if (vanity && env.VANITY_TENANT !== tenant) {
    return json(403, { error: "tenant is not allowed to claim vanity hostnames" });
  }

  if (method === "POST") {
    const reg = await routerRegister(env, hostname, tenant);
    if (!reg.ok) {
      if (reg.reason === "collision") return json(409, { error: "hostname already registered" });
      return json(400, { error: "invalid hostname" });
    }
    let ssl: unknown = undefined;
    if (!vanity) {
      const cf = await provisionCfHostname(env, hostname);
      if (!cf.ok) {
        await routerUnregister(env, hostname, tenant);
        return json(502, { error: "cloudflare custom hostname provisioning failed", cloudflare: cf.error });
      }
      ssl = cf.ssl;
    }
    const target = env.BYO_CNAME_TARGET || DEFAULT_BYO_CNAME_TARGET;
    return json(200, {
      ok: true,
      hostname,
      tier: vanity ? "vanity" : "byo",
      target,
      ...(ssl !== undefined ? { ssl } : {}),
      instructions: `CNAME ${hostname} -> ${target}`,
    });
  }

  const owner = await routerLookup(env, hostname);
  if (owner !== tenant) {
    return json(404, { error: "hostname not found" });
  }
  const out = await routerUnregister(env, hostname, tenant);
  if (!out.ok) return json(404, { error: "hostname not found" });
  if (!vanity) await bestEffortDeleteCfHostname(env, hostname);
  return json(200, { ok: true });
}

// Build operator-facing URLs from the tenant's RESOLVABLE host
// (<slug>.finchmcp.com, registered in RouterDO) — NOT the inbound apex host,
// which fails closed at the relay (hostKeyFromHost("finchmcp.com") === ""). Local
// dev keeps the reachable inbound host (localhost:8787) for convenience.
async function tenantHostBase(
  env: Env,
  tenant: string,
  inboundHost: string,
): Promise<{ http: string; ws: string; host: string }> {
  const local =
    inboundHost.startsWith("localhost") || inboundHost.startsWith("127.");
  // In dev/staging (DEV=1: a single DEFAULT_TENANT, no per-slug subdomains) the
  // ONLY reachable host is the inbound workers.dev host we were called on. The
  // tenant's stored <slug>.finchmcp.com resolves only in prod (wildcard DNS +
  // slug routing), so using it here hands operators an unresolvable install/URL.
  // Prod (DEV unset) routes by slug subdomain, so there we must use it.
  const useInbound = local || env.DEV === "1";
  let host = inboundHost;
  if (!useInbound) {
    const state = await tenantOp<{ host?: string }>(env, tenant, "getState");
    if (state?.host) host = state.host;
  }
  const s = local ? "" : "s";
  return { http: `http${s}://${host}`, ws: `ws${s}://${host}`, host };
}

// ---- POST /api/enroll ------------------------------------------------------

async function handleEnroll(
  req: Request,
  env: Env,
  tenant: string,
  host: string,
): Promise<Response> {
  const body = await readJson(req);
  if (!body.name) return json(400, { error: "name required" });

  const { id } = await tenantOp<{ id: string }>(env, tenant, "enroll", {
    name: body.name,
    group: body.group,
  });

  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  // jti makes the ticket SINGLE-USE: the hub records it at first /join and
  // rejects replays for the rest of its TTL. (security M1)
  const ticket = await signToken(
    { tenant, service: id, exp, kind: "join", jti: genJti() },
    env.TICKET_SECRET,
  );

  const base = await tenantHostBase(env, tenant, host);
  const url = `${base.http}/${id}/mcp`;
  const install = `curl -fsSL ${base.http}/install | sh && finch join --hub ${base.http} --ticket ${ticket}`;

  const resp: EnrollResp = {
    id,
    ticket,
    url,
    install,
    expiresAt: exp,
  };
  return json(200, resp);
}

// ---- POST /join — ticket-authed --------------------------------------------

async function handleJoin(
  req: Request,
  env: Env,
  host: string,
): Promise<Response> {
  // Rate-limit /join per-IP before any work — a public, unauthenticated endpoint
  // that mints DOs must not be a cheap flood vector. (security M5)
  const ip = clientIp(req);
  if (!(await rateLimitOk(env.JOIN_LIMIT, `join:${ip}`))) {
    return json(429, { error: "rate limited" });
  }

  const body = await readJson(req);
  if (!body.ticket || !body.box) {
    return json(400, { error: "ticket and box required" });
  }
  // Validate + clamp the attacker-chosen box name (length + charset) before
  // it can pollute the registry / squat a name. (security M1)
  const box = cleanBox(body.box);
  if (!box) {
    return json(400, {
      error: "invalid box name (1-64 chars, [A-Za-z0-9 ._-] only)",
    });
  }
  const payload = await verifyToken(body.ticket, env.TICKET_SECRET);
  // A join ticket is service-scoped — validateTicket already requires
  // `service` for non-browser kinds, but narrow it here for the type checker
  // (TicketPayload.service is optional for the browser portal/session kinds).
  if (
    !payload ||
    (payload.kind !== undefined && payload.kind !== "join") ||
    !payload.service
  ) {
    return json(401, { error: "invalid or expired ticket" });
  }
  const { tenant, service } = payload;

  // SINGLE-USE: atomically burn the ticket's jti before doing any registration
  // work, so a captured ticket can't be replayed for its TTL. (security M1)
  const claim = await tenantOp<{ ok: boolean }>(env, tenant, "claimTicket", {
    jti: payload.jti,
    exp: payload.exp,
  });
  if (!claim.ok) {
    return json(409, { error: "ticket already used" });
  }

  const os = typeof body.os === "string" ? body.os : "unknown";
  const version = typeof body.version === "string" ? body.version : "0.0.0";

  const reg = await tenantOp<{ ok: boolean; error?: string }>(
    env,
    tenant,
    "registerBox",
    { service, box, os, version },
  );
  if (reg.error) {
    return json(409, { error: reg.error });
  }

  const base = await tenantHostBase(env, tenant, host);
  const connectUrl = `${base.ws}/${service}/${encodeURIComponent(
    box,
  )}/_connect`;

  // Mint the short-lived per-box connect-token. The agent presents it on the
  // _connect dial as ?ct=<token>; index.ts verifies kind+tenant+service+box
  // and expiry BEFORE forwarding the WS upgrade to the relay DO. This is the sole
  // proof that authenticates the box-side agent channel (FLEET_SECRET removed).
  const connectExp =
    Math.floor(Date.now() / 1000) + CONNECT_TOKEN_TTL_SECONDS;
  const connectToken = await signToken(
    {
      tenant,
      service,
      box,
      kind: "connect",
      exp: connectExp,
    },
    env.TICKET_SECRET,
  );

  // Long-lived per-box refresh token. The agent keeps this and trades it at
  // /refresh for fresh connect-tokens — so the one-shot join ticket is never
  // re-used (it's already burned above by claimTicket). (reconnect fix)
  const refreshExp =
    Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS;
  const refreshToken = await signToken(
    {
      tenant,
      service,
      box,
      kind: "refresh",
      exp: refreshExp,
    },
    env.TICKET_SECRET,
  );

  const resp: JoinResp = {
    ok: true,
    tenant,
    service,
    box,
    host: base.host,
    url: `${base.http}/${service}/mcp`,
    connectUrl,
    connectToken,
    refreshToken,
  };
  return json(200, resp);
}

// ---- POST /refresh — refresh-token-authed -----------------------------------

async function handleRefresh(
  req: Request,
  env: Env,
  host: string,
): Promise<Response> {
  // Rate-limit per-IP like /join — it's a public, unauthenticated-until-verified
  // endpoint that mints credentials.
  const ip = clientIp(req);
  if (!(await rateLimitOk(env.JOIN_LIMIT, `refresh:${ip}`))) {
    return json(429, { error: "rate limited" });
  }

  const body = await readJson(req);
  if (!body.refreshToken) return json(400, { error: "refreshToken required" });

  const payload = await verifyToken(body.refreshToken, env.TICKET_SECRET);
  // A refresh token is service- AND box-scoped (browser kinds carry
  // neither); narrow `service` for the type checker as well.
  if (
    !payload ||
    payload.kind !== "refresh" ||
    !payload.box ||
    !payload.service
  ) {
    return json(401, { error: "invalid or expired refresh token" });
  }
  const { tenant, service } = payload;
  const box = payload.box;

  // Revocation: a box removed from the dashboard can no longer refresh, so a
  // leaked refresh token stops working within one connect-token TTL of removal.
  const reg = await tenantOp<{ exists: boolean }>(env, tenant, "boxExists", {
    service,
    box,
  });
  if (!reg.exists) {
    return json(403, { error: "box no longer registered" });
  }
  // Aviary-issued refresh credentials carry a per-box epoch. A successfully
  // persisted re-enrollment ACK atomically advances it, invalidating the prior
  // refresh token without affecting legacy tokens (which have no epoch).
  if (typeof payload.epoch === "number") {
    const current = await tenantOp<{ exists: boolean; epoch?: number }>(
      env,
      tenant,
      "boxCredentialEpoch",
      { service, box },
    );
    if (!current.exists || current.epoch !== payload.epoch) {
      return json(403, { error: "refresh credential superseded" });
    }
  }

  // Re-stamp the agent version when the box reports one (it re-execs onto a
  // new binary after a hub-pushed update and resumes HERE, never via /join —
  // without this the registry keeps the pre-update version forever). Older
  // agents send no version → no-op. Best-effort: never blocks the refresh.
  if (typeof body.version === "string" && body.version) {
    await tenantOp(env, tenant, "boxVersion", {
      service,
      box,
      version: body.version,
    });
  }

  const connectExp =
    Math.floor(Date.now() / 1000) + CONNECT_TOKEN_TTL_SECONDS;
  const connectToken = await signToken(
    { tenant, service, box, kind: "connect", exp: connectExp },
    env.TICKET_SECRET,
  );

  const base = await tenantHostBase(env, tenant, host);
  const connectUrl = `${base.ws}/${service}/${encodeURIComponent(
    box,
  )}/_connect`;

  const resp: RefreshResp = {
    ok: true,
    tenant,
    service,
    box,
    host: base.host,
    url: `${base.http}/${service}/mcp`,
    connectUrl,
    connectToken,
  };
  return json(200, resp);
}
