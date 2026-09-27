import { beforeAll, describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import {
  callerAssertionJwks,
  signAssertion,
  verifyCallerAssertion,
  type CallerAssertionJwk,
} from "../src/auth";

// RELAY AUTH E2E — drives the REAL worker (worker.fetch) through the relay
// plane's caller authentication against the genuine RouterDO + TenantDO +
// BoxDO. A caller is exactly one of: a finch_ key, a Clerk OAuth token for the
// tenant OWNER, the first-party service assertion (/api/cli/call), or nobody
// on a PUBLIC service. There is no browser login wall any more: a keyless
// browser gets the same JSON 401 as any other keyless caller.
//
// Tenancy: we register a real slug→tenant mapping in the RouterDO and drive
// everything on <slug>.finchmcp.com (e2e.test.ts covers the DEV
// DEFAULT_TENANT fallback). Test fixtures live in wrangler.test.jsonc.

const SERVICE = env.FINCH_SERVICE_SECRET; // "test-service-secret"

const nowSec = () => Math.floor(Date.now() / 1000);

let assertionBindings: Record<string, unknown> = {};
let assertionPublicJwks: { keys: CallerAssertionJwk[] };

// Generate an extractable TEST-ONLY signer inside workerd. Production reads a
// private JWKS from a Worker secret; no private material is checked into git.
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateKey = {
    ...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    kid: "relay-auth-test-2026",
    alg: "ES256",
    use: "sig",
  } as CallerAssertionJwk;
  const privateJwks = JSON.stringify({ keys: [privateKey] });
  assertionBindings = {
    FINCH_ASSERTION_ACTIVE_KID: privateKey.kid,
    FINCH_ASSERTION_PRIVATE_JWKS: privateJwks,
    FINCH_ASSERTION_ISSUER: "https://finch.test",
  };
  assertionPublicJwks = callerAssertionJwks({ privateJwks });
});

let seq = 0;
/** A fresh tenant + slug pair, registered slug→tenant in the RouterDO so the
 *  relay resolves <slug>.finchmcp.com to this tenant. Slugs must be a single DNS
 *  label [a-z0-9-]; we keep them short + unique per test. */
async function freshTenantSlug(prefix = "user_relay_"): Promise<{
  tenant: string;
  slug: string;
  host: string;
  base: string;
}> {
  const n = `${Date.now().toString(36)}${seq++}`.toLowerCase();
  const tenant = `${prefix}${n}`;
  const slug = `relay${n}`;
  // Register the mapping via the singleton RouterDO (same op routerRegister uses).
  const stub = env.ROUTER.get(env.ROUTER.idFromName("global"));
  const res = await stub.fetch("https://router/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "register", slug, tenant }),
  });
  const out = (await res.json()) as { ok: boolean };
  expect(out.ok).toBe(true);
  const host = `${slug}.finchmcp.com`;
  return { tenant, slug, host, base: `https://${host}` };
}

function assertion(tenant: string): Promise<string> {
  return signAssertion({ tenant, exp: nowSec() + 300 }, SERVICE);
}

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    req,
    {
      ...(env as any),
      ...assertionBindings,
      // Test-only service binding for Clerk userinfo. A token of the form
      // oauth:<clerk user id>[;<org id>;<org role>] authenticates that user,
      // with organization claims when the suffix is present (the hub must
      // ignore them). Anything else is an invalid token. The raw token is
      // never forwarded to the agent or placed in the assertion.
      CLERK_USERINFO: {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          if (String(input) !== "http://127.0.0.1:1/oauth/userinfo") {
            return Response.json({ error: "unexpected userinfo URL" }, { status: 500 });
          }
          const auth = new Headers(init?.headers).get("authorization") || "";
          const token = auth.replace(/^Bearer\s+/, "");
          if (!/^oauth:user_[A-Za-z0-9_]+(;org_[A-Za-z0-9_]+;org:[a-z]+)?$/.test(token)) {
            return Response.json({ error: "invalid token" }, { status: 401 });
          }
          const [sub, orgId, orgRole] = token.slice("oauth:".length).split(";");
          return Response.json({
            sub,
            ...(orgId ? { org_id: orgId } : {}),
            ...(orgRole ? { org_role: orgRole } : {}),
          });
        },
      },
    } as any,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function verifiedFrameAssertion(frame: any, expected: {
  tenant: string;
  service: string;
  method: string;
  upstreamPath: string;
  publicPath: string;
}) {
  expect(frame.assertion).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
  expect(frame.headers?.["x-finch-assertion"]).toBeUndefined();
  const claims = await verifyCallerAssertion(
    frame.assertion,
    assertionPublicJwks,
    {
      issuer: "https://finch.test",
      audience: `finch:${expected.tenant}:${expected.service}`,
      tenant: expected.tenant,
      service: expected.service,
      method: expected.method,
      upstreamPath: expected.upstreamPath,
      publicPath: expected.publicPath,
    },
  );
  expect(claims).not.toBeNull();
  return claims!;
}

describe("caller assertion JWKS", () => {
  it("serves the active and retiring public keys without private material", async () => {
    const res = await call(
      new Request("https://any-supported-host.test/.well-known/finch-jwks.json"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jwk-set+json");
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    expect(res.headers.get("x-finch-active-kid")).toBe(
      "relay-auth-test-2026",
    );
    const body = (await res.json()) as { keys: CallerAssertionJwk[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      kid: "relay-auth-test-2026",
      kty: "EC",
      crv: "P-256",
      alg: "ES256",
      use: "sig",
    });
    expect(body.keys[0].d).toBeUndefined();
  });

  it("fails closed for absent or partial signer configuration", async () => {
    const request = () =>
      new Request("https://jwks.test/.well-known/finch-jwks.json");
    const absentCtx = createExecutionContext();
    const absent = await worker.fetch(request(), env as any, absentCtx);
    await waitOnExecutionContext(absentCtx);
    expect(absent.status).toBe(404);

    const partialCtx = createExecutionContext();
    const partial = await worker.fetch(
      request(),
      {
        ...(env as any),
        FINCH_ASSERTION_ACTIVE_KID: "configured-without-private-secret",
        FINCH_ASSERTION_ISSUER: "https://jwks.test",
      },
      partialCtx,
    );
    await waitOnExecutionContext(partialCtx);
    expect(partial.status).toBe(503);
    expect(await partial.json()).toEqual({
      error: "caller assertion signer unavailable",
    });
  });
});

/** A control-plane (/api/*) request: service secret + signed tenant assertion. */
async function api(
  tenant: string,
  host: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    "X-Finch-Service": SERVICE,
    "X-Finch-Auth": await assertion(tenant),
    host,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return call(
    new Request(`https://${host}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}

async function waitForBox(
  tenant: string,
  host: string,
  service: string,
  box: string,
  pred: (m: any) => boolean,
  tries = 50,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const res = await api(tenant, host, "GET", "/api/state");
    const state = (await res.json()) as any;
    const ap = (state.services ?? []).find((a: any) => a.id === service);
    const m = ap?.boxes?.find((x: any) => x.name === box);
    if (m && pred(m)) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`box ${service}/${box} never satisfied predicate`);
}

/** Stand up an approved, connected service under a fresh tenant/slug. Returns
 *  everything the relay tests need. The agent socket is left open (the caller
 *  closes it). The service is KEY-gated by default, and the tenant's own user
 *  (Clerk user id === tenant id) has signed in once, so its owner row exists. */
async function standUpService() {
  const ctx = await freshTenantSlug("user_relay_");
  const { tenant, slug, host, base } = ctx;

  const enroll = (await (
    await api(tenant, host, "POST", "/api/enroll", { name: "Relay Box" })
  ).json()) as { id: string; ticket: string };
  const service = enroll.id;

  const box = `box-${Date.now()}-${seq++}`;
  const join = (await (
    await call(
      new Request(`${base}/join`, {
        method: "POST",
        headers: { "content-type": "application/json", host },
        body: JSON.stringify({
          ticket: enroll.ticket,
          box,
          os: "linux",
          version: "1.4.0",
        }),
      }),
    )
  ).json()) as { connectToken: string };

  const connectRes = await call(
    new Request(
      `${base}/${service}/${encodeURIComponent(box)}/_connect` +
        `?ct=${encodeURIComponent(join.connectToken)}`,
      { headers: { Upgrade: "websocket", host } },
    ),
  );
  expect(connectRes.status).toBe(101);
  const agent = connectRes.webSocket!;
  agent.accept();
  await waitForBox(tenant, host, service, box, (m) => m.connected);
  await api(
    tenant,
    host,
    "POST",
    `/api/services/${encodeURIComponent(service)}/approve`,
  );
  await waitForBox(
    tenant,
    host,
    service,
    box,
    (m) => m.connected && m.state !== "pending",
  );
  const boot = (await (
    await api(tenant, host, "POST", "/api/member-context", {
      clerkUserId: tenant,
      email: "owner@example.com",
    })
  ).json()) as any;
  expect(boot.member).toMatchObject({ role: "owner", state: "active" });

  return { ...ctx, service, box, agent };
}

/** Read the next relayed `req` frame off the agent socket. */
function nextFrame(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (ev: MessageEvent) => resolve(JSON.parse(ev.data as string)),
      { once: true },
    );
  });
}

/** Flip a service's relay access mode (the op behind `finch auth`). */
async function setAuth(tenant: string, service: string, mode: "key" | "public") {
  const res = await env.TENANT.get(env.TENANT.idFromName(tenant)).fetch(
    "https://tenant.internal/",
    { method: "POST", body: JSON.stringify({ op: "setAuth", service, mode }) },
  );
  expect(((await res.json()) as any).ok).toBe(true);
}

/** Mint a scoped finch_ key through the control API. */
async function mintKey(tenant: string, host: string, label: string): Promise<string> {
  const minted = (await (
    await api(tenant, host, "POST", "/api/keys", { label, scope: { all: true } })
  ).json()) as { key: string };
  return minted.key;
}

/** Reply a simple 200 HTML body to a relayed request id (drives the fake agent). */
function reply200(agent: WebSocket, id: string, body: string): void {
  agent.send(
    JSON.stringify({
      id,
      type: "head",
      status: 200,
      headers: [["content-type", "text/html"]],
    }),
  );
  agent.send(JSON.stringify({ id, type: "chunk", data: btoa(body) }));
  agent.send(JSON.stringify({ id, type: "end" }));
}

describe("relay auth — callers on a key-gated service", () => {
  it("401s a keyless browser navigation with plain JSON — no login-wall redirect", async () => {
    const { host, base, service, agent } = await standUpService();

    const res = await call(
      new Request(`${base}/${service}/index.html?x=1`, {
        method: "GET",
        headers: { host, accept: "text/html" },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await res.json()) as any).toMatchObject({
      error: expect.stringContaining("bearer key"),
    });

    agent.close(1000, "done");
  });

  it("401s a keyless MCP call with the OAuth challenge", async () => {
    const { host, base, service, agent } = await standUpService();
    // A keyless POST /mcp reaches the key gate and gets the 401 whose
    // WWW-Authenticate challenge is how OAuth-capable clients (claude.ai
    // connectors) discover the flow.
    const res = await call(
      new Request(`${base}/${service}/mcp`, {
        method: "POST",
        headers: { host, "content-type": "application/json" },
        body: "{}",
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect((await res.json()) as any).toMatchObject({
      error: expect.stringContaining("bearer key"),
    });
    agent.close(1000, "done");
  });

  it("answers an unverifiable non-finch_ bearer with 401/403, never a redirect", async () => {
    const { host, base, service, agent } = await standUpService();
    // The claude.ai connector regression: after completing the Clerk OAuth flow
    // the client calls with a plain Bearer token. It must reach relayMcp's
    // gates (which 401/403 an unverifiable token — anything but a redirect).
    const res = await call(
      new Request(`${base}/${service}/mcp`, {
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          authorization: "Bearer not-a-finch-key-oauth-token",
        },
        body: "{}",
        redirect: "manual",
      }),
    );
    expect(res.status).not.toBe(302);
    expect([401, 403]).toContain(res.status);
    agent.close(1000, "done");
  });

  it("forwards the Cookie header untouched — the hub reads no cookie of its own", async () => {
    const { host, base, tenant, service, agent } = await standUpService();
    const key = await mintKey(tenant, host, "cookie-key");
    const cookie = "__Host-finch_session=old.one; app_sid=abc123; finch_session=old.two; theme=dark";

    const reqSeen = nextFrame(agent);
    const relayP = call(
      new Request(`${base}/${service}/index.html`, {
        method: "GET",
        headers: { host, accept: "text/html", authorization: `Bearer ${key}`, cookie },
        redirect: "manual",
      }),
    );
    const reqFrame = await reqSeen;
    expect(reqFrame.type).toBe("req");
    expect((reqFrame.headers ?? {}).cookie).toBe(cookie);
    reply200(agent, reqFrame.id, "<h1>ok</h1>");
    expect((await relayP).status).toBe(200);

    agent.close(1000, "done");
  });

  it("gates a finch_ bearer on checkKey: 403 for a bad key, relay for a good one", async () => {
    const { host, base, tenant, service, agent } = await standUpService();

    // A WELL-FORMED finch_ bearer is the MCP/key plane: relayMcp's checkKey is
    // the authority. A wrong key → 403.
    const wrongKey = await call(
      new Request(`${base}/${service}/mcp`, {
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          authorization: "Bearer finch_deadbeefdeadbeefdeadbeefdeadbeef",
        },
        body: "{}",
        redirect: "manual",
      }),
    );
    expect(wrongKey.status).toBe(403);
    expect(wrongKey.headers.get("content-type")).toContain("application/json");
    expect(wrongKey.headers.get("location")).toBeNull();
    expect((await wrongKey.json()) as any).toMatchObject({
      error: expect.any(String),
    });

    // A good key relays: it exists and its scope covers the service. Its
    // owner is the tenant owner.
    const minted = { key: await mintKey(tenant, host, "relay-key") };
    const reqSeen = nextFrame(agent);
    const relayP = call(
      new Request(`${base}/${service}/mcp`, {
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          authorization: `Bearer ${minted.key}`,
          "x-finch-assertion": "spoofed",
          "x-finch-caller": "admin",
          "x-finch-session": "attacker-session",
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
        redirect: "manual",
      }),
    );
    const reqFrame = await reqSeen;
    const keyClaims = await verifiedFrameAssertion(reqFrame, {
      tenant,
      service,
      method: "POST",
      upstreamPath: "/mcp",
      publicPath: `/${service}/mcp`,
    });
    expect(keyClaims.auth_method).toBe("finch_key");
    expect(keyClaims.sub).toMatch(/^key:k_/);
    expect(keyClaims.actor).toBe("owner@example.com");
    expect(keyClaims.key_label).toBe("relay-key");
    expect(reqFrame.headers.authorization).toBeUndefined();
    expect(reqFrame.headers["x-finch-caller"]).toBeUndefined();
    expect(reqFrame.headers["x-finch-session"]).toBeUndefined();
    for (const value of Object.values(reqFrame.headers) as string[]) {
      expect(value).not.toContain("finch_");
    }
    reply200(agent, reqFrame.id, "<ok/>");
    const good = await relayP;
    expect(good.status).toBe(200);

    agent.close(1000, "done");
  });

  it("injects a service assertion on a pinned first-party relay (/api/cli/call's path)", async () => {
    const { host, base, tenant, service, box, agent } = await standUpService();
    const publicPath =
      `/${service}/${encodeURIComponent(box)}/api/v1/tools/search`;
    const reqSeen = nextFrame(agent);
    const relayP = call(
      new Request(`${base}${publicPath}?limit=2`, {
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          "x-finch-service": SERVICE,
          "x-finch-auth": await assertion(tenant),
          "x-finch-principal": "spoofed-admin",
          "x-finch-tenant": "attacker-tenant",
        },
        body: '{"query":"birds"}',
      }),
    );
    const frame = await reqSeen;
    expect(frame.path).toBe("/api/v1/tools/search?limit=2");
    const claims = await verifiedFrameAssertion(frame, {
      tenant,
      service,
      method: "POST",
      upstreamPath: "/api/v1/tools/search?limit=2",
      publicPath,
    });
    expect(claims.auth_method).toBe("service");
    expect(claims.sub).toBe("service:finch-dashboard");
    expect(frame.headers["x-finch-service"]).toBeUndefined();
    expect(frame.headers["x-finch-auth"]).toBeUndefined();
    expect(frame.headers["x-finch-principal"]).toBeUndefined();
    expect(frame.headers["x-finch-tenant"]).toBeUndefined();
    reply200(agent, frame.id, "<ok/>");
    expect((await relayP).status).toBe(200);
    agent.close(1000, "done");
  });

  it("injects an OAuth assertion without forwarding the access token", async () => {
    const { host, base, tenant, service, agent } = await standUpService();
    const oauthToken = `oauth:${tenant}`;
    const reqSeen = nextFrame(agent);
    const relayP = call(
      new Request(`${base}/${service}/mcp`, {
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          authorization: `Bearer ${oauthToken}`,
          "x-finch-auth-method": "service",
          "x-finch-user": "attacker",
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      }),
    );
    const frame = await reqSeen;
    const claims = await verifiedFrameAssertion(frame, {
      tenant,
      service,
      method: "POST",
      upstreamPath: "/mcp",
      publicPath: `/${service}/mcp`,
    });
    expect(claims.auth_method).toBe("oauth");
    expect(claims.sub).toBe(`user:${tenant}`);
    expect(frame.headers.authorization).toBeUndefined();
    expect(frame.headers["x-finch-auth-method"]).toBeUndefined();
    expect(frame.headers["x-finch-user"]).toBeUndefined();
    expect(JSON.stringify(frame)).not.toContain(oauthToken);
    reply200(agent, frame.id, "<ok/>");
    expect((await relayP).status).toBe(200);
    agent.close(1000, "done");
  });

  it("403s a verified OAuth token for a Clerk user who does not own the tenant", async () => {
    const { host, base, service, agent } = await standUpService();
    let relayed = false;
    agent.addEventListener("message", () => { relayed = true; });
    const res = await call(
      new Request(`${base}/${service}/mcp`, {
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          authorization: "Bearer oauth:user_somebody_else",
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as any).toEqual({
      error: "token identity does not own this tenant",
    });
    expect(relayed).toBe(false);
    agent.close(1000, "done");
  });

  it("403s every OAuth token but the tenant's own user, whatever organization claims it carries", async () => {
    const { host, base, tenant, service, agent } = await standUpService();
    let relayed = false;
    agent.addEventListener("message", () => { relayed = true; });
    const orgTenant = `org_${tenant.slice("user_".length)}`;
    for (const token of [
      `oauth:user_orgadmin;${orgTenant};org:admin`,
      "oauth:user_orgadmin;org_somewhere;org:admin",
      "oauth:user_orgmember",
    ]) {
      const res = await call(
        new Request(`${base}/${service}/mcp`, {
          method: "POST",
          headers: { host, "content-type": "application/json", authorization: `Bearer ${token}` },
          body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
        }),
      );
      expect(res.status, token).toBe(403);
    }
    expect(relayed).toBe(false);
    agent.close(1000, "done");
  });

  it("relays a keyless browser on a PUBLIC service (open webpage)", async () => {
    const { host, base, tenant, service, agent } = await standUpService();
    await setAuth(tenant, service, "public");

    const reqSeen = nextFrame(agent);
    const relayP = call(
      new Request(`${base}/${service}/index.html`, {
        method: "GET",
        headers: { host, accept: "text/html" },
        redirect: "manual",
      }),
    );
    const reqFrame = await reqSeen;
    expect(reqFrame.path).toBe("/index.html");
    expect(reqFrame.assertion).toBeUndefined();
    reply200(agent, reqFrame.id, "<pub/>");
    const res = await relayP;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<pub/>");

    agent.close(1000, "done");
  });
});

describe("retired login-wall endpoints", () => {
  it("no longer serves /__finch/cb or /__finch/logout (no cookie, no redirect)", async () => {
    const { host, base } = await freshTenantSlug();
    for (const path of ["/__finch/cb?g=anything&rd=%2F", "/__finch/logout?rd=%2Fdash"]) {
      const res = await call(
        new Request(`${base}${path}`, {
          method: "GET",
          headers: { host, accept: "text/html" },
          redirect: "manual",
        }),
      );
      expect(res.status, path).toBe(404);
      expect(res.headers.get("set-cookie"), path).toBeNull();
      expect(res.headers.get("location"), path).toBeNull();
    }
  });
});

describe("control-plane id decode — malformed percent-encoding (#15)", () => {
  it("degrades a malformed %-encoded service id to a clean 4xx, not a 500", async () => {
    const { host, tenant } = await freshTenantSlug();
    // A lone/partial %-escape (%zz) makes decodeURIComponent throw a URIError;
    // safeDecode must catch it so the route resolves the (now unknown) id to a
    // clean 404 instead of bubbling the throw into an unhandled 500.
    const res = await api(tenant, host, "PUT", "/api/services/%zz/tags", {
      tags: ["x"],
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
  });
});
