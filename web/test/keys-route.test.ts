import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnv } from "./test-env";

const authMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({ auth: () => authMock() }));

setupTestEnv({ HUB_URL: "https://hub.example.com", FINCH_SERVICE_SECRET: "test-service-secret" });

import { POST } from "@/app/api/finch/keys/route";

const ownerContext = () =>
  Response.json({
    member: {
      id: "m_owner",
      role: "owner",
      state: "active",
      email: "owner@example.com",
    },
    tenantMeta: { id: "user_owner" },
  });

function request(body: BodyInit): Request {
  return new Request("https://app.example.com/api/finch/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  authMock.mockReset();
  vi.restoreAllMocks();
});

describe("POST /api/finch/keys", () => {
  it("rejects unauthenticated callers without reading or forwarding the body", async () => {
    authMock.mockResolvedValue({ userId: null });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await POST(request("not even json"));

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a live member before the key mutation", async () => {
    authMock.mockResolvedValue({ userId: "user_member" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        member: { id: "m_member", role: "member", state: "active", email: "m@example.com" },
        tenantMeta: { id: "user_member" },
      }),
    );

    const response = await POST(request(JSON.stringify({ label: "laptop" })));

    expect(response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("normalizes a valid request and forwards it once in the resolved tenant", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockResolvedValueOnce(
        Response.json({
          key: `finch_${"a".repeat(43)}`,
          label: "laptop",
          scope: { services: ["printer", "scraper"] },
        }),
      );

    const response = await POST(
      request(
        JSON.stringify({
          label: " laptop ",
          owner: " owner@example.com ",
          scope: { all: false, services: ["printer", "printer", "scraper"] },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      key: `finch_${"a".repeat(43)}`,
      label: "laptop",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(String(url)).toBe("https://hub.example.com/api/keys");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      label: "laptop",
      owner: "owner@example.com",
      scope: { services: ["printer", "scraper"] },
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["a non-object body", "[]"],
    ["a whitespace-only label", JSON.stringify({ label: "   " })],
    ["a non-string label", JSON.stringify({ label: { toString: "surprise" } })],
    ["a control-character label", JSON.stringify({ label: "audit\nspoof" })],
    ["a label beyond the boundary", JSON.stringify({ label: "x".repeat(101) })],
    ["an empty explicit owner", JSON.stringify({ label: "x", owner: " " })],
    ["an oversized owner", JSON.stringify({ label: "x", owner: "x".repeat(321) })],
    [
      "an ambiguous all-plus-services scope",
      JSON.stringify({ label: "x", scope: { all: true, services: [] } }),
    ],
    [
      "a non-string scoped service",
      JSON.stringify({ label: "x", scope: { services: ["printer", 7] } }),
    ],
    [
      "too many scoped services",
      JSON.stringify({
        label: "x",
        scope: { services: Array.from({ length: 101 }, (_, i) => `service-${i}`) },
      }),
    ],
    ["an unknown field", JSON.stringify({ label: "x", typoScope: { all: true } })],
  ])("returns 400 for %s without mutating the hub", async (_name, body) => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext());

    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("stops an oversized streamed body before forwarding it", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext());
    const oversized = JSON.stringify({ label: "x".repeat(17 * 1024) });

    const response = await POST(request(oversized));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body too large" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves a structured upstream error and its status", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockResolvedValueOnce(
        Response.json({ error: "unknown service id(s): ghost" }, { status: 400 }),
      );

    const response = await POST(
      request(JSON.stringify({ label: "laptop", scope: { services: ["ghost"] } })),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unknown service id(s): ghost" });
  });

  it("turns a malformed successful hub response into a 502", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockResolvedValueOnce(new Response("<html>broken</html>", { status: 200 }));

    const response = await POST(request(JSON.stringify({ label: "laptop" })));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
  });

  it("bounds a structurally valid key response before parsing it", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockResolvedValueOnce(Response.json({
        key: `finch_${"a".repeat(43)}`,
        label: "laptop",
        scope: { services: [] },
        padding: "x".repeat(70 * 1024),
      }));

    const response = await POST(request(JSON.stringify({ label: "laptop" })));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "response from hub is too large" });
  });

  it("rejects a hub success that claims a broader scope than requested", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockResolvedValueOnce(
        Response.json({
          key: `finch_${"a".repeat(43)}`,
          label: "laptop",
          scope: { all: true },
        }),
      );

    const response = await POST(
      request(JSON.stringify({ label: "laptop", scope: { services: ["printer"] } })),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
  });

  it("reports an action-plane network failure as an upstream 502", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockRejectedValueOnce(new TypeError("connection reset"));

    const response = await POST(request(JSON.stringify({ label: "laptop" })));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "hub unavailable" });
  });
});
