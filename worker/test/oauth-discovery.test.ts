// OAuth discovery surface — the documents claude.ai's connector walks before it
// ever presents a token. Pins:
//   1. the 401 WWW-Authenticate challenge (resource_metadata + the scope hint —
//      the client's PRIORITY-1 source for which scopes to request),
//   2. the RFC 9728 protected-resource metadata (incl. scopes_supported, the
//      priority-2 source; without either, claude.ai requests EVERYTHING the AS
//      supports — metadata scopes included — bloating consent + overgranting),
//   3. the AS-metadata proxy's fail-closed path (502 when Clerk is unreachable —
//      this test env's CLERK_ISSUER is a fake origin, and this pool-workers
//      build has no fetchMock, so the proxy's happy path is verified live via
//      curl against staging/prod instead; see the deploy verification notes).
import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import { signAssertion } from "../src/auth";

const SERVICE = env.FINCH_SERVICE_SECRET;
const HOST = "hub.test";
const BASE = `http://${HOST}`;
const ISSUER = env.CLERK_ISSUER!; // "https://clerk.test" (test fixture)

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
      { tenant: env.DEFAULT_TENANT!, exp: nowSec() + 300 },
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

describe("401 WWW-Authenticate challenge", () => {
  it("carries resource_metadata AND the minimal scope hint", async () => {
    // Enroll a key-gated service and connect a live agent (the challenge is
    // emitted by the key gate, which only runs once a healthy box is picked —
    // an offline service 503s upstream of it).
    const enroll = (await (
      await api("POST", "/api/enroll", { name: "Scoped" })
    ).json()) as { id: string; ticket: string };
    const box = `box-scope-${Date.now()}`;
    const join = (await (
      await call(
        new Request(`${BASE}/join`, {
          method: "POST",
          headers: { "content-type": "application/json", host: HOST },
          body: JSON.stringify({
            ticket: enroll.ticket,
            box,
            os: "linux",
            version: "1.0.0",
          }),
        }),
      )
    ).json()) as { connectToken: string };
    const connectRes = await call(
      new Request(
        `${BASE}/${enroll.id}/${encodeURIComponent(box)}/_connect?ct=${encodeURIComponent(join.connectToken)}`,
        { headers: { Upgrade: "websocket", host: HOST } },
      ),
    );
    expect(connectRes.status).toBe(101);
    const agent = connectRes.webSocket!;
    agent.accept();

    // Leave "pending" (requireApproval default) and wait for the BoxDO's
    // async markBox(connected) to land — the healthy pool reads persisted
    // liveness, which can lag the 101 by a tick (same dance as the e2e test).
    await api("POST", `/api/services/${enroll.id}/approve`);
    for (let i = 0; i < 50; i++) {
      const state = (await (await api("GET", "/api/state")).json()) as any;
      const m = state.services
        ?.find((a: any) => a.id === enroll.id)
        ?.boxes?.find((x: any) => x.name === box);
      if (m?.connected) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    const res = await call(
      new Request(`${BASE}/${enroll.id}/mcp`, {
        method: "POST",
        headers: { host: HOST, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    const chal = res.headers.get("www-authenticate") || "";
    expect(chal).toContain(
      `/.well-known/oauth-protected-resource/${enroll.id}/mcp"`,
    );
    // The scope hint is the client's priority-1 source — identity only.
    expect(chal).toContain(`scope="openid offline_access"`);
    agent.close();
  });
});

describe("RFC 9728 protected-resource metadata", () => {
  it("serves resource, AS pointer, bearer methods, and minimal scopes_supported", async () => {
    const res = await call(
      new Request(`${BASE}/.well-known/oauth-protected-resource/svc/mcp`, {
        headers: { host: HOST },
      }),
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as any;
    expect(doc.resource).toBe(`https://${HOST}/svc/mcp`);
    expect(doc.authorization_servers).toEqual([ISSUER]);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
    expect(doc.scopes_supported).toEqual(["openid", "offline_access"]);
  });
});

describe("AS metadata proxy on the resource origin", () => {
  for (const spelling of [
    "oauth-authorization-server",
    "openid-configuration",
  ]) {
    it(`fails closed (502) at /.well-known/${spelling} when the upstream AS is unreachable`, async () => {
      // CLERK_ISSUER is a fake origin here, so the upstream metadata fetch
      // cannot succeed — the proxy must answer 502, never a relay fallthrough
      // (the pre-v1.5.6 behavior was a confusing 503 from the relay plane).
      const res = await call(
        new Request(`${BASE}/.well-known/${spelling}`, {
          headers: { host: HOST },
        }),
      );
      expect(res.status).toBe(502);
    });
  }
});
