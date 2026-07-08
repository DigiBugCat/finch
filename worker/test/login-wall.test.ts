import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import { signAssertion, signToken, signSession, genJti } from "../src/auth";

// LOGIN-WALL E2E — drives the REAL worker (worker.fetch) through the browser
// login wall in front of the relay plane. The wall is the new DEFAULT for a
// keyless BROWSER hit on a PRIVATE service: no finch_ bearer, not service-
// authed, service.auth==="key" → 302 to /portal/start. The four bypasses
// (finch_ bearer / svc-auth / public service) and the /__finch/cb cookie
// hand-off are all exercised here against the genuine RouterDO + TenantDO.
//
// Tenancy: unlike e2e.test.ts (which leans on the DEV DEFAULT_TENANT fallback on
// a non-slug host), the wall binds the session cookie to a SLUG host, so we
// register a real slug→tenant mapping in the RouterDO and drive everything on
// <slug>.finchmcp.com. Test fixtures (FINCH_SERVICE_SECRET / TICKET_SECRET /
// SESSION_SECRET / WEB_URL) live in wrangler.test.jsonc.

const SERVICE = env.FINCH_SERVICE_SECRET; // "test-service-secret"
const TICKET = env.TICKET_SECRET; // "test-ticket-secret"
const SESSION = env.SESSION_SECRET; // "test-session-secret"
const WEB_URL = env.WEB_URL!; // "https://web.test"

const nowSec = () => Math.floor(Date.now() / 1000);

let seq = 0;
/** A fresh tenant + slug pair, registered slug→tenant in the RouterDO so the
 *  relay resolves <slug>.finchmcp.com to this tenant. Slugs must be a single DNS
 *  label [a-z0-9-]; we keep them short + unique per test. */
async function freshTenantSlug(): Promise<{
  tenant: string;
  slug: string;
  host: string;
  base: string;
}> {
  const n = `${Date.now().toString(36)}${seq++}`.toLowerCase();
  const tenant = `user_wall_${n}`;
  const slug = `wall${n}`;
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
  const res = await worker.fetch(req, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

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
 *  everything the wall tests need. The agent socket is left open (the caller
 *  closes it). The service is KEY-gated by default. */
async function standUpService() {
  const ctx = await freshTenantSlug();
  const { tenant, slug, host, base } = ctx;

  const enroll = (await (
    await api(tenant, host, "POST", "/api/enroll", { name: "Wall Box" })
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

/** Mint a session cookie exactly as /__finch/cb does. */
function mintSession(
  over: Partial<{
    tenant: string;
    slug: string;
    userId: string;
    epoch: number;
    exp: number;
  }> & { tenant: string; slug: string },
): Promise<string> {
  return signSession(
    {
      kind: "session",
      tenant: over.tenant,
      slug: over.slug,
      userId: over.userId ?? "user_123",
      epoch: over.epoch ?? 0,
      exp: over.exp ?? nowSec() + 3600,
    } as any,
    SESSION,
  );
}

/** Mint a portal grant exactly as /api/portal-grant does. */
function mintPortal(
  over: Partial<{
    tenant: string;
    slug: string;
    userId: string;
    exp: number;
    jti: string;
  }> & { tenant: string; slug: string },
): Promise<string> {
  return signToken(
    {
      kind: "portal",
      tenant: over.tenant,
      slug: over.slug,
      userId: over.userId ?? "user_123",
      exp: over.exp ?? nowSec() + 60,
      jti: over.jti ?? genJti(),
    } as any,
    TICKET,
  );
}

describe("login wall — keyless browser hit on a private service", () => {
  it("302s a keyless browser to /portal/start with slug + rd", async () => {
    const { host, base, slug, service, agent } = await standUpService();

    const res = await call(
      new Request(`${base}/${service}/index.html?x=1`, {
        method: "GET",
        headers: { host, accept: "text/html" },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe(WEB_URL); // bounced to the dashboard portal
    expect(loc.pathname).toBe("/portal/start");
    expect(loc.searchParams.get("slug")).toBe(slug);
    // rd carries the ORIGINAL path+query so the user lands where they meant to.
    expect(loc.searchParams.get("rd")).toBe(`/${service}/index.html?x=1`);

    agent.close(1000, "done");
  });

  it("401s a keyless MCP call with the OAuth challenge (no wall for machine callers)", async () => {
    const { host, base, service, agent } = await standUpService();
    // A keyless POST /mcp is a MACHINE request (no Accept: text/html): it must
    // reach the key gate and get the 401 whose WWW-Authenticate challenge is how
    // OAuth-capable clients (claude.ai connectors) discover the flow. Walling it
    // 302'd them to a browser portal they can't use — "couldn't connect".
    const res = await call(
      new Request(`${base}/${service}/mcp`, {
        method: "POST",
        headers: { host, "content-type": "application/json" },
        body: "{}",
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(401);
    agent.close(1000, "done");
  });

  it("never walls a non-finch_ bearer (OAuth access tokens reach the relay gates)", async () => {
    const { host, base, service, agent } = await standUpService();
    // The claude.ai connector regression: after completing the Clerk OAuth flow
    // the client calls with a plain Bearer token. Walling it 302'd the client to
    // the browser portal. It must reach relayMcp's gates instead (which 401/403
    // an unverifiable token — anything but a redirect).
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

  it("relays (no wall) when a valid finch_session cookie is present", async () => {
    const { host, base, slug, tenant, service, agent } =
      await standUpService();
    const cookie = await mintSession({ tenant, slug });

    const reqSeen = nextFrame(agent);
    const relayP = call(
      new Request(`${base}/${service}/index.html`, {
        method: "GET",
        headers: { host, accept: "text/html", cookie: `finch_session=${cookie}` },
        redirect: "manual",
      }),
    );
    const reqFrame = await reqSeen;
    expect(reqFrame.type).toBe("req");
    expect(reqFrame.path).toBe("/index.html");
    reply200(agent, reqFrame.id, "<h1>ok</h1>");
    const res = await relayP;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>ok</h1>");

    agent.close(1000, "done");
  });

  it("strips ONLY finch_session from the Cookie header — the app's own cookies survive (#1)", async () => {
    const { host, base, slug, tenant, service, agent } =
      await standUpService();
    const cookie = await mintSession({ tenant, slug });

    const reqSeen = nextFrame(agent);
    const relayP = call(
      new Request(`${base}/${service}/index.html`, {
        method: "GET",
        headers: {
          host,
          accept: "text/html",
          // A logged-in browser carries BOTH the login-wall cookie AND the hosted
          // app's own cookies. A blanket "contains finch_" strip would delete the
          // whole header and break the site; only finch_session must be removed.
          cookie: `finch_session=${cookie}; app_sid=abc123; theme=dark`,
        },
        redirect: "manual",
      }),
    );
    const reqFrame = await reqSeen;
    expect(reqFrame.type).toBe("req");
    const fwd = (reqFrame.headers ?? {}) as Record<string, string>;
    // The hosted app's OWN cookies survive to the box...
    expect(fwd.cookie).toContain("app_sid=abc123");
    expect(fwd.cookie).toContain("theme=dark");
    // ...but the login-wall cookie is gone (never crosses the trust boundary).
    expect(fwd.cookie).not.toContain("finch_session");
    reply200(agent, reqFrame.id, "<h1>ok</h1>");
    expect((await relayP).status).toBe(200);

    agent.close(1000, "done");
  });

  it("deletes the Cookie header entirely when finch_session is the only cookie (#1)", async () => {
    const { host, base, slug, tenant, service, agent } =
      await standUpService();
    const cookie = await mintSession({ tenant, slug });

    const reqSeen = nextFrame(agent);
    const relayP = call(
      new Request(`${base}/${service}/index.html`, {
        method: "GET",
        headers: { host, accept: "text/html", cookie: `finch_session=${cookie}` },
        redirect: "manual",
      }),
    );
    const reqFrame = await reqSeen;
    const fwd = (reqFrame.headers ?? {}) as Record<string, string>;
    // Nothing left to forward → no cookie header at all (not an empty string).
    expect(fwd.cookie).toBeUndefined();
    reply200(agent, reqFrame.id, "<ok/>");
    expect((await relayP).status).toBe(200);

    agent.close(1000, "done");
  });

  it("does NOT wall a finch_ bearer call (key plane unchanged: 403 bad-key / relay good-key)", async () => {
    const { host, base, tenant, service, agent } = await standUpService();

    // A WELL-FORMED finch_ bearer is the MCP/key plane — the wall is bypassed and
    // relayMcp's checkKey is the authority. A wrong key → 403 (NOT a 302 wall).
    // (A keyless, NON-bearer browser hit is the wall's job — covered separately;
    // here we prove the bearer path is unchanged.)
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

    // A good key still relays (Gate1 all + the locked owner ACL rule).
    const minted = (await (
      await api(tenant, host, "POST", "/api/keys", {
        label: "wall-key",
        scope: { all: true },
        owner: "you",
      })
    ).json()) as { key: string };
    const reqSeen = nextFrame(agent);
    const relayP = call(
      new Request(`${base}/${service}/mcp`, {
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          authorization: `Bearer ${minted.key}`,
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
        redirect: "manual",
      }),
    );
    const reqFrame = await reqSeen;
    reply200(agent, reqFrame.id, "<ok/>");
    const good = await relayP;
    expect(good.status).toBe(200);

    agent.close(1000, "done");
  });

  it("does NOT wall a PUBLIC service (open webpage, no cookie)", async () => {
    const { host, base, tenant, service, agent } = await standUpService();
    // Flip to public.
    await api(
      tenant,
      host,
      "PUT",
      `/api/services/${encodeURIComponent(service)}/auth`,
      { mode: "public" },
    );

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
    reply200(agent, reqFrame.id, "<pub/>");
    const res = await relayP;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<pub/>");

    agent.close(1000, "done");
  });
});

describe("login wall — session cookie validity", () => {
  it("ignores a cookie bound to a DIFFERENT slug (walls anyway)", async () => {
    const { host, base, tenant, service, agent } = await standUpService();
    // A cookie for the right tenant but the WRONG slug must not authorize.
    const cookie = await mintSession({ tenant, slug: "someotherlabel" });
    const res = await call(
      new Request(`${base}/${service}/index.html`, {
        method: "GET",
        headers: { host, accept: "text/html", cookie: `finch_session=${cookie}` },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    agent.close(1000, "done");
  });

  it("ignores a tampered/forged-secret session cookie (walls anyway)", async () => {
    const { host, base, slug, tenant, service, agent } =
      await standUpService();
    // Signed with the WRONG secret → HMAC fails → no session → wall.
    const forged = await signSession(
      {
        kind: "session",
        tenant,
        slug,
        userId: "user_123",
        epoch: 0,
        exp: nowSec() + 3600,
      } as any,
      "attacker-secret",
    );
    const res = await call(
      new Request(`${base}/${service}/index.html`, {
        method: "GET",
        headers: { host, accept: "text/html", cookie: `finch_session=${forged}` },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    agent.close(1000, "done");
  });

  it("ignores an EXPIRED session cookie (walls anyway)", async () => {
    const { host, base, slug, tenant, service, agent } =
      await standUpService();
    const expired = await mintSession({
      tenant,
      slug,
      exp: nowSec() - 1,
    });
    const res = await call(
      new Request(`${base}/${service}/index.html`, {
        method: "GET",
        headers: { host, accept: "text/html", cookie: `finch_session=${expired}` },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    agent.close(1000, "done");
  });

  it("invalidates a live cookie after bumpSessionEpoch (sign everyone out)", async () => {
    const { host, base, slug, tenant, service, agent } =
      await standUpService();
    // A cookie at epoch 0 works...
    const cookie = await mintSession({ tenant, slug, epoch: 0 });
    const reqSeen = nextFrame(agent);
    const relayP = call(
      new Request(`${base}/${service}/index.html`, {
        method: "GET",
        headers: { host, accept: "text/html", cookie: `finch_session=${cookie}` },
        redirect: "manual",
      }),
    );
    const f = await reqSeen;
    reply200(agent, f.id, "<ok/>");
    expect((await relayP).status).toBe(200);

    // ...bump the tenant's sessionEpoch (sign everyone out)...
    const stub = env.TENANT.get(env.TENANT.idFromName(tenant));
    const bump = await (
      await stub.fetch("https://tenant/op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "bumpSessionEpoch" }),
      })
    ).json();
    expect((bump as any).epoch).toBe(1);

    // ...and the SAME epoch-0 cookie is now treated as logged out → wall.
    const res = await call(
      new Request(`${base}/${service}/index.html`, {
        method: "GET",
        headers: { host, accept: "text/html", cookie: `finch_session=${cookie}` },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    agent.close(1000, "done");
  });

  it("POST /api/sessions-revoke bumps the epoch; an old-epoch cookie is then walled (#7)", async () => {
    const { host, base, slug, tenant, service, agent } =
      await standUpService();
    // A cookie minted under the CURRENT (epoch 0) session works...
    const cookie = await mintSession({ tenant, slug, epoch: 0 });
    const reqSeen = nextFrame(agent);
    const relayP = call(
      new Request(`${base}/${service}/index.html`, {
        method: "GET",
        headers: { host, accept: "text/html", cookie: `finch_session=${cookie}` },
        redirect: "manual",
      }),
    );
    const f = await reqSeen;
    reply200(agent, f.id, "<ok/>");
    expect((await relayP).status).toBe(200);

    // ...the web BFF calls the service-authed revocation route ("sign everyone
    // out"), which bumps the tenant's sessionEpoch via bumpSessionEpoch...
    const revoke = await api(tenant, host, "POST", "/api/sessions-revoke");
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as any).epoch).toBe(1);

    // ...and the SAME epoch-0 cookie is now rejected by the relay gate → wall.
    const res = await call(
      new Request(`${base}/${service}/index.html`, {
        method: "GET",
        headers: { host, accept: "text/html", cookie: `finch_session=${cookie}` },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    agent.close(1000, "done");
  });
});

describe("/__finch/cb — portal grant → session cookie hand-off", () => {
  it("sets the finch_session cookie and 302s to rd on a valid single-use grant", async () => {
    const { host, base, slug, tenant } = await freshTenantSlug();
    const grant = await mintPortal({ tenant, slug });

    const res = await call(
      new Request(
        `${base}/__finch/cb?g=${encodeURIComponent(grant)}&rd=${encodeURIComponent("/scraper/mcp")}`,
        { method: "GET", headers: { host, accept: "text/html" }, redirect: "manual" },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/scraper/mcp");
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("finch_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    // PERSISTENT cookie: Max-Age matches the 12h session TTL (#11). Without it the
    // browser would drop the cookie when the tab closes (a session cookie).
    expect(setCookie).toContain(`Max-Age=${12 * 60 * 60}`);
    // HOST-scoped: no Domain attribute (can't be replayed against a sibling slug).
    expect(setCookie.toLowerCase()).not.toContain("domain=");
  });

  it("refuses a REPLAYED grant (same jti) — re-bounces to portal", async () => {
    const { host, base, slug, tenant } = await freshTenantSlug();
    const jti = genJti();
    const grant = await mintPortal({ tenant, slug, jti });

    // First use sets the cookie.
    const first = await call(
      new Request(`${base}/__finch/cb?g=${encodeURIComponent(grant)}&rd=%2F`, {
        method: "GET",
        headers: { host, accept: "text/html" },
        redirect: "manual",
      }),
    );
    expect(first.status).toBe(302);
    expect(first.headers.get("set-cookie") || "").toContain("finch_session=");

    // Replay (same jti) is refused: no cookie, re-bounced to the portal start.
    const replay = await call(
      new Request(`${base}/__finch/cb?g=${encodeURIComponent(grant)}&rd=%2F`, {
        method: "GET",
        headers: { host, accept: "text/html" },
        redirect: "manual",
      }),
    );
    expect(replay.status).toBe(302);
    expect(replay.headers.get("set-cookie")).toBeNull();
    expect(new URL(replay.headers.get("location")!).pathname).toBe(
      "/portal/start",
    );
  });

  it("refuses a grant for the WRONG tenant/slug — no cookie", async () => {
    const { host, base, slug } = await freshTenantSlug();
    // A grant for a DIFFERENT tenant than the one this host resolves to.
    const grant = await mintPortal({ tenant: "user_someone_else", slug });
    const res = await call(
      new Request(`${base}/__finch/cb?g=${encodeURIComponent(grant)}&rd=%2F`, {
        method: "GET",
        headers: { host, accept: "text/html" },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses an EXPIRED grant — no cookie", async () => {
    const { host, base, slug, tenant } = await freshTenantSlug();
    const grant = await mintPortal({ tenant, slug, exp: nowSec() - 1 });
    const res = await call(
      new Request(`${base}/__finch/cb?g=${encodeURIComponent(grant)}&rd=%2F`, {
        method: "GET",
        headers: { host, accept: "text/html" },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("neutralizes an open-redirect rd (absolute / protocol-relative → '/')", async () => {
    const { host, base, slug, tenant } = await freshTenantSlug();
    // Absolute URL rd.
    const g1 = await mintPortal({ tenant, slug });
    const r1 = await call(
      new Request(
        `${base}/__finch/cb?g=${encodeURIComponent(g1)}&rd=${encodeURIComponent("https://evil.example/phish")}`,
        { method: "GET", headers: { host, accept: "text/html" }, redirect: "manual" },
      ),
    );
    expect(r1.status).toBe(302);
    expect(r1.headers.get("location")).toBe("/");

    // Protocol-relative //evil rd.
    const g2 = await mintPortal({ tenant, slug });
    const r2 = await call(
      new Request(
        `${base}/__finch/cb?g=${encodeURIComponent(g2)}&rd=${encodeURIComponent("//evil.example/phish")}`,
        { method: "GET", headers: { host, accept: "text/html" }, redirect: "manual" },
      ),
    );
    expect(r2.status).toBe(302);
    expect(r2.headers.get("location")).toBe("/");
  });
});

describe("control-plane id decode — malformed percent-encoding (#15)", () => {
  it("degrades a malformed %-encoded service id to a clean 4xx, not a 500", async () => {
    const { host, tenant } = await freshTenantSlug();
    // A lone/partial %-escape (%zz) makes decodeURIComponent throw a URIError;
    // safeDecode must catch it so the route resolves the (now unknown) id to a
    // clean 404 instead of bubbling the throw into an unhandled 500.
    const res = await api(tenant, host, "PUT", "/api/services/%zz/auth", {
      mode: "public",
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
  });
});

describe("/__finch/logout — clears the session cookie", () => {
  it("expires finch_session (Max-Age=0) and 302s to a safe rd", async () => {
    const { host, base } = await freshTenantSlug();
    const res = await call(
      new Request(`${base}/__finch/logout?rd=${encodeURIComponent("/dash")}`, {
        method: "GET",
        headers: { host, accept: "text/html" },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dash");
    const sc = res.headers.get("set-cookie") || "";
    expect(sc).toContain("finch_session=;");
    expect(sc).toContain("Max-Age=0");
  });

  it("neutralizes an open-redirect rd on logout (→ '/')", async () => {
    const { host, base } = await freshTenantSlug();
    const res = await call(
      new Request(
        `${base}/__finch/logout?rd=${encodeURIComponent("https://evil.example")}`,
        { method: "GET", headers: { host, accept: "text/html" }, redirect: "manual" },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});
