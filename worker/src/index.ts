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

// Default target for GET /releases/<asset>: the project's GitHub Releases
// "latest" download URL. Overridable via env.RELEASES_BASE.
const DEFAULT_RELEASES_BASE =
  "https://github.com/DigiBugCat/finch/releases/latest/download";

// Allow-listed release asset names — gates the /releases redirect so it can
// never be turned into an open redirect. Matches the installer's
// `finch-${os}-${arch}` and GoReleaser's archive name_template.
const RELEASE_ASSET_RE = /^finch-(darwin|linux)-(amd64|arm64)$/;

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

    // Public MCP call to a specific machine: /<appliance>/<machine>/mcp
    if (second && parts[2] === "mcp" && parts.length >= 3) {
      // `machine` is the DECODED name (see safeDecode at the edge above); it
      // keys the ApplianceDO and matches the stored registry entry.
      // Upstream path the agent should see: everything after <appliance>/<machine>.
      const upstream = parts.slice(2).join("/");
      return relayMcp(req, env, ctx, tenant, appliance, machine, path, upstream);
    }

    // Load-balanced appliance URL: /<appliance>/mcp
    if (second === "mcp" && parts.length === 2) {
      // Upstream path: everything after <appliance> (the resolved <machine> is
      // injected by relayMcp so the DO's two-segment strip yields this path).
      const upstream = parts.slice(1).join("/");
      // Pick the WHOLE healthy pool (shuffled) and FAIL OVER inside relayMcp: it
      // relays to the first candidate and, if that DO reports "appliance offline"
      // (a stale-pick blackhole — the picker reads persisted liveness, which can
      // lag a just-dropped socket), retries the next sibling. Only when every
      // candidate is dead do we 503. (code-review #12)
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
      return relayMcp(req, env, ctx, tenant, appliance, pool, path, upstream);
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
 *  fail over on a DO "appliance offline" 503. */
async function relayMcp(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  tenant: string,
  appliance: string,
  machineOrPool: string | string[],
  route: string,
  upstream: string,
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
    reason?: "no-key" | "scope" | "acl" | "expired";
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
          : check.reason === "expired"
            ? "key has expired"
            : "key not allowed for this appliance";
    return json(403, { error });
  }

  const caller = check.keyLabel || "finch_key";
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
