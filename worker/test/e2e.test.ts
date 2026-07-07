import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import { signAssertion } from "../src/auth";

// FULL-STACK WORKER E2E — drives the REAL worker entry (worker.fetch) end to end
// through the complete happy path, proving the new refresh flow + the streaming
// relay + the whole auth model (service assertion → enroll → join → refresh →
// agent _connect → mint a finch_ key that passes BOTH checkKey gates → relay an
// MCP call through a fake agent and read back a streamed body) all work together.
//
// Tenancy: the relay plane resolves the tenant from the host slug. We use a
// NON-slug test host (so slugFromHost() === "") and rely on the DEV=1 +
// DEFAULT_TENANT fallback in resolveTenant(); we enroll under that SAME tenant
// (DEFAULT_TENANT) so the key, the service, and the relay all share one
// TenantDO. Test fixtures: FINCH_SERVICE_SECRET / TICKET_SECRET / DEFAULT_TENANT
// / DEV live in wrangler.test.jsonc.

const SERVICE = env.FINCH_SERVICE_SECRET; // "test-service-secret"
const TENANT = env.DEFAULT_TENANT!; // "dev-tenant" — the DEV resolveTenant fallback
const HOST = "hub.test"; // a non-slug host → resolveTenant falls back to TENANT
const BASE = `http://${HOST}`;

const nowSec = () => Math.floor(Date.now() / 1000);

/** A short-lived signed tenant assertion, exactly as the web BFF (lib/hub.ts)
 *  mints it: signAssertion({tenant,exp}, FINCH_SERVICE_SECRET). */
function assertion(tenant = TENANT): Promise<string> {
  return signAssertion({ tenant, exp: nowSec() + 300 }, SERVICE);
}

/** Drive the real worker default export with a fresh ExecutionContext, flushing
 *  any ctx.waitUntil() work (e.g. the relay's recordCall) before returning. */
async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A control-plane (/api/*) request: service secret + signed tenant assertion. */
async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    "X-Finch-Service": SERVICE,
    "X-Finch-Auth": await assertion(),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return call(
    new Request(`${BASE}${path}`, {
      method,
      headers: { ...headers, host: HOST },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}

/** Read the next text frame off a socket (the relayed `req` frame). */
function nextFrame(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (ev: MessageEvent) => resolve(JSON.parse(ev.data as string)),
      { once: true },
    );
  });
}

/** base64 of a UTF-8 string (the agent sends chunk bodies base64-encoded). */
function b64(s: string): string {
  return btoa(s);
}

/** Poll GET /api/state until `pred` holds for the box, or throw. The relay's
 *  load-balanced pick reads persisted liveness (connected && !pending), which is
 *  written by the BoxDO's markBox inside ITS OWN ctx.waitUntil on WS
 *  open — so it can lag the 101 by a tick. Poll instead of racing it. */
async function waitForBox(
  service: string,
  box: string,
  pred: (m: any) => boolean,
  tries = 50,
): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const res = await api("GET", "/api/state");
    expect(res.status).toBe(200);
    const state = (await res.json()) as any;
    const ap = (state.services ?? []).find((a: any) => a.id === service);
    const m = ap?.boxes?.find((x: any) => x.name === box);
    if (m && pred(m)) return m;
    // Yield to the event loop so the DO's waitUntil writes can land.
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`box ${service}/${box} never satisfied predicate`);
}

describe("full-stack worker E2E — enroll → join → refresh → connect → key → relay", () => {
  it("runs the complete happy path and streams a relayed MCP body back as 'hello world'", async () => {
    const boxName = `box-e2e-${Date.now()}`;

    // ---- 1. ENROLL: service-authed, signed-assertion tenant. ----
    const enrollRes = await api("POST", "/api/enroll", { name: "Scraper E2E" });
    expect(enrollRes.status).toBe(200);
    const enroll = (await enrollRes.json()) as {
      id: string;
      ticket: string;
      url: string;
      install: string;
      expiresAt: number;
    };
    const service = enroll.id;
    expect(service).toBeTruthy();
    expect(enroll.ticket).toBeTruthy();

    // ---- 2. JOIN: ticket-authed; returns connectToken AND refreshToken. ----
    const joinRes = await call(
      new Request(`${BASE}/join`, {
        method: "POST",
        headers: { "content-type": "application/json", host: HOST },
        body: JSON.stringify({
          ticket: enroll.ticket,
          box: boxName,
          os: "darwin",
          version: "1.4.0",
        }),
      }),
    );
    expect(joinRes.status).toBe(200);
    const join = (await joinRes.json()) as {
      ok: boolean;
      tenant: string;
      service: string;
      box: string;
      connectToken: string;
      refreshToken: string;
    };
    expect(join.ok).toBe(true);
    expect(join.tenant).toBe(TENANT); // same TenantDO the key+relay will use
    expect(join.service).toBe(service);
    expect(join.box).toBe(boxName);
    expect(join.connectToken).toBeTruthy();
    expect(join.refreshToken).toBeTruthy();

    // ---- 3. REFRESH: trade the refresh token for a FRESH connect-token. ----
    const refreshRes = await call(
      new Request(`${BASE}/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", host: HOST },
        body: JSON.stringify({ refreshToken: join.refreshToken }),
      }),
    );
    expect(refreshRes.status).toBe(200);
    const refresh = (await refreshRes.json()) as {
      ok: boolean;
      connectToken: string;
    };
    expect(refresh.ok).toBe(true);
    expect(refresh.connectToken).toBeTruthy();
    // A genuinely fresh grant (it must still authenticate the _connect dial).
    expect(typeof refresh.connectToken).toBe("string");

    // A bogus refresh token is rejected (401). (Distinct from the 403 a real
    // refresh token for a removed box would get — here the HMAC fails.)
    const badRefresh = await call(
      new Request(`${BASE}/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", host: HOST },
        body: JSON.stringify({ refreshToken: "not-a-real-token" }),
      }),
    );
    expect(badRefresh.status).toBe(401);

    // ---- 4. CONNECT: open a fake agent over the WS _connect using the FRESH
    //      connect-token from /refresh (proves the refresh-minted token actually
    //      authenticates the relay channel through the real worker). ----
    const connectUrl =
      `${BASE}/${service}/${encodeURIComponent(boxName)}/_connect` +
      `?ct=${encodeURIComponent(refresh.connectToken)}`;
    const connectRes = await call(
      new Request(connectUrl, { headers: { Upgrade: "websocket", host: HOST } }),
    );
    expect(connectRes.status).toBe(101);
    const agent = connectRes.webSocket!;
    expect(agent).toBeTruthy();
    agent.accept(); // accept the client (agent-writing) end

    // The BoxDO marks the box connected inside its own waitUntil on the
    // 101; wait for that liveness to land before we approve / relay.
    await waitForBox(service, boxName, (m) => m.connected === true);

    // ---- Approve the service so the box leaves "pending" (requireApproval
    //      defaults true). The LB relay picks only boxes that are
    //      connected && state !== "pending". ----
    const approveRes = await api(
      "POST",
      `/api/services/${encodeURIComponent(service)}/approve`,
    );
    expect(approveRes.status).toBe(200);
    await waitForBox(
      service,
      boxName,
      (m) => m.connected === true && m.state !== "pending",
    );

    // ---- 5. KEY: mint a finch_ key that ACTUALLY WORKS. scope:{all:true} clears
    //      Gate 1; owner:"you" gives the key a user identity that the fresh
    //      tenant's locked default ACL rule (src user "you" → dst all) matches,
    //      clearing Gate 2. Both gates of checkKey pass for THIS service. ----
    const keyRes = await api("POST", "/api/keys", {
      label: "e2e-key",
      scope: { all: true },
      owner: "you",
    });
    expect(keyRes.status).toBe(200);
    const minted = (await keyRes.json()) as { key: string; scope: any };
    expect(minted.key).toMatch(/^finch_/);
    expect(minted.scope).toEqual({ all: true });
    const KEY = minted.key;

    // ---- 6. RELAY (the payoff): POST /<app>/mcp with the minted key. The fake
    //      agent reads the req frame, then replies head + chunk("hello ") +
    //      chunk("world") + end. The Response must be 200, stream, and the body
    //      must reassemble to exactly "hello world". ----
    const reqSeen = nextFrame(agent);
    const relayPromise = call(
      new Request(`${BASE}/${service}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${KEY}`,
          host: HOST,
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      }),
    );

    const reqFrame = await reqSeen;
    expect(reqFrame.type).toBe("req");
    expect(reqFrame.method).toBe("POST");
    expect(reqFrame.path).toBe("/mcp"); // DO stripped /<app>/<box>
    expect(reqFrame.body).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    );
    // The caller's finch_ key must NEVER cross to the agent (key-strip at relay).
    const fwdHeaders = reqFrame.headers as Record<string, string>;
    expect(fwdHeaders.authorization).toBeUndefined();
    for (const v of Object.values(fwdHeaders)) {
      expect(v.includes("finch_")).toBe(false);
    }
    const id: string = reqFrame.id;

    // Reply head → chunk → chunk → end, keyed on the live relay id.
    agent.send(
      JSON.stringify({
        id,
        type: "head",
        status: 200,
        headers: [["content-type", "text/event-stream"]],
      }),
    );
    agent.send(JSON.stringify({ id, type: "chunk", data: b64("hello ") }));
    agent.send(JSON.stringify({ id, type: "chunk", data: b64("world") }));
    agent.send(JSON.stringify({ id, type: "end" }));

    const relayRes = await relayPromise;
    expect(relayRes.status).toBe(200);
    expect(relayRes.headers.get("content-type")).toBe("text/event-stream");
    expect(await relayRes.text()).toBe("hello world");

    // ---- 7. NEGATIVE: same /mcp with NO key → 401; with a WRONG finch_ key
    //      (well-formed bearer, never minted) → 403. ----
    const noKey = await call(
      new Request(`${BASE}/${service}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", host: HOST },
        body: "{}",
      }),
    );
    expect(noKey.status).toBe(401);

    const wrongKey = await call(
      new Request(`${BASE}/${service}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer finch_deadbeefdeadbeefdeadbeefdeadbeef",
          host: HOST,
        },
        body: "{}",
      }),
    );
    expect(wrongKey.status).toBe(403);

    agent.close(1000, "e2e done");
  });

  it("public service relays any path with NO finch_ key; flipping back to key re-gates it", async () => {
    const boxName = `box-pub-${Date.now()}`;

    // Enroll → join → connect → approve (same scaffolding as the happy path).
    const enroll = (await (await api("POST", "/api/enroll", {
      name: "Public Site",
    })).json()) as { id: string; ticket: string };
    const service = enroll.id;

    const join = (await (await call(
      new Request(`${BASE}/join`, {
        method: "POST",
        headers: { "content-type": "application/json", host: HOST },
        body: JSON.stringify({
          ticket: enroll.ticket,
          box: boxName,
          os: "linux",
          version: "1.4.0",
        }),
      }),
    )).json()) as { connectToken: string };

    const connectRes = await call(
      new Request(
        `${BASE}/${service}/${encodeURIComponent(boxName)}/_connect` +
          `?ct=${encodeURIComponent(join.connectToken)}`,
        { headers: { Upgrade: "websocket", host: HOST } },
      ),
    );
    expect(connectRes.status).toBe(101);
    const agent = connectRes.webSocket!;
    agent.accept();
    await waitForBox(service, boxName, (m) => m.connected === true);
    await api(
      "POST",
      `/api/services/${encodeURIComponent(service)}/approve`,
    );
    await waitForBox(
      service,
      boxName,
      (m) => m.connected === true && m.state !== "pending",
    );

    // Default service is key-gated: a no-key call still 401s.
    const preFlip = await call(
      new Request(`${BASE}/${service}/index.html`, { headers: { host: HOST } }),
    );
    expect(preFlip.status).toBe(401);

    // Flip to PUBLIC via the BFF route.
    const flip = await api(
      "PUT",
      `/api/services/${encodeURIComponent(service)}/auth`,
      { mode: "public" },
    );
    expect(flip.status).toBe(200);

    // GET /<app>/index.html with NO Authorization header — a public webpage. The
    // agent should see the relayed request at path "/index.html" (NOT /mcp, and
    // not load-balanced away), and the response streams back 200.
    const reqSeen = nextFrame(agent);
    const relayPromise = call(
      new Request(`${BASE}/${service}/index.html`, {
        method: "GET",
        headers: { host: HOST },
      }),
    );
    const reqFrame = await reqSeen;
    expect(reqFrame.type).toBe("req");
    expect(reqFrame.method).toBe("GET");
    expect(reqFrame.path).toBe("/index.html"); // any path forwards, not just /mcp
    const id: string = reqFrame.id;
    agent.send(
      JSON.stringify({
        id,
        type: "head",
        status: 200,
        headers: [["content-type", "text/html"]],
      }),
    );
    agent.send(JSON.stringify({ id, type: "chunk", data: btoa("<h1>hi</h1>") }));
    agent.send(JSON.stringify({ id, type: "end" }));
    const relayRes = await relayPromise;
    expect(relayRes.status).toBe(200);
    expect(relayRes.headers.get("content-type")).toBe("text/html");
    expect(await relayRes.text()).toBe("<h1>hi</h1>");

    // Flip back to KEY — the same no-key call is re-gated to 401.
    const unflip = await api(
      "PUT",
      `/api/services/${encodeURIComponent(service)}/auth`,
      { mode: "key" },
    );
    expect(unflip.status).toBe(200);
    const reGated = await call(
      new Request(`${BASE}/${service}/index.html`, { headers: { host: HOST } }),
    );
    expect(reGated.status).toBe(401);

    agent.close(1000, "public e2e done");
  });
});
