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
import { hashKey, verifyToken } from "./auth";

export { ApplianceDO, TenantDO, RouterDO };

export interface Env {
  // Durable Object namespaces.
  APPLIANCE: DurableObjectNamespace; // per-machine WS relay (ApplianceDO)
  TENANT: DurableObjectNamespace; // per-tenant control-plane state (TenantDO)
  ROUTER: DurableObjectNamespace; // singleton slug→tenantId index (RouterDO)

  // Secrets / vars (wrangler vars in dev via .dev.vars; secrets in prod).
  FINCH_SERVICE_SECRET: string; // web-app -> control API shared secret
  TICKET_SECRET: string; // HMAC key for join tickets + per-machine connect-tokens
  DEFAULT_TENANT?: string; // DEV-ONLY tenant fallback when no slug resolves
  DEV?: string; // "1" in the dev env; gates the DEFAULT_TENANT fallback
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
    // Known-shaped slug that isn't registered: fail closed in prod.
    if (env.DEV === "1" && env.DEFAULT_TENANT) return env.DEFAULT_TENANT;
    return null;
  }
  // No usable slug (apex / www / workers.dev / localhost). Dev-only fallback.
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

    // ---- MCP / relay plane. Tenant id resolves from the host slug via the
    //      singleton RouterDO (slug→tenantId). FAIL CLOSED on an unknown slug. ----
    const tenant = await resolveTenant(host, env);
    if (!tenant) {
      return json(404, {
        error: "tenant could not be resolved from host",
        host,
      });
    }

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

    // Public MCP call to a specific machine: /<appliance>/<machine>/mcp
    if (second && parts[2] === "mcp" && parts.length >= 3) {
      const machine = second;
      // Upstream path the agent should see: everything after <appliance>/<machine>.
      const upstream = parts.slice(2).join("/");
      return relayMcp(req, env, ctx, tenant, appliance, machine, path, upstream);
    }

    // Load-balanced appliance URL: /<appliance>/mcp
    if (second === "mcp" && parts.length === 2) {
      const machine = await pickHealthyMachine(env, tenant, appliance);
      if (!machine) {
        // No healthy machine. Record this 503 too, so a load-balanced offline
        // call is just as visible in the dashboard (logs / recentCalls / err)
        // as a specific-machine offline 503 (which goes through relayMcp). The
        // canonical appliance URL minted at enroll is exactly this LB route, so
        // without this its offline failures would silently vanish. We attribute
        // the caller's key when present (best-effort — we don't fail the 503 on
        // a bad/absent key), and fire-and-forget the write via waitUntil.
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
      // Upstream path: everything after <appliance> (the resolved <machine> is
      // injected by relayMcp so the DO's two-segment strip yields this path).
      const upstream = parts.slice(1).join("/");
      return relayMcp(req, env, ctx, tenant, appliance, machine, path, upstream);
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
 *  not allowed for this appliance. */
async function relayMcp(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
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
  const check = await tenantOp<{
    allowed: boolean;
    keyLabel: string;
    reason?: "no-key" | "scope" | "acl";
  }>(env, tenant, "checkKey", { hash, appliance });
  if (!check.allowed) {
    // Distinguish the denial cause so a caller can tell "unknown key" from
    // "known key, not granted by the tenant's ACL". All are 403 (no oracle on
    // key existence beyond the bearer-shape 401 above).
    const error =
      check.reason === "acl"
        ? "no ACL rule grants this key access to this appliance"
        : check.reason === "scope"
          ? "key scope does not include this appliance"
          : "key not allowed for this appliance";
    return json(403, { error });
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

  // KEY-STRIP: the caller's finch_ key must NEVER cross the trust boundary into
  // the box's local upstream. Clone the headers and delete the Authorization
  // header (and any header that still carries a finch_ value) BEFORE building
  // the relay request. The agent strips hop-by-hop headers as defense-in-depth,
  // but the credential must be gone at the source. (If a box upstream needs its
  // own auth, inject a per-appliance secret downstream — never the caller key.)
  const relayHeaders = new Headers(req.headers);
  relayHeaders.delete("authorization");
  for (const [name, value] of [...relayHeaders.entries()]) {
    if (value.includes("finch_")) relayHeaders.delete(name);
  }
  const relayReq = new Request(inUrl.toString(), {
    method: req.method,
    headers: relayHeaders,
    body: req.body,
    // duplex is required when streaming a request body in workerd.
    ...(req.body ? { duplex: "half" } : {}),
  } as RequestInit);

  let res: Response;
  try {
    res = await stub.fetch(relayReq);
  } catch (e) {
    res = json(502, { error: `relay failed: ${e}` });
  }
  const ms = Date.now() - start;

  // Fire-and-forget metrics; never block the response on the counter write.
  // Must use ctx.waitUntil — a bare unawaited promise is cancelled once the
  // response is returned, so the recordCall subrequest to TenantDO never
  // commits (the success path returns fast and consistently lost its counter).
  ctx.waitUntil(
    tenantOp(env, tenant, "recordCall", {
      appliance,
      machine,
      status: res.status,
      ms,
      caller,
      route,
    }).catch(() => {}),
  );

  return res;
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
echo "finch: now run  finch join --hub $HUB --ticket <ticket>"
`;
}
