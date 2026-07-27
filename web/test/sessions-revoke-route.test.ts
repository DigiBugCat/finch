import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnv } from "./test-env";

const authMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({ auth: () => authMock() }));

setupTestEnv({ HUB_URL: "https://hub.example.com", FINCH_SERVICE_SECRET: "test-service-secret" });

import { POST } from "@/app/api/finch/sessions/revoke/route";

const memberContext = (role: "owner" | "member") =>
  Response.json({
    member: { id: "m", role, state: "active", email: `${role}@example.com` },
    tenantMeta: { id: "user_owner" },
  });

beforeEach(() => {
  authMock.mockReset();
  vi.restoreAllMocks();
});

describe("POST /api/finch/sessions/revoke", () => {
  it("rejects unauthenticated callers without touching the hub", async () => {
    authMock.mockResolvedValue({ userId: null });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await POST();

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects members before the epoch mutation", async () => {
    authMock.mockResolvedValue({ userId: "user_member" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext("member"));

    const response = await POST();

    expect(response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards exactly one owner-authorized epoch bump", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext("owner"))
      .mockResolvedValueOnce(Response.json({ ok: true, epoch: 2 }));

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, epoch: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(String(url)).toBe("https://hub.example.com/api/sessions-revoke");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
  });

  it("preserves a structured hub failure and status", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext("owner"))
      .mockResolvedValueOnce(Response.json({ error: "overloaded" }, { status: 503 }));

    const response = await POST();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "overloaded" });
  });

  it.each([
    ["non-JSON", new Response("bad gateway", { status: 200 })],
    ["a missing epoch", Response.json({ ok: true })],
    ["a fractional epoch", Response.json({ ok: true, epoch: 1.5 })],
  ])("returns 502 for %s success data from the hub", async (_name, hubResponse) => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext("owner"))
      .mockResolvedValueOnce(hubResponse);

    const response = await POST();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
  });

  it("reports an action-plane network failure as an upstream 502", async () => {
    authMock.mockResolvedValue({ userId: "user_owner" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext("owner"))
      .mockRejectedValueOnce(new TypeError("connection reset"));

    const response = await POST();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "hub unavailable" });
  });
});
