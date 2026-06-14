/// <reference types="@cloudflare/workers-types" />
//
// Finch hub — the thin control plane. "We handle auth + routing + hosting,
// you handle the logic." This Worker resolves the tenant, then either:
//   - serves the control API (/api/*, /join) — see api.ts
//   - relays MCP / agent traffic to the per-MACHINE ApplianceDO, gated by a
//     finch_ key check against the tenant's TenantDO.
//
// Tenancy: every request belongs to a tenant (a Clerk org id, or user id).
//   - Control-plane requests (from the web app) carry X-Finch-Tenant explicitly.
//   - MCP / relay traffic resolves the tenant from the request host subdomain
//     (<sub>.finchmcp.com); local dev with no subdomain falls back to
//     env.DEFAULT_TENANT.

import { ApplianceDO } from "./appliance-do";
import { TenantDO } from "./tenant-do";
import { handleApi, isApiPath } from "./api";
import { hashKey } from "./auth";

export { ApplianceDO, TenantDO };

export interface Env {
  // Durable Object namespaces.
  APPLIANCE: DurableObjectNamespace; // per-machine WS relay (ApplianceDO)
  TENANT: DurableObjectNamespace; // per-tenant control-plane state (TenantDO)

  // Secrets / vars (wrangler vars in dev via .dev.vars; secrets in prod).
  FINCH_SERVICE_SECRET: string; // web-app -> control API shared secret
  FLEET_SECRET: string; // handed to agents on join (fleet membership proof)
  TICKET_SECRET: string; // HMAC key for stateless join tickets
  DEFAULT_TENANT: string; // tenant used when no subdomain (local dev)
}

/** Resolve the tenant for an MCP/relay request from the host subdomain.
 *  `<sub>.finchmcp.com` -> `<sub>`. Anything without a usable subdomain
 *  (localhost, the apex, a workers.dev preview) falls back to DEFAULT_TENANT. */
function tenantFromHost(host: string, env: Env): string {
  const h = (host || "").split(":")[0].toLowerCase();
  const labels = h.split(".").filter(Boolean);
  // <sub>.finchmcp.com -> ["<sub>", "finchmcp", "com"]
  if (labels.length >= 3 && labels[labels.length - 2] === "finchmcp") {
    const sub = labels[0];
    if (sub && sub !== "www") return sub;
  }
  return env.DEFAULT_TENANT;
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
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Call a TenantDO op via its internal fetch RPC. */
async function tenantOp<T = any>(
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
  async fetch(req: Request, env: Env): Promise<Response> {
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

    // ---- MCP / relay plane. Tenant comes from the host subdomain. ----
    const tenant = tenantFromHost(host, env);

    const appliance = parts[0];
    const second = parts[1];

    // /<appliance>/<machine>/_connect  — agent dials in (WS upgrade).
    // /<appliance>/<machine>/mcp        — public MCP call to a specific machine.
    // /<appliance>/mcp                  — load-balanced across the appliance.

    // Agent registration: /<appliance>/<machine>/_connect
    if (second && parts[2] === "_connect") {
      const machine = second;
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
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

    // Public MCP call to a specific machine: /<appliance>/<machine>/mcp
    if (second && parts[2] === "mcp" && parts.length >= 3) {
      const machine = second;
      // Upstream path the agent should see: everything after <appliance>/<machine>.
      const upstream = parts.slice(2).join("/");
      return relayMcp(req, env, tenant, appliance, machine, path, upstream);
    }

    // Load-balanced appliance URL: /<appliance>/mcp
    if (second === "mcp" && parts.length === 2) {
      const machine = await pickHealthyMachine(env, tenant, appliance);
      if (!machine) {
        return json(503, { error: "appliance offline", appliance });
      }
      // Upstream path: everything after <appliance> (the resolved <machine> is
      // injected by relayMcp so the DO's two-segment strip yields this path).
      const upstream = parts.slice(1).join("/");
      return relayMcp(req, env, tenant, appliance, machine, path, upstream);
    }

    return json(404, { error: "not found", path });
  },
};

/** Pick an online machine for an appliance (load-balance). Returns the machine
 *  name, or null if none are healthy. Reads TenantDO getState. */
async function pickHealthyMachine(
  env: Env,
  tenant: string,
  appliance: string,
): Promise<string | null> {
  const state = await tenantOp(env, tenant, "getState");
  const ap = (state?.appliances ?? []).find((a: any) => a.id === appliance);
  if (!ap) return null;
  const machines: any[] = ap.machines ?? [];
  const healthy = machines.filter((m) => m.connected || m.state === "chirping");
  const pool = healthy.length ? healthy : [];
  if (!pool.length) return null;
  // Spread load: random pick among healthy machines.
  return pool[Math.floor(Math.random() * pool.length)].name;
}

/** Extract a Bearer finch_ key, check it against the tenant's TenantDO, relay to
 *  the per-machine ApplianceDO, and record the call. 401 if the key is absent or
 *  not allowed for this appliance. */
async function relayMcp(
  req: Request,
  env: Env,
  tenant: string,
  appliance: string,
  machine: string,
  route: string,
  upstream: string,
): Promise<Response> {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(finch_[A-Za-z0-9_-]+)$/);
  if (!m) {
    return json(401, { error: "missing or malformed finch_ bearer key" });
  }
  const presented = m[1];
  const hash = await hashKey(presented);
  const check = await tenantOp<{ allowed: boolean; keyLabel: string }>(
    env,
    tenant,
    "checkKey",
    { hash, appliance },
  );
  if (!check.allowed) {
    return json(403, { error: "key not allowed for this appliance" });
  }

  const caller = check.keyLabel || "finch_key";
  const start = Date.now();
  const stub = machineStub(env, tenant, appliance, machine);

  // Normalize the forwarded URL to /<appliance>/<machine>/<rest>. ApplianceDO
  // strips exactly TWO leading segments to derive the upstream path it sends to
  // the agent. `upstream` is the path the agent should see (e.g. "mcp"); for the
  // load-balanced entry (/<appliance>/mcp) the resolved <machine> isn't in the
  // URL, so without this rewrite the DO would strip "<appliance>/<mcp>" and the
  // agent would receive "/" instead of "/mcp".
  const inUrl = new URL(req.url);
  inUrl.pathname =
    `/${appliance}/${encodeURIComponent(machine)}` +
    (upstream ? `/${upstream}` : "");
  const relayReq = new Request(inUrl.toString(), req);

  let res: Response;
  try {
    res = await stub.fetch(relayReq);
  } catch (e) {
    res = json(502, { error: `relay failed: ${e}` });
  }
  const ms = Date.now() - start;

  // Fire-and-forget metrics; never block the response on the counter write.
  void tenantOp(env, tenant, "recordCall", {
    appliance,
    machine,
    status: res.status,
    ms,
    caller,
    route,
  }).catch(() => {});

  return res;
}
