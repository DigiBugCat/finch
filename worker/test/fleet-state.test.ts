// GET /api/state is what the web's signed-in /fleet page renders. Two fields
// exist for it and are pinned here:
//   - serviceBase: the origin callers reach this tenant's services on (the same
//     value /api/cli/state gives `finch fleet`), so the page prints the public
//     URL the CLI prints instead of guessing one from the stored host.
//   - boxes[].online: the hub's one liveness rule (a live relay socket AND
//     approved). The page shows it as is and never re-derives it.
import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import { signAssertion } from "../src/auth";

const SERVICE = env.FINCH_SERVICE_SECRET;
const TENANT = env.DEFAULT_TENANT!;
const HOST = "hub.test";
const BASE = `http://${HOST}`;

const nowSec = () => Math.floor(Date.now() / 1000);

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function api(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    "X-Finch-Service": SERVICE,
    "X-Finch-Auth": await signAssertion(
      { tenant: TENANT, exp: nowSec() + 300 },
      SERVICE,
    ),
    host: HOST,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return call(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}

async function state(): Promise<any> {
  const res = await api("GET", "/api/state");
  expect(res.status).toBe(200);
  return res.json();
}

async function boxIn(service: string, box: string): Promise<any> {
  const s = await state();
  return s.services
    ?.find((a: any) => a.id === service)
    ?.boxes?.find((m: any) => m.name === box);
}

async function waitFor(pred: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("condition never held");
}

describe("GET /api/state for the /fleet page", () => {
  it("names the origin the tenant's services answer on", async () => {
    const s = await state();
    // Test env runs DEV=1, where the only reachable host is the inbound one;
    // a non-loopback host is always https.
    expect(s.serviceBase).toBe(`https://${HOST}`);
  });

  it("reports a box online only while it holds a socket and is approved", async () => {
    const enroll = (await (
      await api("POST", "/api/enroll", { name: `fleet ${Date.now()}` })
    ).json()) as { id: string; ticket: string };
    const box = `fleet-box-${Date.now()}`;
    const joinRes = await call(
      new Request(`${BASE}/join`, {
        method: "POST",
        headers: { "content-type": "application/json", host: HOST },
        body: JSON.stringify({
          ticket: enroll.ticket,
          box,
          os: "darwin",
          version: "1.0.0",
        }),
      }),
    );
    expect(joinRes.status).toBe(200);
    const join = (await joinRes.json()) as { connectToken: string };

    // Joined but never connected: offline.
    expect((await boxIn(enroll.id, box))?.online).toBe(false);

    const connectRes = await call(
      new Request(
        `${BASE}/${enroll.id}/${encodeURIComponent(box)}/_connect?ct=${encodeURIComponent(join.connectToken)}`,
        { headers: { Upgrade: "websocket", host: HOST } },
      ),
    );
    expect(connectRes.status).toBe(101);
    const agent = connectRes.webSocket!;
    agent.accept();

    // Connected but still pending approval: not online (the load balancer
    // would not route to it either).
    await waitFor(async () => !!(await boxIn(enroll.id, box))?.connected);
    const pending = await boxIn(enroll.id, box);
    expect(pending.state).toBe("pending");
    expect(pending.online).toBe(false);

    expect((await api("POST", `/api/services/${enroll.id}/approve`)).status).toBe(200);
    await waitFor(async () => (await boxIn(enroll.id, box))?.online === true);

    const live = await boxIn(enroll.id, box);
    expect(live.online).toBe(true);
    // An old agent is flagged for the page's update hint.
    expect(live.outdated).toBe(true);
    expect(live.version).toBe("1.0.0");

    agent.close(1000, "bye");
    await waitFor(async () => (await boxIn(enroll.id, box))?.online === false);
  });
});
