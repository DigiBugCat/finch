// MCP 2026-07-28 through the hub relay, driven through the REAL worker entry
// (worker.fetch) with a fake agent on the box socket. The relay is MCP-unaware
// by design — these tests pin that it stays a faithful byte tunnel for the
// parts of the new revision that live in HTTP rather than the body:
//   1. Mcp-Name / Mcp-Param-* / unknown Mcp-* headers reach the box
//      byte-for-byte even when a value contains "finch_" (the old value-based
//      credential scrub deleted them → upstream 400 -32020), while every header
//      the hub accepts a credential in is still stripped.
//   2. GET and DELETE pass through with method and headers intact.
//   3. The 401 challenge's resource_metadata names the metadata document for
//      the URL the client actually requested, and that document's `resource`
//      equals it (pinned /<svc>/<box>/mcp and non-/mcp routes included).
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

async function call(req: Request, e: unknown = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, e as any, ctx);
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

function nextFrame(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (ev: MessageEvent) => resolve(JSON.parse(ev.data as string)),
      { once: true },
    );
  });
}

let seq = 0;

/** Enroll a key-gated service, join + connect a fake agent, approve it, wait
 *  for liveness, and mint a working finch_ key. */
async function liveService(label: string) {
  const enroll = (await (
    await api("POST", "/api/enroll", { name: `MCP ${label}` })
  ).json()) as { id: string; ticket: string };
  // A space in the box name exercises the percent-encoded pinned path.
  const box = `box ${label} ${Date.now()} ${seq++}`;
  const joinRes = await call(
    new Request(`${BASE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json", host: HOST },
      body: JSON.stringify({
        ticket: enroll.ticket,
        box,
        os: "linux",
        version: "1.6.0",
      }),
    }),
  );
  expect(joinRes.status).toBe(200);
  const join = (await joinRes.json()) as { connectToken: string };
  const connectRes = await call(
    new Request(
      `${BASE}/${enroll.id}/${encodeURIComponent(box)}/_connect?ct=${encodeURIComponent(join.connectToken)}`,
      { headers: { Upgrade: "websocket", host: HOST } },
    ),
  );
  expect(connectRes.status).toBe(101);
  const agent = connectRes.webSocket!;
  agent.accept();
  expect((await api("POST", `/api/services/${enroll.id}/approve`)).status).toBe(200);
  let live = false;
  for (let i = 0; i < 50 && !live; i++) {
    const state = (await (await api("GET", "/api/state")).json()) as any;
    const m = state.services
      ?.find((a: any) => a.id === enroll.id)
      ?.boxes?.find((x: any) => x.name === box);
    live = !!m?.connected && m.state !== "pending";
    if (!live) await new Promise((r) => setTimeout(r, 0));
  }
  expect(live).toBe(true);
  const minted = (await (
    await api("POST", "/api/keys", {
      label: `mcp-${label}`,
      scope: { all: true },
      owner: "you",
    })
  ).json()) as { key: string };
  expect(minted.key).toMatch(/^finch_/);
  return { service: enroll.id, box, agent, key: minted.key };
}

/** Pull `name="value"` out of a WWW-Authenticate challenge. */
function challengeParam(chal: string, name: string): string | undefined {
  return chal.match(new RegExp(`(?:^|[\\s,])${name}="([^"]*)"`))?.[1];
}

describe("relay header fidelity (MCP 2026-07-28)", () => {
  it("forwards Mcp-* headers containing finch_ untouched while stripping every credential header", async () => {
    const { service, agent, key } = await liveService("hdr");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "finch_search", arguments: { query: "finch_widgets" } },
    });
    const reqSeen = nextFrame(agent);
    const resP = call(
      new Request(`${BASE}/${service}/mcp`, {
        method: "POST",
        headers: {
          host: HOST,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${key}`,
          "proxy-authorization": `Bearer ${key}`,
          "x-finch-anything": key,
          "x-finch-service": SERVICE,
          cookie: `__Host-finch_session=stale; finch_session=legacy; app_sid=finch_app_cookie`,
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "finch_search",
          "mcp-param-query": "finch_widgets",
          "mcp-param-note": "=?base64?ZmluY2hf?=",
          "mcp-some-future-header": "finch_future value",
        },
        body,
      }),
    );
    const req = await reqSeen;
    const h = req.headers as Record<string, string>;
    // Credentials: gone, and the key appears nowhere in what the box receives.
    expect(h.authorization).toBeUndefined();
    expect(h["proxy-authorization"]).toBeUndefined();
    expect(h["x-finch-anything"]).toBeUndefined();
    expect(h["x-finch-service"]).toBeUndefined();
    expect(JSON.stringify(req)).not.toContain(key);
    expect(JSON.stringify(req)).not.toContain(SERVICE);
    // Only the login-wall cookies are removed; the app's own cookie survives
    // even though its value contains finch_.
    expect(h.cookie).toBe("app_sid=finch_app_cookie");
    // MCP headers: byte-identical, known and unknown alike.
    expect(h["mcp-protocol-version"]).toBe("2026-07-28");
    expect(h["mcp-method"]).toBe("tools/call");
    expect(h["mcp-name"]).toBe("finch_search");
    expect(h["mcp-param-query"]).toBe("finch_widgets");
    expect(h["mcp-param-note"]).toBe("=?base64?ZmluY2hf?=");
    expect(h["mcp-some-future-header"]).toBe("finch_future value");
    expect(h.accept).toBe("application/json, text/event-stream");
    expect(req.method).toBe("POST");
    expect(req.body).toBe(body);

    agent.send(JSON.stringify({ id: req.id, type: "err", status: 502, message: "done" }));
    expect((await resP).status).toBe(502);
    agent.close();
  });

  it("strips a finch_ key in Authorization whatever the scheme casing", async () => {
    const { service, agent, key } = await liveService("case");
    const reqSeen = nextFrame(agent);
    const resP = call(
      new Request(`${BASE}/${service}/mcp`, {
        method: "POST",
        headers: { host: HOST, Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: "{}",
      }),
    );
    const req = await reqSeen;
    expect(Object.keys(req.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(JSON.stringify(req)).not.toContain(key);
    agent.send(JSON.stringify({ id: req.id, type: "err", status: 502, message: "done" }));
    await resP;
    agent.close();
  });

  for (const method of ["GET", "DELETE"] as const) {
    it(`passes ${method} and its Mcp-* headers through unmodified`, async () => {
      const { service, agent, key } = await liveService(method.toLowerCase());
      const reqSeen = nextFrame(agent);
      const resP = call(
        new Request(`${BASE}/${service}/mcp?x=1`, {
          method,
          headers: {
            host: HOST,
            authorization: `Bearer ${key}`,
            accept: "text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-session-id": "sess-finch_1",
            "mcp-unknown-extension": "finch_ext",
          },
        }),
      );
      const req = await reqSeen;
      expect(req.method).toBe(method);
      expect(req.path).toBe("/mcp?x=1");
      expect(req.body).toBe("");
      expect(req.headers["mcp-protocol-version"]).toBe("2026-07-28");
      expect(req.headers["mcp-session-id"]).toBe("sess-finch_1");
      expect(req.headers["mcp-unknown-extension"]).toBe("finch_ext");
      expect(req.headers.authorization).toBeUndefined();

      if (method === "GET") {
        agent.send(JSON.stringify({
          id: req.id,
          type: "head",
          status: 200,
          headers: [["content-type", "text/event-stream"], ["mcp-future-response", "finch_r"]],
        }));
        agent.send(JSON.stringify({ id: req.id, type: "chunk", data: btoa(": hi\n\n") }));
        agent.send(JSON.stringify({ id: req.id, type: "end" }));
        const res = await resP;
        expect(res.status).toBe(200);
        expect(res.headers.get("mcp-future-response")).toBe("finch_r");
        expect(await res.text()).toBe(": hi\n\n");
      } else {
        agent.send(JSON.stringify({ id: req.id, type: "head", status: 204, headers: [] }));
        expect((await resP).status).toBe(204);
      }
      agent.close();
    });
  }
});

describe("401 resource_metadata matches the requested resource (RFC 9728 §3.3)", () => {
  async function challengeFor(path: string) {
    const res = await call(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { host: HOST, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    const chal = res.headers.get("www-authenticate") || "";
    const metadataUrl = challengeParam(chal, "resource_metadata");
    expect(metadataUrl).toBeTruthy();
    // Follow the pointer exactly as a client would and read `resource`.
    const u = new URL(metadataUrl!);
    const doc = (await (
      await call(new Request(`${BASE}${u.pathname}`, { headers: { host: u.host } }))
    ).json()) as { resource: string };
    return { chal, metadataUrl: metadataUrl!, resource: doc.resource };
  }

  it("pinned /<svc>/<box>/mcp (percent-encoded box)", async () => {
    const { service, box, agent } = await liveService("pin");
    const path = `/${service}/${encodeURIComponent(box)}/mcp`;
    expect(path).toContain("%20");
    const { metadataUrl, resource } = await challengeFor(path);
    expect(metadataUrl).toBe(`https://${HOST}/.well-known/oauth-protected-resource${path}`);
    expect(resource).toBe(`https://${HOST}${path}`);
    agent.close();
  });

  it("unpinned /<svc>/mcp", async () => {
    const { service, agent } = await liveService("lb");
    const { metadataUrl, resource } = await challengeFor(`/${service}/mcp`);
    expect(metadataUrl).toBe(`https://${HOST}/.well-known/oauth-protected-resource/${service}/mcp`);
    expect(resource).toBe(`https://${HOST}/${service}/mcp`);
    agent.close();
  });

  it("a non-/mcp route", async () => {
    const { service, agent } = await liveService("route");
    const { resource } = await challengeFor(`/${service}/api/v1/things`);
    expect(resource).toBe(`https://${HOST}/${service}/api/v1/things`);
    agent.close();
  });
});
