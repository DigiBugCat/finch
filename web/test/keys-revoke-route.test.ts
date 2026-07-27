import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnv } from "./test-env";

const authMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({ auth: () => authMock() }));

setupTestEnv({ HUB_URL: "https://hub.example.com", FINCH_SERVICE_SECRET: "test-service-secret" });

import { POST } from "@/app/api/finch/keys/revoke/route";

const ownerContext = () =>
  Response.json({
    member: { id: "m_owner", role: "owner", state: "active", email: "owner@example.com" },
    tenantMeta: { id: "user_owner" },
  });

function request(body: unknown): Request {
  return new Request("https://app.example.com/api/finch/keys/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue({ userId: "user_owner" });
  vi.restoreAllMocks();
});

describe("POST /api/finch/keys/revoke", () => {
  it("revokes a tenant key by stable id, never by its duplicate-prone label", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const response = await POST(request({ id: "k_deadbeef", label: "duplicate-label" }));

    expect(response.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(String(url)).toBe("https://hub.example.com/api/boxes/k_deadbeef/keys/revoke");
    expect(JSON.parse(init.body as string)).toEqual({ key: "k_deadbeef" });
  });

  it("forwards a box-scoped stable key id and safely encodes the box path", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const response = await POST(
      request({ box: "mac office", service: "printer", key: "k_cafebabe" }),
    );

    expect(response.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(String(url)).toBe("https://hub.example.com/api/boxes/mac%20office/keys/revoke");
    expect(JSON.parse(init.body as string)).toEqual({ service: "printer", key: "k_cafebabe" });
  });

  it.each([
    ["an empty object", {}],
    ["a missing box field", { service: "printer", key: "k_1" }],
    ["an unsafe box", { box: "mac/office", service: "printer", key: "k_1" }],
    ["an oversized service id", { box: "mac", service: "s".repeat(64), key: "k_1" }],
    ["an empty id", { id: "  " }],
    ["a non-string id", { id: 7 }],
    ["an oversized id", { id: "k".repeat(129) }],
    [
      "ambiguous tenant and box handles",
      { id: "k_1", box: "mac", service: "printer", key: "k_1" },
    ],
    ["an unknown field", { id: "k_1", force: true }],
  ])("rejects %s before the revoke mutation", async (_name, body) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext());

    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves the hub's not-found result for a repeated or unknown revoke", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 404 }));

    const response = await POST(request({ id: "k_alreadygone" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false });
  });

  it("rejects a contradictory successful revoke response", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 200 }));

    const response = await POST(request({ id: "k_deadbeef" }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
  });
});
