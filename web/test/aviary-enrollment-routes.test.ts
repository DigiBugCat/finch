import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
}));

process.env.HUB_URL = "https://hub.example.com";
process.env.FINCH_SERVICE_SECRET = "test-service-secret";

import { POST as describeEnrollment } from "@/app/api/finch/aviary-describe/route";
import { POST as approveEnrollment } from "@/app/api/finch/aviary-approve/route";
import { POST as denyEnrollment } from "@/app/api/finch/aviary-deny/route";
let currentUser = ""; let userSeq = 0;
const ownerContext = () => Response.json({ member: { id: "m_owner", role: "owner", state: "active", email: "owner@example.com" }, tenantMeta: { id: currentUser } });

function request(path: string, body: unknown): Request {
  return new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  authMock.mockReset();
  vi.restoreAllMocks();
  currentUser = `user_approver_${userSeq++}`;
  authMock.mockResolvedValue({
    userId: currentUser,
    orgId: "org_aviary",
    orgRole: "org:admin",
  });
});

describe("Aviary service enrollment BFF", () => {
  it("requires a tenant admin to describe a code", async () => {
    authMock.mockResolvedValue({
      userId: "user_member",
      orgId: "org_aviary",
      orgRole: "org:member",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ member: { id: "m_member", role: "member", state: "active", email: "member@example.com" }, tenantMeta: { id: "user_member" } }));

    const response = await describeEnrollment(request(
      "/api/finch/aviary-describe",
      { user_code: "WXYZ-2K7Q" },
    ));

    expect(response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("normalizes and forwards the short code without adding secrets", async () => {
    const hubBody = {
      found: true,
      status: "pending",
      manifest: {
        service: "Media search",
        app_path: "media",
        routes: ["/api/v1", "/birdz", "/mcp"],
        edge_auth: "key",
        machine: "aviary-01",
        machine_fingerprint: "SHA256:device",
      },
      manifest_sha256: "sha256",
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext()).mockResolvedValueOnce(
      Response.json(hubBody),
    );

    const response = await describeEnrollment(request(
      "/api/finch/aviary-describe",
      { user_code: " wxyz-2k7q " },
    ));

    expect(response.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/aviary/device/describe");
    expect(JSON.parse(init.body as string)).toEqual({ user_code: "WXYZ-2K7Q" });
    const headers = new Headers(init.headers);
    expect(headers.get("X-Finch-Service")).toBe("test-service-secret");
    expect(headers.get("X-Finch-Auth")).toBeTruthy();
    expect(await response.json()).toEqual(hubBody);
  });

  it("injects the Clerk actor and only accepts literal true for public approval", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext()).mockResolvedValueOnce(
      Response.json({ ok: true, status: "approved" }),
    );

    const response = await approveEnrollment(request(
      "/api/finch/aviary-approve",
      {
        user_code: "WXYZ-2K7Q",
        public_approved: "true",
        approver: "attacker-chosen-user",
      },
    ));

    expect(response.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/aviary/device/approve");
    expect(JSON.parse(init.body as string)).toEqual({
      user_code: "WXYZ-2K7Q",
      approver: currentUser,
      public_approved: false,
    });
  });

  it("forwards explicit public confirmation and preserves a collision response", async () => {
    const collision = {
      error: {
        code: "app_path_collision",
        message: "that app path is already owned",
      },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext()).mockResolvedValueOnce(
      Response.json(collision, { status: 409 }),
    );

    const response = await approveEnrollment(request(
      "/api/finch/aviary-approve",
      { user_code: "WXYZ-2K7Q", public_approved: true },
    ));

    expect(response.status).toBe(409);
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string).public_approved).toBe(true);
    expect(await response.json()).toEqual(collision);
  });

  it("denies with a server-owned actor and reason", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext()).mockResolvedValueOnce(
      Response.json({ ok: true, status: "denied" }),
    );

    const response = await denyEnrollment(request(
      "/api/finch/aviary-deny",
      {
        user_code: "WXYZ-2K7Q",
        approver: "attacker-chosen-user",
        reason: "attacker text",
      },
    ));

    expect(response.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/aviary/device/deny");
    expect(JSON.parse(init.body as string)).toEqual({
      user_code: "WXYZ-2K7Q",
      approver: currentUser,
      reason: "Denied from the Finch Aviary authorization page",
    });
  });
});
