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

import { rateLimitOk, clientIp, json, tenantOp, type Env } from "./index";
import {
  serviceOk,
  signToken,
  verifyToken,
  verifyAssertion,
  genJti,
} from "./auth";
import {
  routerLookup,
  routerDeviceStart,
  routerDevicePoll,
  routerDeviceApprove,
} from "./router-do";
import { signAssertion } from "./auth";

// A CLI token is a long-lived tenant assertion (same envelope as X-Finch-Auth).
const CLI_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

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

// Join tickets are short-lived AND single-use (jti replay-checked at /join), so
// a 15-minute window is ample for the enroll → install → join flow while sharply
// bounding the replay surface a captured ticket exposes. (security M1)
const TICKET_TTL_SECONDS = 15 * 60; // join tickets live 15m
const CONNECT_TOKEN_TTL_SECONDS = 120; // per-machine _connect grants live 120s
// The agent keeps its refresh token across the whole enrollment lifetime and
// trades it for fresh connect-tokens at /refresh, so it never re-uses the
// one-shot join ticket. 30 days bounds the credential while comfortably covering
// any realistic always-on uptime; a machine removed from the dashboard is
// rejected at /refresh (machineExists) well before this elapses.
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d

// Machine-name clamp at the door (M1): bound length + charset before the name
// ever reaches the registry. Mirrors tenant-do's cleanMachineName.
const MAX_MACHINE_NAME = 64;
const MACHINE_NAME_RE = /^[A-Za-z0-9 ._\-]+$/;
function cleanMachine(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > MAX_MACHINE_NAME) return null;
  if (!MACHINE_NAME_RE.test(name)) return null;
  return name;
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

export async function handleApi(
  req: Request,
  env: Env,
  host: string,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // ---- /join — ticket-authed (NOT service-authed) ----
  if (path === "/join") {
    if (method !== "POST") return json(405, { error: "POST only" });
    return handleJoin(req, env, host);
  }

  // ---- /refresh — refresh-token-authed (NOT service-authed). The box trades
  //      its long-lived per-machine refresh token for a fresh connect-token,
  //      so steady-state reconnection never re-uses the one-shot join ticket. ----
  if (path === "/refresh") {
    if (method !== "POST") return json(405, { error: "POST only" });
    return handleRefresh(req, env, host);
  }

  // ---- /api/cli/* — authed by a CLI token (a long-lived tenant assertion the
  //      dashboard issues), presented as `Authorization: Bearer <token>`. NOT
  //      service-secret-authed: the assertion is itself HMAC-signed with
  //      FINCH_SERVICE_SECRET, so a valid one already proves tenant authorization
  //      (same trust as X-Finch-Auth). This lets the `finch` CLI enroll
  //      appliances from the box without the dashboard. ----
  if (path.startsWith("/api/cli/")) {
    // ---- Public device-authorization flow (`finch login`): the CLI has no
    //      credentials yet, so start/poll are unauthenticated. The browser
    //      (Clerk-authed) approves the short user_code out of band. ----
    if (path === "/api/cli/device/start" && method === "POST") {
      const deviceCode = randomToken(32);
      const userCode = randomUserCode();
      await routerDeviceStart(env, deviceCode, userCode);
      const webBase = (env.WEB_URL || `https://${host}`).replace(/\/$/, "");
      return json(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${webBase}/cli`,
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

    const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
    const cliTenant = m ? await verifyAssertion(m[1], env.FINCH_SERVICE_SECRET) : null;
    if (!cliTenant) {
      return json(401, { error: "missing, invalid, or expired CLI token (Authorization: Bearer …)" });
    }
    // GET /api/cli/whoami — validate a token + report the tenant it acts as.
    if (path === "/api/cli/whoami" && method === "GET") {
      return json(200, { ok: true, tenant: cliTenant });
    }
    // POST /api/cli/enroll {name,group} — enroll an appliance, return its ticket.
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
  if (method === "POST" && seg.length === 1 && seg[0] === "device-approve") {
    const body = await readJson(req);
    const userCode = String(body.userCode || "").trim();
    if (!userCode) return json(400, { error: "userCode required" });
    const exp = Math.floor(Date.now() / 1000) + CLI_TOKEN_TTL_SECONDS;
    const token = await signAssertion({ tenant, exp }, env.FINCH_SERVICE_SECRET);
    const out = await routerDeviceApprove(env, userCode, tenant, token);
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

  // POST /api/appliances/:id/release|approve|decline
  if (method === "POST" && seg[0] === "appliances" && seg.length === 3) {
    const id = decodeURIComponent(seg[1]);
    const action = seg[2];
    if (action === "release" || action === "approve" || action === "decline") {
      const out = await tenantOp(env, tenant, action, { id });
      return json(out?.ok === false ? 404 : 200, out);
    }
    return json(404, { error: "unknown appliance action", action });
  }

  // PUT /api/appliances/:id/tags {tags}
  if (
    method === "PUT" &&
    seg[0] === "appliances" &&
    seg.length === 3 &&
    seg[2] === "tags"
  ) {
    const id = decodeURIComponent(seg[1]);
    const body = await readJson(req);
    const out = await tenantOp(env, tenant, "setTags", {
      id,
      tags: body.tags ?? [],
    });
    return json(out?.ok === false ? 404 : 200, out);
  }

  // PUT /api/appliances/:id/group {group}
  if (
    method === "PUT" &&
    seg[0] === "appliances" &&
    seg.length === 3 &&
    seg[2] === "group"
  ) {
    const id = decodeURIComponent(seg[1]);
    const body = await readJson(req);
    const out = await tenantOp(env, tenant, "setGroup", {
      id,
      group: String(body.group ?? ""),
    });
    return json(out?.ok === false ? 404 : 200, out);
  }

  // POST /api/keys {label,scope,owner}. scope is the STRUCTURED KeyScope
  // ({all:true} | {appliances:[...]}); TenantDO.mintKey validates every listed
  // appliance id exists and 400s on an unknown id. We pass it through and
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

  // POST /api/machines/:machine/keys/revoke {appliance,key}
  if (
    method === "POST" &&
    seg[0] === "machines" &&
    seg.length === 4 &&
    seg[2] === "keys" &&
    seg[3] === "revoke"
  ) {
    const machine = decodeURIComponent(seg[1]);
    const body = await readJson(req);
    if (!body.appliance || !body.key) {
      return json(400, { error: "appliance and key required" });
    }
    const out = await tenantOp(env, tenant, "revokeMachineKey", {
      appliance: body.appliance,
      machine,
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
    const id = decodeURIComponent(seg[1]);
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

// Build operator-facing URLs from the tenant's RESOLVABLE host
// (<slug>.finchmcp.com, registered in RouterDO) — NOT the inbound apex host,
// which fails closed at the relay (slugFromHost("finchmcp.com") === ""). Local
// dev keeps the reachable inbound host (localhost:8787) for convenience.
async function tenantHostBase(
  env: Env,
  tenant: string,
  inboundHost: string,
): Promise<{ http: string; ws: string; host: string }> {
  const local =
    inboundHost.startsWith("localhost") || inboundHost.startsWith("127.");
  let host = inboundHost;
  if (!local) {
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
    { tenant, appliance: id, exp, kind: "join", jti: genJti() },
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
  if (!body.ticket || !body.machine) {
    return json(400, { error: "ticket and machine required" });
  }
  // Validate + clamp the attacker-chosen machine name (length + charset) before
  // it can pollute the registry / squat a name. (security M1)
  const machine = cleanMachine(body.machine);
  if (!machine) {
    return json(400, {
      error: "invalid machine name (1-64 chars, [A-Za-z0-9 ._-] only)",
    });
  }
  const payload = await verifyToken(body.ticket, env.TICKET_SECRET);
  if (!payload || (payload.kind !== undefined && payload.kind !== "join")) {
    return json(401, { error: "invalid or expired ticket" });
  }
  const { tenant, appliance } = payload;

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
    "registerMachine",
    { appliance, machine, os, version },
  );
  if (reg.error) {
    return json(409, { error: reg.error });
  }

  const base = await tenantHostBase(env, tenant, host);
  const connectUrl = `${base.ws}/${appliance}/${encodeURIComponent(
    machine,
  )}/_connect`;

  // Mint the short-lived per-machine connect-token. The agent presents it on the
  // _connect dial as ?ct=<token>; index.ts verifies kind+tenant+appliance+machine
  // and expiry BEFORE forwarding the WS upgrade to the relay DO. This is the sole
  // proof that authenticates the box-side agent channel (FLEET_SECRET removed).
  const connectExp =
    Math.floor(Date.now() / 1000) + CONNECT_TOKEN_TTL_SECONDS;
  const connectToken = await signToken(
    {
      tenant,
      appliance,
      machine,
      kind: "connect",
      exp: connectExp,
    },
    env.TICKET_SECRET,
  );

  // Long-lived per-machine refresh token. The agent keeps this and trades it at
  // /refresh for fresh connect-tokens — so the one-shot join ticket is never
  // re-used (it's already burned above by claimTicket). (reconnect fix)
  const refreshExp =
    Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS;
  const refreshToken = await signToken(
    {
      tenant,
      appliance,
      machine,
      kind: "refresh",
      exp: refreshExp,
    },
    env.TICKET_SECRET,
  );

  const resp: JoinResp = {
    ok: true,
    tenant,
    appliance,
    machine,
    host: base.host,
    url: `${base.http}/${appliance}/mcp`,
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
  if (!payload || payload.kind !== "refresh" || !payload.machine) {
    return json(401, { error: "invalid or expired refresh token" });
  }
  const { tenant, appliance } = payload;
  const machine = payload.machine;

  // Revocation: a machine removed from the dashboard can no longer refresh, so a
  // leaked refresh token stops working within one connect-token TTL of removal.
  const reg = await tenantOp<{ exists: boolean }>(env, tenant, "machineExists", {
    appliance,
    machine,
  });
  if (!reg.exists) {
    return json(403, { error: "machine no longer registered" });
  }

  const connectExp =
    Math.floor(Date.now() / 1000) + CONNECT_TOKEN_TTL_SECONDS;
  const connectToken = await signToken(
    { tenant, appliance, machine, kind: "connect", exp: connectExp },
    env.TICKET_SECRET,
  );

  const base = await tenantHostBase(env, tenant, host);
  const connectUrl = `${base.ws}/${appliance}/${encodeURIComponent(
    machine,
  )}/_connect`;

  const resp: RefreshResp = {
    ok: true,
    tenant,
    appliance,
    machine,
    host: base.host,
    url: `${base.http}/${appliance}/mcp`,
    connectUrl,
    connectToken,
  };
  return json(200, resp);
}
