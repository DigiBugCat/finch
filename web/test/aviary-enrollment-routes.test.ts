import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnv } from "./test-env";

const authMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
}));

setupTestEnv({ HUB_URL: "https://hub.example.com", FINCH_SERVICE_SECRET: "test-service-secret" });

import { POST as describeEnrollment } from "@/app/api/finch/aviary-describe/route";
import { POST as approveEnrollment } from "@/app/api/finch/aviary-approve/route";
import { POST as denyEnrollment } from "@/app/api/finch/aviary-deny/route";

const enrollmentRoutes = [
  ["describe", describeEnrollment, "/api/finch/aviary-describe"],
  ["approve", approveEnrollment, "/api/finch/aviary-approve"],
  ["deny", denyEnrollment, "/api/finch/aviary-deny"],
] as const;

let currentUser = "";
let userSeq = 0;
const ownerContext = () => Response.json({
  member: {
    id: "m_owner",
    role: "owner",
    state: "active",
    email: "owner@example.com",
  },
  tenantMeta: { id: currentUser },
});

function request(path: string, body: unknown): Request {
  return new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(path: string, body?: BodyInit, headers?: HeadersInit): Request {
  return new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers,
    body,
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

  it("canonicalizes human-formatted short codes without adding secrets", async () => {
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
      manifest_sha256: "a".repeat(64),
      token: "must-not-cross-the-bff",
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext()).mockResolvedValueOnce(
      Response.json(hubBody),
    );

    const response = await describeEnrollment(request(
      "/api/finch/aviary-describe",
      { user_code: " wx yz - 2k7q " },
    ));

    expect(response.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[1] as [URL, RequestInit];
    expect(String(url)).toBe("https://hub.example.com/api/aviary/device/describe");
    expect(JSON.parse(init.body as string)).toEqual({ user_code: "WXYZ-2K7Q" });
    const headers = new Headers(init.headers);
    expect(headers.get("X-Finch-Service")).toBe("test-service-secret");
    expect(headers.get("X-Finch-Auth")).toBeTruthy();
    const responseBody = await response.json();
    const { token: _token, ...safeHubBody } = hubBody;
    expect(responseBody).toEqual(safeHubBody);
    expect(responseBody).not.toHaveProperty("token");
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
    const [url, init] = fetchSpy.mock.calls[1] as [URL, RequestInit];
    expect(String(url)).toBe("https://hub.example.com/api/aviary/device/approve");
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
    const [url, init] = fetchSpy.mock.calls[1] as [URL, RequestInit];
    expect(String(url)).toBe("https://hub.example.com/api/aviary/device/deny");
    expect(JSON.parse(init.body as string)).toEqual({
      user_code: "WXYZ-2K7Q",
      approver: currentUser,
      reason: "Denied from the Finch Aviary authorization page",
    });
  });

  it.each(enrollmentRoutes)(
    "%s rejects every valid non-object JSON shape without reaching the decision endpoint",
    async (_name, handler, path) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      for (const body of [null, [], "WXYZ-2K7Q", 42, true]) {
        fetchSpy.mockResolvedValueOnce(ownerContext());
        const callsBefore = fetchSpy.mock.calls.length;

        const response = await handler(request(path, body));

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "JSON object body required" });
        expect(fetchSpy).toHaveBeenCalledTimes(callsBefore + 1);
      }
    },
  );

  it("rejects coercible, ambiguous, and wrongly sized codes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const invalidCodes: unknown[] = [
      23456789,
      ["WXYZ-2K7Q"],
      { toString: () => "WXYZ-2K7Q" },
      "ABCD-EF01",
      "ABC-DEFG",
      "ABCDE-FGHJ",
    ];
    for (const user_code of invalidCodes) {
      fetchSpy.mockResolvedValueOnce(ownerContext());
      const callsBefore = fetchSpy.mock.calls.length;

      const response = await describeEnrollment(request(
        "/api/finch/aviary-describe",
        { user_code },
      ));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "a valid user_code is required" });
      expect(fetchSpy).toHaveBeenCalledTimes(callsBefore + 1);
    }
  });

  it("does not let a valid legacy alias override an invalid primary code", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext());

    const response = await approveEnrollment(request(
      "/api/finch/aviary-approve",
      { user_code: false, userCode: "WXYZ-2K7Q" },
    ));

    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and oversized bodies before reaching the decision endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockResolvedValueOnce(ownerContext());

    const malformed = await denyEnrollment(rawRequest(
      "/api/finch/aviary-deny",
      "{",
      { "content-type": "application/json" },
    ));
    const oversized = await denyEnrollment(request(
      "/api/finch/aviary-deny",
      { user_code: "WXYZ-2K7Q", padding: "x".repeat(4096) },
    ));

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request body too large" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("fails closed when authorization context from the hub is malformed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json(null),
    );

    const response = await describeEnrollment(request(
      "/api/finch/aviary-describe",
      { user_code: "WXYZ-2K7Q" },
    ));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, non-object, and incomplete successful decision responses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const invalidSuccesses = [
      new Response("not json", { status: 200 }),
      Response.json(null),
      Response.json({}),
    ];
    for (const upstreamResponse of invalidSuccesses) {
      fetchSpy.mockResolvedValueOnce(ownerContext()).mockResolvedValueOnce(upstreamResponse);

      const response = await approveEnrollment(request(
        "/api/finch/aviary-approve",
        { user_code: "WXYZ-2K7Q" },
      ));

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "invalid response from hub" });
    }
  });
});
