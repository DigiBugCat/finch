// OAuth discovery surface — the documents claude.ai's connector walks before it
// ever presents a token. Pins:
//   1. the 401 WWW-Authenticate challenge (resource_metadata + the scope hint —
//      the client's PRIORITY-1 source for which scopes to request),
//   2. the RFC 9728 protected-resource metadata (incl. scopes_supported, the
//      priority-2 source; without either, claude.ai requests EVERYTHING the AS
//      supports — metadata scopes included — bloating consent + overgranting),
//   3. that the AS pointer names Clerk ITSELF and the hub serves no AS metadata
//      or /register of its own. Clerk stamps its own issuer on the
//      authorization response (RFC 9207 `iss`); a hub-hosted AS doc with a
//      different `issuer` made current MCP SDKs abort every flow with an
//      issuer mismatch.
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

const nowSec = () => Math.floor(Date.now() / 1000);

async function call(
  req: Request,
  envOverride: Record<string, unknown> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, ...envOverride } as any, ctx);
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
    // The scope hint is the client's priority-1 source — identity only, and
    // never offline_access (MCP auth spec: servers SHOULD NOT include it).
    expect(chal).toContain(`scope="openid email"`);
    expect(chal).not.toContain("offline_access");
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
    // The AS pointer is Clerk's issuer, byte for byte. The client validates
    // Clerk's metadata `issuer` against this value (RFC 8414 §3.3) and then
    // the authorization response's `iss` against that metadata (RFC 9207);
    // pointing anywhere else is what broke the flow.
    expect(doc.authorization_servers).toEqual([env.CLERK_ISSUER]);
    expect(doc.authorization_servers).not.toContain(`https://${HOST}`);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
    expect(doc.scopes_supported).toEqual(["openid", "email"]);
  });

  it("strips a trailing slash so the pointer equals Clerk's issuer", async () => {
    // Clerk's metadata says "issuer": "https://clerk.finchmcp.com" (no slash).
    // A configured "https://…/" must not leak through as a different string.
    const res = await call(
      new Request(`${BASE}/.well-known/oauth-protected-resource/svc/mcp`, {
        headers: { host: HOST },
      }),
      { CLERK_ISSUER: "https://clerk.example.test/" },
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as any;
    expect(doc.authorization_servers).toEqual(["https://clerk.example.test"]);
  });
});

describe("no hub-hosted authorization server", () => {
  for (const spelling of [
    "oauth-authorization-server",
    "openid-configuration",
  ]) {
    it(`serves no AS metadata at /.well-known/${spelling}`, async () => {
      // The hub used to serve Clerk's doc here with `issuer` rewritten to the
      // hub host — which Clerk's `iss` could never match. Now the path is not
      // ours: it falls through to the relay plane and must end in a 4xx (MCP
      // SDKs skip a 4xx discovery candidate but abort on a 5xx), and in
      // particular must never be a 200 claiming an issuer other than Clerk's.
      const res = await call(
        new Request(`${BASE}/.well-known/${spelling}`, {
          headers: { host: HOST, accept: "application/json" },
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  }

  it("does not proxy POST /register to Clerk", async () => {
    // Clients register at Clerk's own registration_endpoint now. The old
    // proxy forwarded to CLERK_ISSUER (a dead origin in this env), so a
    // regression would surface as a 5xx from the failed upstream fetch.
    const res = await call(
      new Request(`${BASE}/register`, {
        method: "POST",
        headers: { host: HOST, "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://client.test/cb"] }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
