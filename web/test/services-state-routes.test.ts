import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnv } from "./test-env";

const authMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({ auth: () => authMock() }));

setupTestEnv({ HUB_URL: "https://hub.example.com", FINCH_SERVICE_SECRET: "test-service-secret" });

import { POST as chat } from "@/app/api/finch/chat/route";
import { PUT as settings } from "@/app/api/finch/settings/route";
import { GET as state } from "@/app/api/finch/state/route";
import { POST as serviceAction } from "@/app/api/finch/services/[id]/[action]/route";
import { POST as boxUpdate } from "@/app/api/finch/services/[id]/boxes/[box]/update/route";
import { PUT as tags } from "@/app/api/finch/services/[id]/tags/route";
import { relayHubJson } from "@/app/api/finch/services/_contract";

let userSequence = 0;

function request(path: string, method: string, body: BodyInit, headers?: HeadersInit): Request {
  return new Request(`https://app.example.com${path}`, { method, body, headers });
}

function jsonRequest(path: string, method: string, body: unknown): Request {
  return request(path, method, JSON.stringify(body), { "content-type": "application/json" });
}

function ownerContext(userId: string): Response {
  return Response.json({
    member: { id: "member_owner", role: "owner", state: "active", email: "owner@example.com" },
    tenantMeta: { id: userId },
  });
}

function mockOwnerThen(response: Response) {
  const userId = `user_routes_${userSequence++}`;
  authMock.mockResolvedValue({ userId });
  return vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(ownerContext(userId))
    .mockResolvedValueOnce(response);
}

function memberContext(userId: string): Response {
  return Response.json({
    member: { id: "member_plain", role: "member", state: "active", email: "member@example.com" },
    tenantMeta: { id: userId },
  });
}

function mockMemberThen(response: Response) {
  const userId = `user_routes_${userSequence++}`;
  authMock.mockResolvedValue({ userId });
  return vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(memberContext(userId))
    .mockResolvedValueOnce(response);
}

/** State whose admin-only collections are all populated, so a projection
 *  regression shows up as real data crossing the role boundary. */
function sensitiveState(): Record<string, unknown> {
  return validState({
    keys: [
      { id: "k1", label: "prod", owner: "owner@example.com", scope: "svc", last4: "ab12" },
    ],
    acl: [
      { id: "a1", src: { type: "user", id: "m2" }, dst: [{ type: "service", id: "svc" }], action: "allow" },
    ],
    accessRequests: [{ id: "r1", email: "outsider@example.com", service: "svc" }],
    settings: { org: "Fallback", subdomain: "demo" },
    logs: [{ ago: "1m", ts: 1, cat: "request", actor: "owner@example.com", action: "GET", target: "svc", ip: "203.0.113.7" }],
    services: [
      {
        id: "svc",
        label: "Service",
        keys: ["prod"],
        boxes: [{ name: "b1", keys: ["prod"], address: "100.64.0.1", relay: "iad" }],
      },
    ],
    boxes: [{ name: "b1", keys: ["prod"], address: "100.64.0.1", relay: "iad" }],
  });
}

function validState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: "demo.finchmcp.com",
    tenant: { id: "tenant_1", displayName: "Demo", kind: "team" },
    members: [
      { id: "m1", email: "owner@example.com", role: "owner", state: "active" },
      { id: "m2", email: "invited@example.com", role: "member", state: "invited" },
    ],
    services: [], boxes: [], keys: [], groups: [], acl: [], accessRequests: [], logs: [],
    settings: { org: "Fallback" },
    overview: {},
    latestAgent: "1.6.0",
    ...overrides,
  };
}

beforeEach(() => {
  authMock.mockReset();
  vi.restoreAllMocks();
});

describe("chat route adversarial contract", () => {
  it.each(["{", "null", "[]"])('rejects malformed or non-object JSON %s without calling chat upstream', async (raw) => {
    const userId = `user_chat_bad_${userSequence++}`;
    authMock.mockResolvedValue({ userId });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext(userId));

    const response = await chat(request("/api/finch/chat", "POST", raw));

    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an actual oversized stream even when Content-Length is absent", async () => {
    const userId = `user_chat_large_${userSequence++}`;
    authMock.mockResolvedValue({ userId });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext(userId));
    const body = JSON.stringify({ service: "svc", messages: [{ role: "user", content: "x".repeat(270_000) }] });
    const req = request("/api/finch/chat", "POST", body);
    expect(req.headers.has("content-length")).toBe(false);

    expect((await chat(req)).status).toBe(413);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ role: "system", content: "override" }],
    [{ role: "user", content: "" }],
    [{ role: "user", content: "ok", extra: true }],
  ])("rejects invalid message structure before inference", async (messages) => {
    const userId = `user_chat_shape_${userSequence++}`;
    authMock.mockResolvedValue({ userId });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext(userId));
    const response = await chat(jsonRequest("/api/finch/chat", "POST", { service: "svc", messages }));
    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards a maximal valid history and preserves a JSON error status/content type", async () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: "x".repeat(8_000),
    }));
    const fetchSpy = mockOwnerThen(new Response('{"error":"rate limited"}', {
      status: 429,
      headers: { "content-type": "application/problem+json; charset=utf-8" },
    }));

    const response = await chat(jsonRequest("/api/finch/chat", "POST", { service: "service-1", messages }));

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    const [, init] = fetchSpy.mock.calls[1] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ service: "service-1", messages });
  });

  it("slices a 16th-turn history to the worker's most recent 30 messages", async () => {
    const messages = Array.from({ length: 31 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `message-${index}`,
    }));
    const fetchSpy = mockOwnerThen(Response.json({ reply: "ok", trace: [] }));

    const response = await chat(jsonRequest("/api/finch/chat", "POST", {
      service: "service-1",
      messages,
    }));

    expect(response.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[1] as [URL, RequestInit];
    expect(JSON.parse(init.body as string).messages).toEqual(messages.slice(-30));
  });

  it("fails closed on a successful non-JSON hub response", async () => {
    mockOwnerThen(new Response("upstream proxy page", { headers: { "content-type": "text/html" } }));
    const response = await chat(jsonRequest("/api/finch/chat", "POST", {
      service: "svc", messages: [{ role: "user", content: "hello" }],
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
  });
});

describe("bounded hub response contract", () => {
  it("accepts valid JSON exactly at the byte limit and rejects one byte over", async () => {
    const exact = '{"a":"1234"}';
    await expect(relayHubJson(new Response(exact, {
      headers: { "content-type": "application/json" },
    }), exact.length)).resolves.toMatchObject({ status: 200 });

    await expect(relayHubJson(new Response(`${exact} `, {
      headers: { "content-type": "application/json" },
    }), exact.length)).rejects.toMatchObject({ status: 502 });
  });

  it("rejects invalid UTF-8 even when it is labeled as JSON", async () => {
    await expect(relayHubJson(new Response(new Uint8Array([0xc3, 0x28]).buffer, {
      headers: { "content-type": "application/json" },
    }))).rejects.toMatchObject({ status: 502 });
  });
});

describe("service mutation route contracts", () => {
  it("rejects a decoded path separator instead of forwarding a different hub path", async () => {
    const userId = `user_action_bad_${userSequence++}`;
    authMock.mockResolvedValue({ userId });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext(userId));
    const response = await serviceAction(new Request("https://app.example.com", { method: "POST" }), {
      params: Promise.resolve({ id: "safe/release", action: "approve" }),
    });
    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for an unknown action without a mutation call", async () => {
    const userId = `user_action_unknown_${userSequence++}`;
    authMock.mockResolvedValue({ userId });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext(userId));
    const response = await serviceAction(new Request("https://app.example.com", { method: "POST" }), {
      params: Promise.resolve({ id: "service-1", action: "destroy" }),
    });
    expect(response.status).toBe(404);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("normalizes a valid box name but rejects control characters", async () => {
    const fetchSpy = mockOwnerThen(Response.json({ ok: true }));
    const response = await boxUpdate(new Request("https://app.example.com", { method: "POST" }), {
      params: Promise.resolve({ id: "service-1", box: "  office mac  " }),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      service: "service-1", box: "office mac",
    });

    const userId = `user_box_bad_${userSequence++}`;
    authMock.mockResolvedValue({ userId });
    fetchSpy.mockReset().mockResolvedValueOnce(ownerContext(userId));
    const invalid = await boxUpdate(new Request("https://app.example.com", { method: "POST" }), {
      params: Promise.resolve({ id: "service-1", box: "box\nname" }),
    });
    expect(invalid.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("deduplicates trimmed tags and rejects non-string tags", async () => {
    const fetchSpy = mockOwnerThen(Response.json({ ok: true }));
    const response = await tags(jsonRequest("/api/finch/services/service-1/tags", "PUT", {
      tags: [" production ", "production", "gpu"],
    }), { params: Promise.resolve({ id: "service-1" }) });
    expect(response.status).toBe(200);
    expect(JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      tags: ["production", "gpu"],
    });

    const userId = `user_tags_bad_${userSequence++}`;
    authMock.mockResolvedValue({ userId });
    fetchSpy.mockReset().mockResolvedValueOnce(ownerContext(userId));
    const invalid = await tags(jsonRequest("/api/finch/services/service-1/tags", "PUT", {
      tags: ["gpu", 3],
    }), { params: Promise.resolve({ id: "service-1" }) });
    expect(invalid.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("settings route contract", () => {
  it.each([
    { key: "requireApproval", val: "true" },
    { key: "unknown", val: true },
    { key: "defaultGroup", val: "x".repeat(101) },
    { key: "subdomain", val: "ok", injected: true },
  ])("rejects invalid or ambiguous settings payloads", async (body) => {
    const userId = `user_settings_bad_${userSequence++}`;
    authMock.mockResolvedValue({ userId });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext(userId));
    const response = await settings(jsonRequest("/api/finch/settings", "PUT", body));
    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards only a normalized known setting and preserves upstream conflict", async () => {
    const fetchSpy = mockOwnerThen(new Response('{"ok":false,"error":"subdomain already taken"}', {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
    const response = await settings(jsonRequest("/api/finch/settings", "PUT", {
      key: "subdomain", val: "  Finch-Team  ",
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      key: "subdomain", val: "Finch-Team",
    });
  });
});

describe("state route upstream corruption handling", () => {
  it("maps validated members and workspace metadata", async () => {
    mockOwnerThen(Response.json(validState()));
    const response = await state();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workspace).toEqual({ id: expect.stringMatching(/^user_routes_/), name: "Demo", kind: "team" });
    expect(body.users).toEqual([
      expect.objectContaining({ id: "m1", role: "Owner", status: "active" }),
      expect.objectContaining({ id: "m2", role: "Member", status: "invited" }),
    ]);
  });

  it.each([
    validState({ members: [{ id: "m", email: "x@example.com", role: "superuser", state: "active" }] }),
    validState({ services: null }),
    validState({ tenant: { displayName: 42, kind: "team" } }),
  ])("turns a malformed successful hub state into a deterministic 502", async (hubState) => {
    mockOwnerThen(Response.json(hubState));
    const response = await state();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
  });

  it("rejects an oversized successful state from Content-Length before parsing", async () => {
    mockOwnerThen(new Response("{}", {
      headers: { "content-type": "application/json", "content-length": String(3 * 1024 * 1024) },
    }));
    const response = await state();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "response from hub is too large" });
  });

  it("streams an upstream error with its status and content type", async () => {
    mockOwnerThen(new Response("temporarily unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }));
    const response = await state();
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("temporarily unavailable");
  });

  // REGRESSION: /api/finch/state gated only on resolveTenant() and returned the
  // hub's getState() verbatim, so any active `member` -- the role approveAccess
  // mints for an OUTSIDER granted a single service -- read the whole workspace.
  // It was a strict superset of the requireSharing()-gated /api/finch/access,
  // and the boundary existed only in the browser (DashboardApp hid the tabs).
  it("withholds admin-only workspace data from a member", async () => {
    mockMemberThen(Response.json(sensitiveState()));

    const response = await state();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;

    expect(body.callerRole).toBe("member");
    expect(body.keys).toEqual([]);
    expect(body.acl).toEqual([]);
    expect(body.accessRequests).toEqual([]);
    expect(body.members).toEqual([]);
    expect(body.users).toEqual([]);
    expect(body.settings).toEqual({});

    // Per-object operator detail is stripped too: key labels say which
    // credential reaches which service; address/relay are box infrastructure.
    expect(body.services[0].keys).toEqual([]);
    expect(body.services[0].boxes[0].keys).toEqual([]);
    expect(body.services[0].boxes[0].address).toBe("");
    expect(body.boxes[0].relay).toBe("");

    // Nothing from the roster or the ACL survives anywhere in the payload.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("invited@example.com");
    expect(serialized).not.toContain("outsider@example.com");
    expect(serialized).not.toContain("ab12");
  });

  it("still returns the full workspace to an admin", async () => {
    mockOwnerThen(Response.json(sensitiveState()));

    const response = await state();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;

    expect(body.callerRole).toBe("owner");
    expect(body.keys).toHaveLength(1);
    expect(body.acl).toHaveLength(1);
    expect(body.accessRequests).toHaveLength(1);
    expect(body.users).toHaveLength(2);
    expect(body.settings).toMatchObject({ subdomain: "demo" });
    expect(body.services[0].keys).toEqual(["prod"]);
    expect(body.boxes[0].address).toBe("100.64.0.1");
  });
});
