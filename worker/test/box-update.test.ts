// POST /api/box-update — the dashboard "update now" push. Covers the whole
// hub-side path: svc-auth gate → boxExists → BoxDO /_control → out-of-band
// {type:"update"} frame on the live agent socket — plus the offline 503 and the
// /_control secret gate (the public relay can route arbitrary paths into the
// DO, so path alone must never be trust).
import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker, { boxStub } from "../src/index";
import { signAssertion } from "../src/auth";

const SERVICE = env.FINCH_SERVICE_SECRET;
const TENANT = env.DEFAULT_TENANT!;
const HOST = "hub.test";
const BASE = `http://${HOST}`;

const nowSec = () => Math.floor(Date.now() / 1000);

function assertion(tenant = TENANT): Promise<string> {
  return signAssertion({ tenant, exp: nowSec() + 300 }, SERVICE);
}

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

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

/** Enroll a fresh service + join a box; returns names + the join grant. */
async function enrollAndJoin(boxName: string) {
  const enrollRes = await api("POST", "/api/enroll", { name: "Updatee" });
  expect(enrollRes.status).toBe(200);
  const enroll = (await enrollRes.json()) as { id: string; ticket: string };
  const joinRes = await call(
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
  );
  expect(joinRes.status).toBe(200);
  const join = (await joinRes.json()) as { connectToken: string };
  return { service: enroll.id, connectToken: join.connectToken };
}

/** Open the fake agent WS over _connect (the real worker path). */
async function connectAgent(
  service: string,
  box: string,
  ct: string,
): Promise<WebSocket> {
  const res = await call(
    new Request(
      `${BASE}/${service}/${encodeURIComponent(box)}/_connect?ct=${encodeURIComponent(ct)}`,
      { headers: { Upgrade: "websocket", host: HOST } },
    ),
  );
  expect(res.status).toBe(101);
  const agent = res.webSocket!;
  agent.accept();
  return agent;
}

function nextFrame(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (ev: MessageEvent) => resolve(JSON.parse(ev.data as string)),
      { once: true },
    );
  });
}

describe("POST /api/box-update", () => {
  it("rejects without service auth", async () => {
    const res = await call(
      new Request(`${BASE}/api/box-update`, {
        method: "POST",
        headers: { "content-type": "application/json", host: HOST },
        body: JSON.stringify({ service: "x", box: "y" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("400s on missing fields and 404s an unknown box", async () => {
    expect((await api("POST", "/api/box-update", {})).status).toBe(400);
    expect(
      (
        await api("POST", "/api/box-update", {
          service: "no-such-service",
          box: "no-such-box",
        })
      ).status,
    ).toBe(404);
  });

  it("pushes an out-of-band update frame to a LIVE box", async () => {
    const box = `box-upd-${Date.now()}`;
    const { service, connectToken } = await enrollAndJoin(box);
    const agent = await connectAgent(service, box, connectToken);

    const framed = nextFrame(agent);
    const res = await api("POST", "/api/box-update", { service, box });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);

    const frame = await framed;
    expect(frame.type).toBe("update");
    expect(frame.id).toBe("_ctl");
    agent.close();
  });

  it("503s X-Finch-Offline when the box has no live socket", async () => {
    const box = `box-upd-off-${Date.now()}`;
    const { service } = await enrollAndJoin(box); // joined but never connected
    const res = await api("POST", "/api/box-update", { service, box });
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Finch-Offline")).toBe("1");
  });

  it("/_control fails closed (404) without the service secret — a relay-path probe", async () => {
    const box = `box-upd-probe-${Date.now()}`;
    const { service, connectToken } = await enrollAndJoin(box);
    const agent = await connectAgent(service, box, connectToken);

    // Simulate what a public relay client could at most deliver into the DO:
    // the /_control path WITHOUT the secret header (clients can't know it).
    const stub = boxStub(env as any, TENANT, service, box);
    const probe = await stub.fetch(
      `https://box/${service}/${encodeURIComponent(box)}/_control`,
      { method: "POST" },
    );
    expect(probe.status).toBe(404);

    // With the secret it works — the gate is the header, not the path.
    const ok = await stub.fetch(
      `https://box/${service}/${encodeURIComponent(box)}/_control`,
      { method: "POST", headers: { "X-Finch-Service": SERVICE } },
    );
    expect(ok.status).toBe(200);
    agent.close();
  });
});
