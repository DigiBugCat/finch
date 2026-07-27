import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnv } from "./test-env";

const authMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({ auth: () => authMock() }));

setupTestEnv({ HUB_URL: "https://hub.example.com", FINCH_SERVICE_SECRET: "test-service-secret" });

import { GET as connect } from "@/app/api/finch/connect/route";
import { POST as enroll } from "@/app/api/finch/enroll/route";

const FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

const memberContext = (role: "owner" | "admin" | "member" = "owner") =>
  Response.json({
    member: { id: `m_${role}`, role, state: "active", email: `${role}@example.com` },
    tenantMeta: { id: "user_test" },
  });

const enrollment = () =>
  Response.json({
    id: "office-printer",
    ticket: "signed-ticket",
    url: "https://office.example.com/office-printer/mcp",
    install: "finch join --ticket signed-ticket",
    expiresAt: FUTURE_EXPIRY,
  });

function request(body: BodyInit, headers?: HeadersInit): Request {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  const req = new Request("https://app.example.com/api/finch/enroll", {
    method: "POST",
    headers: requestHeaders,
    body,
  });
  // happy-dom drops the browser-forbidden Content-Length header, although the
  // server runtime supplies it. Restore it so this route's preflight is tested.
  if (requestHeaders.has("content-length") && !req.headers.has("content-length")) {
    Object.defineProperty(req, "headers", { value: requestHeaders });
  }
  return req;
}

beforeEach(() => {
  authMock.mockReset();
  vi.restoreAllMocks();
});

describe("GET /api/finch/connect", () => {
  it("requires an authenticated active member before returning the command", async () => {
    authMock.mockResolvedValue({ userId: null });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await connect();

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows a non-admin member and returns the normalized configured hub origin", async () => {
    authMock.mockResolvedValue({ userId: "user_member" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(memberContext("member"));

    const response = await connect();

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({
      hub: "https://hub.example.com",
      command:
        "curl -fsSL https://hub.example.com/install | sh && finch login --hub https://hub.example.com",
    });
  });

  it("fails closed when the membership response is malformed", async () => {
    authMock.mockResolvedValue({ userId: "user_member" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(null));

    const response = await connect();

    expect(response.status).toBe(502);
  });
});

describe("POST /api/finch/enroll", () => {
  it("rejects an unauthenticated caller before reading or forwarding its body", async () => {
    authMock.mockResolvedValue({ userId: null });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await enroll(request("not json"));

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a live non-admin member before creating a service", async () => {
    authMock.mockResolvedValue({ userId: "user_member" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(memberContext("member"));

    const response = await enroll(request(JSON.stringify({ name: "printer" })));

    expect(response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("normalizes the supported fields and performs exactly one enrollment", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(enrollment());

    const response = await enroll(
      request(JSON.stringify({ name: "  Office printer  ", group: "  Operations  " })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "office-printer", ticket: "signed-ticket" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1] as [URL, RequestInit];
    expect(url.toString()).toBe("https://hub.example.com/api/enroll");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Office printer",
      group: "Operations",
    });
  });

  it("accepts name and group values exactly at their character limits", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(enrollment());
    const boundary = "x".repeat(100);

    const response = await enroll(
      request(JSON.stringify({ name: boundary, group: boundary })),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[1] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ name: boundary, group: boundary });
  });

  it("accepts a canonical 63-character service id returned by the hub", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    const id = `a${"b".repeat(62)}`;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(Response.json({
        ...(await enrollment().json()),
        id,
      }));

    const response = await enroll(request(JSON.stringify({ name: "display name" })));
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe(id);
  });

  it.each(["null", "[]", '"printer"', "7", "true", "{", ""]) (
    "rejects malformed or non-object JSON %j without enrolling",
    async (body) => {
      authMock.mockResolvedValue({ userId: "user_owner" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(memberContext());

      const response = await enroll(request(body));

      expect(response.status).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["a missing name", {}],
    ["a non-string name", { name: { toString: "printer" } }],
    ["an empty name", { name: "   " }],
    ["a non-string group", { name: "printer", group: 7 }],
    ["control characters", { name: "printer\nadmin" }],
    ["an unknown field", { name: "printer", tenant: "attacker" }],
    ["a too-long name", { name: "x".repeat(101) }],
    ["a too-long group", { name: "printer", group: "x".repeat(101) }],
  ])("rejects %s without enrolling", async (_case, body) => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(memberContext());

    const response = await enroll(request(JSON.stringify(body)));

    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("stops an oversized streamed body before forwarding it", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(memberContext());

    const response = await enroll(request(JSON.stringify({ name: "x".repeat(5 * 1024) })));

    expect(response.status, await response.clone().text()).toBe(413);
    expect(await response.json()).toEqual({ error: "request body too large" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an advertised oversize before consuming the body", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(memberContext());

    const response = await enroll(request("{}", { "content-length": "4097" }));

    expect(response.status, await response.clone().text()).toBe(413);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves a structured hub error and its status", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(Response.json({ error: "service limit reached" }, { status: 409 }));

    const response = await enroll(request(JSON.stringify({ name: "printer" })));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "service limit reached" });
  });

  it("preserves an upstream error status but sanitizes its malformed body", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(new Response("<html>overloaded</html>", { status: 503 }));

    const response = await enroll(request(JSON.stringify({ name: "printer" })));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "hub request failed" });
  });

  it.each([
    ["non-JSON", new Response("<html>broken</html>", { status: 200 })],
    ["a primitive", Response.json("ticket", { status: 200 })],
    ["missing ticket data", Response.json({ id: "printer" }, { status: 200 })],
    ["a path-like service id", Response.json({
      id: "../printer",
      ticket: "ticket",
      url: "https://hub.example.com/printer/mcp",
      install: "finch join",
      expiresAt: FUTURE_EXPIRY,
    })],
    ["a 64-character service id", Response.json({
      id: `a${"b".repeat(63)}`,
      ticket: "ticket",
      url: "https://hub.example.com/printer/mcp",
      install: "finch join",
      expiresAt: FUTURE_EXPIRY,
    })],
    ["an expired ticket", Response.json({
      id: "printer",
      ticket: "ticket",
      url: "https://hub.example.com/printer/mcp",
      install: "finch join",
      expiresAt: 1,
    })],
    ["a fractional expiry", Response.json({
      id: "printer",
      ticket: "ticket",
      url: "https://hub.example.com/printer/mcp",
      install: "finch join",
      expiresAt: 1.5,
    })],
  ])("returns 502 for %s in a successful hub response", async (_case, hubResponse) => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(hubResponse);

    const response = await enroll(request(JSON.stringify({ name: "printer" })));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
  });

  it("reports an action-plane network failure as an upstream error", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockRejectedValueOnce(new TypeError("connection reset"));

    const response = await enroll(request(JSON.stringify({ name: "printer" })));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "hub unavailable" });
  });
});
