import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker, { LEGACY_URL_ERROR_RE, LOCAL_SERVICE_DOWN } from "../src/index";
import { RELAY_ERROR_HEADER } from "../src/box-do";
import { signAssertion } from "../src/auth";
import { LATEST_AGENT } from "../src/types";

// What callers and the CLI see when something is wrong: the local service is
// down, the machine is offline, the key is wrong, the address names no
// account, the path does not exist. Drives the REAL worker against the real
// RouterDO + TenantDO + BoxDO, with the test socket standing in for the agent.

const SERVICE = env.FINCH_SERVICE_SECRET;
const nowSec = () => Math.floor(Date.now() / 1000);
let seq = 0;

async function call(req: Request, overrides: Record<string, unknown> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...(env as any), ...overrides } as any, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** The production shape: no DEV fallback to DEFAULT_TENANT. */
const PROD = { DEV: undefined, DEFAULT_TENANT: undefined, ALLOW_INSECURE_HTTP: undefined };

async function freshTenantSlug() {
  const n = `${Date.now().toString(36)}${seq++}`.toLowerCase();
  const tenant = `user_care_${n}`;
  const slug = `care${n}`;
  const res = await env.ROUTER.get(env.ROUTER.idFromName("global")).fetch("https://router/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "register", slug, tenant }),
  });
  expect(((await res.json()) as any).ok).toBe(true);
  const host = `${slug}.finchmcp.com`;
  return { tenant, host, base: `https://${host}` };
}

async function api(tenant: string, host: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    "X-Finch-Service": SERVICE,
    "X-Finch-Auth": await signAssertion({ tenant, exp: nowSec() + 300 }, SERVICE),
    host,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return call(new Request(`https://${host}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}

async function cliToken(tenant: string): Promise<string> {
  const res = await env.TENANT.get(env.TENANT.idFromName(tenant)).fetch("https://tenant/op", {
    method: "POST",
    body: JSON.stringify({ op: "cliEpoch" }),
  });
  const { epoch } = (await res.json()) as { epoch: number };
  return signAssertion({ tenant, exp: nowSec() + 300, kind: "cli", epoch }, SERVICE);
}

async function boxState(tenant: string, host: string, service: string) {
  const state = (await (await api(tenant, host, "GET", "/api/state")).json()) as any;
  return (state.services ?? []).find((a: any) => a.id === service)?.boxes?.[0];
}

async function waitFor(pred: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("condition never held");
}

/** An approved, connected, key-gated service and a finch_ key for it. */
async function standUp() {
  const { tenant, host, base } = await freshTenantSlug();
  const enroll = (await (await api(tenant, host, "POST", "/api/enroll", { name: "notes" })).json()) as any;
  const service = enroll.id as string;
  const box = `box-${seq++}`;
  const join = (await (await call(new Request(`${base}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", host },
    body: JSON.stringify({ ticket: enroll.ticket, box, os: "linux", version: LATEST_AGENT }),
  }))).json()) as any;
  const connect = await call(new Request(
    `${base}/${service}/${box}/_connect?ct=${encodeURIComponent(join.connectToken)}`,
    { headers: { Upgrade: "websocket", host } },
  ));
  expect(connect.status).toBe(101);
  const agent = connect.webSocket!;
  agent.accept();
  await waitFor(async () => !!(await boxState(tenant, host, service))?.connected);
  await api(tenant, host, "POST", `/api/services/${service}/approve`);
  await waitFor(async () => (await boxState(tenant, host, service))?.state !== "pending");
  const key = ((await (await api(tenant, host, "POST", "/api/keys", {
    label: "care", scope: { services: [service] },
  })).json()) as any).key as string;
  return { tenant, host, base, service, box, agent, key };
}

function nextFrame(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (ev: MessageEvent) => resolve(JSON.parse(ev.data as string)), { once: true });
  });
}

function mcp(base: string, host: string, service: string, key?: string): Request {
  const headers: Record<string, string> = { host, "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  return new Request(`${base}/${service}/mcp`, { method: "POST", headers, body: "{}" });
}

describe("a local service that is down", () => {
  for (const [agentVersion, message] of [
    ["1.7", 'Post "http://127.0.0.1:8000/mcp": dial tcp 127.0.0.1:8000: connect: connection refused'],
    ["1.8", LOCAL_SERVICE_DOWN],
  ]) {
    it(`answers JSON without the loopback URL (a ${agentVersion} agent)`, async () => {
      const { host, base, service, agent, key } = await standUp();
      const frame = nextFrame(agent);
      const pending = call(mcp(base, host, service, key));
      const req = await frame;
      agent.send(JSON.stringify({ id: req.id, type: "err", status: 502, message }));
      const res = await pending;
      expect(res.status).toBe(502);
      expect(res.headers.get("content-type")).toContain("application/json");
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        error: "finch reached the machine, but the local service isn't answering",
        service,
      });
      expect(text).not.toContain("127.0.0.1");
      agent.close(1000, "done");
    });
  }

  // A 1.7 agent reports any failed upstream request as Go's *url.Error text,
  // `<Method> "<url>": <cause>`, for whatever method the caller used, and the
  // cause need not mention a dial (TLS, EOF). None of it may reach a caller.
  for (const message of [
    'Propfind "https://internal-host.lan:8443/dav/": tls: failed to verify certificate: x509: certificate signed by unknown authority',
    'Frobnicate "http://10.0.0.5:9000/x": EOF',
    'M-search "http://192.168.1.4:1900/*": read: connection reset by peer',
    'Get "http://127.0.0.1:8000/a\\"b": net/http: timeout awaiting response headers',
  ]) {
    it(`redacts a 1.7 agent's URL error for any method (${message.split(" ")[0]})`, async () => {
      const { host, base, service, agent, key } = await standUp();
      const frame = nextFrame(agent);
      const pending = call(mcp(base, host, service, key));
      const req = await frame;
      agent.send(JSON.stringify({ id: req.id, type: "err", status: 502, message }));
      const res = await pending;
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: LOCAL_SERVICE_DOWN, service });
      for (const leak of ["internal-host", "10.0.0.5", "192.168.1.4", "127.0.0.1"]) expect(text).not.toContain(leak);
      expect(res.headers.get(RELAY_ERROR_HEADER)).toBeNull();
      agent.close(1000, "done");
    });
  }

  it("matches Go's URL error by structure, not by a list of methods", () => {
    for (const op of ["Get", "Post", "Propfind", "Mkcol", "Report", "Frobnicate", "M-search", "X_custom!"]) {
      expect(LEGACY_URL_ERROR_RE.test(`${op} "https://internal/x": boom`)).toBe(true);
    }
    for (const text of [
      "upstream exploded",
      "dial tcp 127.0.0.1:8000: connect: connection refused",
      'bad gateway "https://x/": boom', // a space is not part of a method token
      'Get "not-a-url": boom',
    ]) {
      expect(LEGACY_URL_ERROR_RE.test(text)).toBe(false);
    }
  });

  // The local service's own response (a head frame) passes through untouched,
  // whatever its status, content type and body: even a bare text/plain 502
  // that reads exactly like a connection failure is the service's answer.
  for (const body of [
    "upstream exploded",
    "502 Bad Gateway: dial tcp 127.0.0.1:9001: connect: connection refused",
    'Post "http://backend:8080/api": dial tcp: lookup backend: no such host',
    LOCAL_SERVICE_DOWN,
  ]) {
    it(`passes the local service's own text/plain 502 through untouched (${body.slice(0, 24)}…)`, async () => {
      const { host, base, service, agent, key } = await standUp();
      const frame = nextFrame(agent);
      const pending = call(mcp(base, host, service, key));
      const req = await frame;
      agent.send(JSON.stringify({ id: req.id, type: "head", status: 502, headers: [["content-type", "text/plain"]] }));
      agent.send(JSON.stringify({ id: req.id, type: "chunk", data: btoa(body) }));
      agent.send(JSON.stringify({ id: req.id, type: "end" }));
      const res = await pending;
      expect(res.status).toBe(502);
      expect(res.headers.get("content-type")).toBe("text/plain");
      expect(await res.text()).toBe(body);
      agent.close(1000, "done");
    });
  }

  it("passes the local service's own 502 through untouched, other headers included", async () => {
    const { host, base, service, agent, key } = await standUp();
    const frame = nextFrame(agent);
    const pending = call(mcp(base, host, service, key));
    const req = await frame;
    agent.send(JSON.stringify({ id: req.id, type: "head", status: 502, headers: [["content-type", "text/plain"], ["x-app", "1"]] }));
    agent.send(JSON.stringify({ id: req.id, type: "chunk", data: btoa("upstream exploded") }));
    agent.send(JSON.stringify({ id: req.id, type: "end" }));
    const res = await pending;
    expect(res.status).toBe(502);
    expect(res.headers.get("x-app")).toBe("1");
    expect(await res.text()).toBe("upstream exploded");
    agent.close(1000, "done");
  });

  it("does not let a local service forge the agent-error provenance header", async () => {
    const { host, base, service, agent, key } = await standUp();
    const frame = nextFrame(agent);
    const pending = call(mcp(base, host, service, key));
    const req = await frame;
    agent.send(JSON.stringify({
      id: req.id, type: "head", status: 502,
      headers: [["content-type", "text/plain"], [RELAY_ERROR_HEADER, "agent"]],
    }));
    agent.send(JSON.stringify({ id: req.id, type: "chunk", data: btoa(LOCAL_SERVICE_DOWN) }));
    agent.send(JSON.stringify({ id: req.id, type: "end" }));
    const res = await pending;
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get(RELAY_ERROR_HEADER)).toBeNull();
    expect(await res.text()).toBe(LOCAL_SERVICE_DOWN);
    agent.close(1000, "done");
  });

  it("passes other agent errors through as text, without the provenance header", async () => {
    const { host, base, service, agent, key } = await standUp();
    const frame = nextFrame(agent);
    const pending = call(mcp(base, host, service, key));
    const req = await frame;
    agent.send(JSON.stringify({ id: req.id, type: "err", status: 429, message: "too many in-flight relay requests" }));
    const res = await pending;
    expect(res.status).toBe(429);
    expect(res.headers.get(RELAY_ERROR_HEADER)).toBeNull();
    expect(await res.text()).toBe("too many in-flight relay requests");
    agent.close(1000, "done");
  });

  it("explains a path finch does not forward", async () => {
    const { host, base, service, agent, key } = await standUp();
    const frame = nextFrame(agent);
    const pending = call(new Request(`${base}/${service}/admin`, { headers: { host, authorization: `Bearer ${key}` } }));
    const req = await frame;
    agent.send(JSON.stringify({ id: req.id, type: "err", status: 403, message: 'rejected path (escapes upstream prefix "/mcp"): "/admin"' }));
    const res = await pending;
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toContain("--forward-all");
    expect(body.service).toBe(service);
    agent.close(1000, "done");
  });
});

describe("a machine that is offline", () => {
  it("still answers a keyless MCP request with the 401 OAuth challenge", async () => {
    const { tenant, host, base, service, agent, key } = await standUp();
    agent.close(1000, "machine asleep");
    await waitFor(async () => !(await boxState(tenant, host, service))?.connected);

    const keyless = await call(mcp(base, host, service));
    expect(keyless.status).toBe(401);
    expect(keyless.headers.get("www-authenticate")).toContain("resource_metadata=");

    const wrong = await call(mcp(base, host, service, "finch_notarealkey1234567890"));
    expect(wrong.status).toBe(403);

    const authed = await call(mcp(base, host, service, key));
    expect(authed.status).toBe(503);
    expect(authed.headers.get("retry-after")).toBe("30");
    const body = (await authed.json()) as any;
    expect(body.error).toMatch(/^service offline: no machine serving it is connected to finch/);
    expect(body.hint).toContain("finch service status");
  });
});

describe("auth errors say which problem it is", () => {
  it("tells a missing key, an unknown key and a key for another service apart", async () => {
    const { tenant, host, base, service, agent } = await standUp();
    const keyless = await call(mcp(base, host, service));
    expect(keyless.status).toBe(401);
    expect(((await keyless.json()) as any).error).toContain("needs a finch_ key");

    const unknown = await call(mcp(base, host, service, "finch_notarealkey1234567890"));
    expect(unknown.status).toBe(403);
    expect(((await unknown.json()) as any).error).toBe("unknown or revoked finch_ key (see: finch keys list)");

    const other = (await (await api(tenant, host, "POST", "/api/enroll", { name: "wiki" })).json()) as any;
    const wikiKey = ((await (await api(tenant, host, "POST", "/api/keys", {
      label: "wiki-only", scope: { services: [other.id] },
    })).json()) as any).key;
    const scoped = await call(mcp(base, host, service, wikiKey));
    expect(scoped.status).toBe(403);
    expect(((await scoped.json()) as any).error).toContain("not scoped to this service");
    agent.close(1000, "done");
  });
});

describe("addresses and paths that name nothing", () => {
  it("says no finch account uses an unknown address, without 'tenant'", async () => {
    const res = await call(
      new Request("https://doesnotexist-xyz.finchmcp.com/x/mcp", { headers: { host: "doesnotexist-xyz.finchmcp.com" } }),
      PROD,
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text).error).toMatch(/^no finch account at this address/);
    expect(text).not.toContain("tenant");
  });

  it("answers an unmatched apex path with a plain 404", async () => {
    const res = await call(new Request("https://finchmcp.com/releases/latest", { headers: { host: "finchmcp.com" } }), PROD);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("not found");
  });

  it("sends www.finchmcp.com to the apex", async () => {
    const res = await call(new Request("https://www.finchmcp.com/docs?x=1", { headers: { host: "www.finchmcp.com" } }), PROD);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://finchmcp.com/docs?x=1");
  });

  it("reserves /.well-known on account hosts", async () => {
    const { host, base } = await freshTenantSlug();
    const res = await call(new Request(`${base}/.well-known/oauth-authorization-server`, { headers: { host } }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("not found");
  });
});

describe("hub API routing", () => {
  const hub = (method: string, path: string, headers: Record<string, string> = {}) =>
    call(new Request(`https://hub.finchmcp.com${path}`, { method, headers: { host: "hub.finchmcp.com", ...headers } }));

  it("404s unknown paths and 405s wrong methods before asking for credentials", async () => {
    for (const path of ["/api/nothing", "/api/cli/nothing", "/api", "/api/services/x/explode"]) {
      const res = await hub("GET", path);
      expect(res.status, path).toBe(404);
    }
    const post = await hub("POST", "/api/version");
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    const cliWrong = await hub("GET", "/api/cli/enroll");
    expect(cliWrong.status).toBe(405);
    // A known route still wants its credential.
    expect((await hub("GET", "/api/state")).status).toBe(401);
    expect((await hub("GET", "/api/cli/state")).status).toBe(401);
  });

  it("serves the latest version at /api/cli/version (and /api/version), unauthenticated", async () => {
    for (const path of ["/api/cli/version", "/api/version"]) {
      const res = await hub("GET", path);
      expect(res.status, path).toBe(200);
      expect(await res.json()).toEqual({ latest: LATEST_AGENT });
    }
    expect(LATEST_AGENT).toBe("1.8.0");
  });

  it("sends Retry-After with every 429", async () => {
    const JOIN_LIMIT = { limit: async () => ({ success: false }) };
    const res = await call(
      new Request("https://hub.finchmcp.com/api/cli/whoami", { headers: { host: "hub.finchmcp.com" } }),
      { JOIN_LIMIT },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

describe("GET /api/cli/logs", () => {
  it("returns the calls the relay recorded, newest first", async () => {
    const { tenant, host, base, service, agent, key } = await standUp();
    for (const status of [200, 500]) {
      const frame = nextFrame(agent);
      const pending = call(mcp(base, host, service, key));
      const req = await frame;
      agent.send(JSON.stringify({ id: req.id, type: "head", status, headers: [["content-type", "application/json"]] }));
      agent.send(JSON.stringify({ id: req.id, type: "end" }));
      await (await pending).text();
    }
    const token = await cliToken(tenant);
    const logs = (q: string) =>
      call(new Request(`https://hub.finchmcp.com/api/cli/logs?${q}`, {
        headers: { host: "hub.finchmcp.com", authorization: `Bearer ${token}` },
      }));
    let body: any;
    await waitFor(async () => {
      body = await (await logs(`service=${service}&limit=5`)).json();
      return body.calls?.length === 2;
    });
    expect(body.service).toBe(service);
    expect(body.calls.map((c: any) => c.status)).toEqual([500, 200]);
    expect(body.calls[0]).toMatchObject({ route: `/${service}/mcp`, caller: "care" });
    expect(Object.keys(body.calls[0]).sort()).toEqual(["caller", "ms", "route", "status", "ts"]);

    const one = (await (await logs(`service=${service}&limit=1`)).json()) as any;
    expect(one.calls).toHaveLength(1);
    expect((await logs("service=ghost&limit=5")).status).toBe(404);
    expect((await logs(`service=${service}&limit=0`)).status).toBe(400);
    const unauth = await call(new Request(`https://hub.finchmcp.com/api/cli/logs?service=${service}`, { headers: { host: "hub.finchmcp.com" } }));
    expect(unauth.status).toBe(401);
    agent.close(1000, "done");
  });
});
