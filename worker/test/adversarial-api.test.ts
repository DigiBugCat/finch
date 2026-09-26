import { describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { hashKey, signAssertion, signToken } from "../src/auth";

const BASE = "http://hub.test";
const now = () => Math.floor(Date.now() / 1000);

async function call(
  path: string,
  body: BodyInit | null,
  headers: Record<string, string> = {},
  envOverride: Record<string, unknown> = {},
) {
  const ctx = createExecutionContext();
  return worker.fetch(new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "hub.test", ...headers },
    body,
  }), { ...env, ...envOverride } as any, ctx);
}

async function tenantOp<T>(tenant: string, op: string, args: Record<string, unknown> = {}): Promise<T> {
  const stub = env.TENANT.get(env.TENANT.idFromName(tenant));
  const res = await stub.fetch("https://tenant/op", {
    method: "POST",
    body: JSON.stringify({ op, ...args }),
  });
  return await res.json() as T;
}

/** A request body with NO content-length — the runtime sends it chunked, so the
 *  declared-length pre-gates are all skipped and only a streaming reader can
 *  bound it. `pulled` counts the chunks the Worker actually took: if it stays
 *  far below `chunks`, the reader was cancelled mid-upload rather than the whole
 *  body being materialized into the isolate first. */
function chunkedBody(chunkBytes: number, chunks: number) {
  const chunk = new Uint8Array(chunkBytes).fill(0x61); // "a"
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) {
        controller.close();
        return;
      }
      state.pulled++;
      controller.enqueue(chunk);
    },
  });
  return { body: body as unknown as BodyInit, state };
}

// A chunked body is the only shape that reaches the buffering code: every
// content-length pre-gate is a no-op without the header. The platform accepts
// ~100 MB bodies and an isolate dies past 128 MB, so materializing before the
// check (arrayBuffer()/text()) is a memory-exhaustion lever that takes
// co-resident in-flight requests with it. (security F2 / F5)
describe("unbounded chunked bodies are cut off while streaming, not after", () => {
  it("caps the relay body before it is buffered for failover replay", async () => {
    // hub.test is not a slug host, so resolveTenant falls back to DEFAULT_TENANT;
    // the service must live in THAT tenant for the relay to find it.
    const tenant = env.DEFAULT_TENANT!;
    const { id: service } = await tenantOp<{ id: string }>(tenant, "enroll", {
      name: "Relay Cap",
    });
    await tenantOp(tenant, "registerBox", {
      service, box: "box-1", os: "test", version: "1",
    });
    await tenantOp(tenant, "approve", { id: service });
    // Public: relayMcp's checkKey gate runs BEFORE the body read, so an
    // unauthenticated call would 401 before exercising the cap.
    await tenantOp(tenant, "setAuth", { service, mode: "public" });

    const { body, state } = chunkedBody(256 * 1024, 128); // 32 MiB offered
    const res = await call(`/${service}/box-1/mcp`, body);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body too large" });
    expect(state.pulled).toBeLessThan(24); // 4 MiB cap = 16 chunks, never all 128
  });
});

describe("public credential endpoints fail closed on hostile bodies", () => {
  it.each([
    ["/join", "null", 400],
    ["/join", JSON.stringify({ ticket: {}, box: "box-1" }), 400],
    ["/refresh", "null", 400],
    ["/refresh", JSON.stringify({ refreshToken: {} }), 400],
  ])("%s rejects %s without throwing", async (path, body, status) => {
    expect((await call(path, body)).status).toBe(status);
  });

  it("stops an undeclared oversized body while streaming it", async () => {
    const oversized = JSON.stringify({ ticket: "x".repeat(256 * 1024), box: "b" });
    const res = await call("/join", oversized);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body too large" });
  });

  it("rejects dot-segment box names and overlong UTF-8 metadata before burning a ticket", async () => {
    const secret = env.TICKET_SECRET;
    const ticket = await signToken({
      tenant: env.DEFAULT_TENANT!, service: "svc", kind: "join",
      jti: crypto.randomUUID(), exp: now() + 60,
    }, secret);
    expect((await call("/join", JSON.stringify({ ticket, box: ".." }))).status).toBe(400);
    expect((await call("/join", JSON.stringify({
      ticket, box: "box-1", version: "💥".repeat(65),
    }))).status).toBe(400);
  });

  it("rejects legacy join tickets that have no single-use jti", async () => {
    const ticket = await signToken({
      tenant: env.DEFAULT_TENANT!, service: "svc", kind: "join", exp: now() + 60,
    }, env.TICKET_SECRET);
    expect((await call("/join", JSON.stringify({ ticket, box: "box-1" }))).status).toBe(401);
  });
});

describe("user-scoped routes require a user-scoped assertion", () => {
  it("does not accept a tenant assertion on /api/user/sync", async () => {
    const assertion = await signAssertion({
      tenant: env.DEFAULT_TENANT!, kind: "assertion", exp: now() + 60,
    }, env.FINCH_SERVICE_SECRET);
    const res = await call("/api/user/sync", JSON.stringify({ emails: [] }), {
      "X-Finch-Service": env.FINCH_SERVICE_SECRET,
      "X-Finch-Auth": assertion,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid user assertion" });
  });
});

describe("box-scoped key detach semantics", () => {
  it("API detach removes only the selected box edge and preserves global authorization", async () => {
    const tenant = `tenant-detach-${crypto.randomUUID()}`;
    const { id: service } = await tenantOp<{ id: string }>(tenant, "enroll", { name: "Scraper" });
    await tenantOp(tenant, "registerBox", {
      service, box: "box-1", os: "test", version: "1",
    });
    const minted = await tenantOp<{ plaintext: string; key: { id: string } }>(tenant, "mintKey", {
      label: "shared", scope: { all: true },
    });
    const assertion = await signAssertion({ tenant, exp: now() + 60 }, env.FINCH_SERVICE_SECRET);
    const res = await call("/api/boxes/box-1/keys/revoke", JSON.stringify({
      service, key: minted.key.id,
    }), {
      "X-Finch-Service": env.FINCH_SERVICE_SECRET,
      "X-Finch-Auth": assertion,
    });
    expect(res.status).toBe(200);

    const state = await tenantOp<any>(tenant, "getState");
    expect(state.keys.map((key: any) => key.id)).toContain(minted.key.id);
    const box = state.services.find((item: any) => item.id === service).boxes
      .find((item: any) => item.name === "box-1");
    expect(box.keys).not.toContain(minted.key.id);
    const auth = await tenantOp<{ allowed: boolean }>(tenant, "checkKey", {
      hash: await hashKey(minted.plaintext), service,
    });
    expect(auth.allowed).toBe(true);
  });

  it("API revokes globally only when the service scope is absent", async () => {
    const tenant = `tenant-revoke-${crypto.randomUUID()}`;
    const { id: service } = await tenantOp<{ id: string }>(tenant, "enroll", {
      name: "Printer",
    });
    const minted = await tenantOp<{ plaintext: string; key: { id: string } }>(
      tenant,
      "mintKey",
      { label: "global", scope: { all: true } },
    );
    const assertion = await signAssertion(
      { tenant, exp: now() + 60 },
      env.FINCH_SERVICE_SECRET,
    );
    const headers = {
      "X-Finch-Service": env.FINCH_SERVICE_SECRET,
      "X-Finch-Auth": assertion,
    };

    const partial = await call(
      `/api/boxes/${minted.key.id}/keys/revoke`,
      JSON.stringify({ service: "", key: minted.key.id }),
      headers,
    );
    expect(partial.status).toBe(400);
    expect((await tenantOp<any>(tenant, "getState")).keys)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: minted.key.id })]));

    const revoked = await call(
      `/api/boxes/${minted.key.id}/keys/revoke`,
      JSON.stringify({ key: minted.key.id }),
      headers,
    );
    expect(revoked.status).toBe(200);
    expect((await tenantOp<any>(tenant, "getState")).keys)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: minted.key.id })]));
    expect(await tenantOp(tenant, "checkKey", {
      hash: await hashKey(minted.plaintext),
      service,
    })).toMatchObject({ allowed: false, reason: "no-key" });
  });
});

// The web reaches the hub over the FINCH_HUB service binding with the SAME URL
// it would fetch publicly (`${HUB_URL}/api/...`). A binding request skips DNS,
// zone routes and the edge: it has no Host header unless the caller sets one,
// no CF-Connecting-IP and no request.cf. It must still route to the control API
// exactly like the public request.
describe("requests arriving over the FINCH_HUB service binding", () => {
  function bindingRequest(path: string, headers: Record<string, string>, body = "{}") {
    return new Request(`https://hub.finchmcp.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  }

  it("routes to /api and derives the hub's host from the URL", async () => {
    const assertion = await signAssertion(
      { tenant: env.DEFAULT_TENANT!, kind: "assertion", exp: now() + 60 },
      env.FINCH_SERVICE_SECRET,
    );
    const req = bindingRequest("/api/cli-mint", {
      "X-Finch-Service": env.FINCH_SERVICE_SECRET,
      "X-Finch-Auth": assertion,
    });
    expect(req.headers.has("host")).toBe(false);
    expect(req.headers.has("cf-connecting-ip")).toBe(false);

    const res = await worker.fetch(req, env as any, createExecutionContext());

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // The origin the CLI is told to talk to is the one the web addressed.
    expect(body.hub).toBe("https://hub.finchmcp.com");
    expect(typeof body.token).toBe("string");
  });

  it("still requires the service secret — the binding confers no trust", async () => {
    const res = await worker.fetch(
      bindingRequest("/api/cli-mint", {}),
      env as any,
      createExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it("ignores X-Finch-Client-IP on unauthenticated paths", async () => {
    const keys: string[] = [];
    const JOIN_LIMIT = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };
    await worker.fetch(
      bindingRequest("/api/cli/device/start", { "X-Finch-Client-IP": "198.51.100.9" }),
      { ...env, JOIN_LIMIT } as any,
      createExecutionContext(),
    );
    expect(keys[0]).toBe("devstart:unknown");
  });
});
