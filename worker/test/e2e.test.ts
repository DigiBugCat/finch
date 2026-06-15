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
// (DEFAULT_TENANT) so the key, the appliance, and the relay all share one
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

/** Poll GET /api/state until `pred` holds for the machine, or throw. The relay's
 *  load-balanced pick reads persisted liveness (connected && !pending), which is
 *  written by the ApplianceDO's markMachine inside ITS OWN ctx.waitUntil on WS
 *  open — so it can lag the 101 by a tick. Poll instead of racing it. */
async function waitForMachine(
  appliance: string,
  machine: string,
  pred: (m: any) => boolean,
  tries = 50,
): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const res = await api("GET", "/api/state");
    expect(res.status).toBe(200);
    const state = (await res.json()) as any;
    const ap = (state.appliances ?? []).find((a: any) => a.id === appliance);
    const m = ap?.machines?.find((x: any) => x.name === machine);
    if (m && pred(m)) return m;
    // Yield to the event loop so the DO's waitUntil writes can land.
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`machine ${appliance}/${machine} never satisfied predicate`);
}

describe("full-stack worker E2E — enroll → join → refresh → connect → key → relay", () => {
  it("runs the complete happy path and streams a relayed MCP body back as 'hello world'", async () => {
    const machineName = `box-e2e-${Date.now()}`;

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
    const appliance = enroll.id;
    expect(appliance).toBeTruthy();
    expect(enroll.ticket).toBeTruthy();

    // ---- 2. JOIN: ticket-authed; returns connectToken AND refreshToken. ----
    const joinRes = await call(
      new Request(`${BASE}/join`, {
        method: "POST",
        headers: { "content-type": "application/json", host: HOST },
        body: JSON.stringify({
          ticket: enroll.ticket,
          machine: machineName,
          os: "darwin",
          version: "1.4.0",
        }),
      }),
    );
    expect(joinRes.status).toBe(200);
    const join = (await joinRes.json()) as {
      ok: boolean;
      tenant: string;
      appliance: string;
      machine: string;
      connectToken: string;
      refreshToken: string;
    };
    expect(join.ok).toBe(true);
    expect(join.tenant).toBe(TENANT); // same TenantDO the key+relay will use
    expect(join.appliance).toBe(appliance);
    expect(join.machine).toBe(machineName);
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
    // refresh token for a removed machine would get — here the HMAC fails.)
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
      `${BASE}/${appliance}/${encodeURIComponent(machineName)}/_connect` +
      `?ct=${encodeURIComponent(refresh.connectToken)}`;
    const connectRes = await call(
      new Request(connectUrl, { headers: { Upgrade: "websocket", host: HOST } }),
    );
    expect(connectRes.status).toBe(101);
    const agent = connectRes.webSocket!;
    expect(agent).toBeTruthy();
    agent.accept(); // accept the client (agent-writing) end

    // The ApplianceDO marks the machine connected inside its own waitUntil on the
    // 101; wait for that liveness to land before we approve / relay.
    await waitForMachine(appliance, machineName, (m) => m.connected === true);

    // ---- Approve the appliance so the machine leaves "pending" (requireApproval
    //      defaults true). The LB relay picks only machines that are
    //      connected && state !== "pending". ----
    const approveRes = await api(
      "POST",
      `/api/appliances/${encodeURIComponent(appliance)}/approve`,
    );
    expect(approveRes.status).toBe(200);
    await waitForMachine(
      appliance,
      machineName,
      (m) => m.connected === true && m.state !== "pending",
    );

    // ---- 5. KEY: mint a finch_ key that ACTUALLY WORKS. scope:{all:true} clears
    //      Gate 1; owner:"you" gives the key a user identity that the fresh
    //      tenant's locked default ACL rule (src user "you" → dst all) matches,
    //      clearing Gate 2. Both gates of checkKey pass for THIS appliance. ----
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
      new Request(`${BASE}/${appliance}/mcp`, {
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
    expect(reqFrame.path).toBe("/mcp"); // DO stripped /<app>/<machine>
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
      new Request(`${BASE}/${appliance}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", host: HOST },
        body: "{}",
      }),
    );
    expect(noKey.status).toBe(401);

    const wrongKey = await call(
      new Request(`${BASE}/${appliance}/mcp`, {
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
});
