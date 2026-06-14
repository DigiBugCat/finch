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

import type { Env } from "./index";
import { serviceOk, signToken, verifyToken } from "./auth";
import type {
  EnrollResp,
  JoinResp,
  MintKeyResp,
  TenantState,
  PublicKey,
} from "./types";

const TICKET_TTL_SECONDS = 60 * 60; // join tickets live 1h

/** True if this path is handled by the control API (vs the MCP/relay plane). */
export function isApiPath(path: string): boolean {
  return path === "/join" || path === "/api" || path.startsWith("/api/");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Call a TenantDO op via internal fetch RPC, return the parsed JSON. */
async function tenantOp<T = any>(
  env: Env,
  tenant: string,
  op: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const stub = env.TENANT.get(env.TENANT.idFromName(tenant));
  const res = await stub.fetch("https://tenant/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...args }),
  });
  return (await res.json()) as T;
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

  // ---- Everything else under /api requires the service secret + tenant. ----
  if (!serviceOk(req, env)) {
    return json(401, { error: "bad or missing X-Finch-Service" });
  }
  const tenant = req.headers.get("X-Finch-Tenant");
  if (!tenant) {
    return json(400, { error: "missing X-Finch-Tenant" });
  }

  const parts = path.split("/").filter(Boolean); // ["api", ...]
  const seg = parts.slice(1); // strip "api"

  // GET /api/state
  if (method === "GET" && seg.length === 1 && seg[0] === "state") {
    const state = await tenantOp<TenantState>(env, tenant, "getState");
    return json(200, state);
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

  // POST /api/keys {label,scope,owner}
  if (method === "POST" && seg.length === 1 && seg[0] === "keys") {
    const body = await readJson(req);
    if (!body.label) return json(400, { error: "label required" });
    const out = await tenantOp<{ plaintext: string; key: PublicKey }>(
      env,
      tenant,
      "mintKey",
      { label: body.label, scope: body.scope, owner: body.owner },
    );
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
  const ticket = await signToken({ tenant, appliance: id, exp }, env.TICKET_SECRET);

  const scheme = host.startsWith("localhost") || host.startsWith("127.0.0.1")
    ? "http"
    : "https";
  const url = `${scheme}://${host}/${id}/mcp`;
  const install = `curl -fsSL ${scheme}://${host}/install | sh && finch join --ticket ${ticket}`;

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
  const body = await readJson(req);
  if (!body.ticket || !body.machine) {
    return json(400, { error: "ticket and machine required" });
  }
  const payload = await verifyToken(body.ticket, env.TICKET_SECRET);
  if (!payload) {
    return json(401, { error: "invalid or expired ticket" });
  }
  const { tenant, appliance } = payload;

  const os = typeof body.os === "string" ? body.os : "unknown";
  const version = typeof body.version === "string" ? body.version : "0.0.0";

  await tenantOp(env, tenant, "registerMachine", {
    appliance,
    machine: body.machine,
    os,
    version,
  });

  const scheme = host.startsWith("localhost") || host.startsWith("127.0.0.1")
    ? "ws"
    : "wss";
  const connectUrl = `${scheme}://${host}/${appliance}/${encodeURIComponent(
    body.machine,
  )}/_connect`;

  const resp: JoinResp = {
    ok: true,
    tenant,
    appliance,
    machine: body.machine,
    connectUrl,
    fleetSecret: env.FLEET_SECRET,
  };
  return json(200, resp);
}
