import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker, { hostKeyFromHost } from "../src/index";
import { signAssertion, signSession } from "../src/auth";

const SERVICE = env.FINCH_SERVICE_SECRET;
const SESSION = env.SESSION_SECRET;

const nowSec = () => Math.floor(Date.now() / 1000);
let seq = 0;

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function assertion(tenant: string): Promise<string> {
  return signAssertion({ tenant, exp: nowSec() + 300 }, SERVICE);
}

async function api(
  tenant: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    "X-Finch-Service": SERVICE,
    "X-Finch-Auth": await assertion(tenant),
    host: "finchmcp.com",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return call(
    new Request(`https://finchmcp.com${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}

async function router(body: Record<string, unknown>): Promise<any> {
  const stub = env.ROUTER.get(env.ROUTER.idFromName("global"));
  const res = await stub.fetch("https://router/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function freshApplianceOnHost(host: string, tenant: string) {
  expect((await router({ op: "register", slug: host, tenant })).ok).toBe(true);
  const enroll = (await (
    await api(tenant, "POST", "/api/enroll", { name: `Host Box ${seq++}` })
  ).json()) as { id: string; ticket: string };
  const base = `https://${host}`;
  const machine = `box-${Date.now()}-${seq++}`;
  const join = (await (
    await call(
      new Request(`${base}/join`, {
        method: "POST",
        headers: { "content-type": "application/json", host },
        body: JSON.stringify({ ticket: enroll.ticket, machine }),
      }),
    )
  ).json()) as { connectToken: string };
  const connectRes = await call(
    new Request(
      `${base}/${enroll.id}/${encodeURIComponent(machine)}/_connect?ct=${encodeURIComponent(join.connectToken)}`,
      { headers: { Upgrade: "websocket", host } },
    ),
  );
  expect(connectRes.status).toBe(101);
  const agent = connectRes.webSocket!;
  agent.accept();
  await waitForMachine(tenant, enroll.id, machine, (m) => m.connected);
  await api(
    tenant,
    "POST",
    `/api/appliances/${encodeURIComponent(enroll.id)}/approve`,
  );
  await api(tenant, "PUT", `/api/appliances/${encodeURIComponent(enroll.id)}/auth`, {
    mode: "public",
  });
  await waitForMachine(
    tenant,
    enroll.id,
    machine,
    (m) => m.connected && m.state !== "pending",
  );
  return { base, host, tenant, appliance: enroll.id, agent };
}

async function waitForMachine(
  tenant: string,
  appliance: string,
  machine: string,
  pred: (m: any) => boolean,
  tries = 50,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const res = await api(tenant, "GET", "/api/state");
    const state = (await res.json()) as any;
    const ap = (state.appliances ?? []).find((a: any) => a.id === appliance);
    const m = ap?.machines?.find((x: any) => x.name === machine);
    if (m && pred(m)) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`machine ${appliance}/${machine} never satisfied predicate`);
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

function reply200(agent: WebSocket, id: string): void {
  agent.send(JSON.stringify({ id, type: "head", status: 200, headers: [] }));
  agent.send(JSON.stringify({ id, type: "chunk", data: btoa("ok") }));
  agent.send(JSON.stringify({ id, type: "end" }));
}

describe("hostKeyFromHost", () => {
  it("extracts legacy slugs and custom host keys", () => {
    expect(hostKeyFromHost("Pelican.finchmcp.com")).toBe("pelican");
    expect(hostKeyFromHost("finchmcp.com")).toBe("");
    expect(hostKeyFromHost("www.finchmcp.com")).toBe("");
    expect(hostKeyFromHost("x.workers.dev")).toBe("");
    expect(hostKeyFromHost("localhost:8787")).toBe("");
    expect(hostKeyFromHost("127.0.0.1:8787")).toBe("");
    expect(hostKeyFromHost("[::1]:8787")).toBe("");
    expect(hostKeyFromHost("singlelabel")).toBe("");
    expect(hostKeyFromHost("mcp.acme.com:443")).toBe("mcp.acme.com");
    expect(hostKeyFromHost("pelican.aviary.run")).toBe("pelican.aviary.run");
  });
});

describe("RouterDO host-key validation", () => {
  it("validates custom hostnames, ownership, unregister, and tenant listing", async () => {
    const tenant = `tenant_router_${Date.now()}_${seq++}`;
    expect((await router({ op: "register", slug: "evil.finchmcp.com", tenant })).reason).toBe("bad-input");
    expect((await router({ op: "register", slug: "-bad.acme.com", tenant })).reason).toBe("bad-input");
    expect((await router({ op: "register", slug: `${"a".repeat(250)}.com`, tenant })).reason).toBe("bad-input");
    expect((await router({ op: "register", slug: "mcp.acme.com", tenant })).ok).toBe(true);
    expect((await router({ op: "register", slug: "mcp.acme.com", tenant: "other" })).reason).toBe("collision");
    expect((await router({ op: "unregister", slug: "mcp.acme.com", tenant: "other" })).reason).toBe("not-owner");
    expect((await router({ op: "listForTenant", tenant })).keys).toContain("mcp.acme.com");
    expect((await router({ op: "unregister", slug: "mcp.acme.com", tenant })).ok).toBe(true);
  });
});

describe("custom hostname API", () => {
  it("gates vanity suffixes to VANITY_TENANT and supports list/delete", async () => {
    const bad = await api("tenant_not_vanity", "POST", "/api/hostnames", {
      hostname: "pelican.aviary.run",
    });
    expect(bad.status).toBe(403);

    const good = await api("tenant_vanity", "POST", "/api/hostnames", {
      hostname: "pelican.aviary.run",
    });
    expect(good.status).toBe(200);
    expect((await good.json()) as any).toMatchObject({
      ok: true,
      hostname: "pelican.aviary.run",
      tier: "vanity",
    });
    const list = await api("tenant_vanity", "GET", "/api/hostnames");
    expect(((await list.json()) as any).hostnames).toContain("pelican.aviary.run");
    const del = await api("tenant_vanity", "DELETE", "/api/hostnames", {
      hostname: "pelican.aviary.run",
    });
    expect(del.status).toBe(200);
  });

  it("supports BYO register/list/delete without CF creds and rejects collisions", async () => {
    const tenant = `tenant_byo_${Date.now()}_${seq++}`;
    const add = await api(tenant, "POST", "/api/hostnames", {
      hostname: "mcp.acme.com",
    });
    expect(add.status).toBe(200);
    const added = (await add.json()) as any;
    expect(added.tier).toBe("byo");
    expect(added.instructions).toBe("CNAME mcp.acme.com -> finchmcp.com");
    expect(added.ssl).toBeUndefined();

    const collision = await api("tenant_collision", "POST", "/api/hostnames", {
      hostname: "mcp.acme.com",
    });
    expect(collision.status).toBe(409);
    const list = await api(tenant, "GET", "/api/hostnames");
    expect(((await list.json()) as any).hostnames).toContain("mcp.acme.com");
    const del = await api(tenant, "DELETE", "/api/hostnames", {
      hostname: "mcp.acme.com",
    });
    expect(del.status).toBe(200);
  });
});

describe("relay and login wall on custom hostnames", () => {
  it("resolves a registered custom hostname end to end", async () => {
    const ctx = await freshApplianceOnHost(
      `relay-${Date.now()}-${seq++}.acme.com`,
      `tenant_relay_${Date.now()}_${seq++}`,
    );
    const seen = nextFrame(ctx.agent);
    const relay = call(
      new Request(`${ctx.base}/${ctx.appliance}/mcp`, {
        headers: { host: ctx.host },
      }),
    );
    const frame = await seen;
    expect(frame.type).toBe("req");
    reply200(ctx.agent, frame.id);
    expect((await relay).status).toBe(200);
    ctx.agent.close(1000, "done");
  });

  it("binds login-wall sessions to the full custom-host host key", async () => {
    const host = `wall-${Date.now()}-${seq++}.acme.com`;
    const ctx = await freshApplianceOnHost(host, `tenant_wall_custom_${Date.now()}_${seq++}`);
    await api(ctx.tenant, "PUT", `/api/appliances/${encodeURIComponent(ctx.appliance)}/auth`, {
      mode: "key",
    });
    const cookie = await signSession(
      {
        kind: "session",
        tenant: ctx.tenant,
        slug: host,
        userId: "user_123",
        epoch: 0,
        exp: nowSec() + 3600,
      } as any,
      SESSION,
    );
    const goodSeen = nextFrame(ctx.agent);
    const good = call(
      new Request(`${ctx.base}/${ctx.appliance}/index.html`, {
        headers: { host, cookie: `finch_session=${cookie}` },
      }),
    );
    reply200(ctx.agent, (await goodSeen).id);
    expect((await good).status).toBe(200);

    const otherHost = `other-${Date.now()}-${seq++}.acme.com`;
    expect((await router({ op: "register", slug: otherHost, tenant: ctx.tenant })).ok).toBe(true);
    const bad = await call(
      new Request(`https://${otherHost}/${ctx.appliance}/index.html`, {
        headers: { host: otherHost, cookie: `finch_session=${cookie}` },
        redirect: "manual",
      }),
    );
    expect(bad.status).toBe(302);
    ctx.agent.close(1000, "done");
  });
});
