// BFF route-handler test: POST /api/finch/keys is a MUTATING, admin-only route
// (adminProxy -> requireAdmin). A non-admin org member must get 403 and the
// request must NEVER reach the hub. An admin's request is forwarded to the hub
// and the hub's response is passed back. We mock Clerk's auth() and global fetch
// so no network / Clerk session is required.
import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
}));

// Give lib/hub the env it reads (HUB_URL + service secret) so the admin path
// can build a request; runtimeEnv falls back to process.env under test.
process.env.HUB_URL = "https://hub.example.com";
process.env.FINCH_SERVICE_SECRET = "test-service-secret";

import { POST } from "@/app/api/finch/keys/route";

beforeEach(() => {
  authMock.mockReset();
  vi.restoreAllMocks();
});

function keysRequestBody() {
  return JSON.stringify({ label: "laptop", owner: "you", scope: { all: true } });
}

describe("POST /api/finch/keys", () => {
  it("returns 403 for a non-admin org member and never calls the hub", async () => {
    authMock.mockResolvedValue({
      userId: "user_1",
      orgId: "org_9",
      orgRole: "org:member",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const req = new Request("https://app.example.com/api/finch/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: keysRequestBody(),
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/admin/i);
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue({ userId: null, orgId: null, orgRole: null });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const req = new Request("https://app.example.com/api/finch/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: keysRequestBody(),
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards an admin's mint to the hub and returns the hub response", async () => {
    authMock.mockResolvedValue({
      userId: "user_1",
      orgId: "org_9",
      orgRole: "org:admin",
    });
    // The hub echoes a MintKeyResp with a STRUCTURED scope.
    const hubBody = JSON.stringify({
      key: "finch_secret",
      label: "laptop",
      scope: { all: true },
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(hubBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const req = new Request("https://app.example.com/api/finch/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: keysRequestBody(),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The hub call carried the service secret + a signed tenant assertion.
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/keys");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Finch-Service")).toBe("test-service-secret");
    expect(headers.get("X-Finch-Auth")).toBeTruthy();

    const body = (await res.json()) as { key: string; scope: unknown };
    expect(body.key).toBe("finch_secret");
    expect(body.scope).toEqual({ all: true });
  });
});
