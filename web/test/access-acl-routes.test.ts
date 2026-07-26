import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSharing: vi.fn(),
  hubProxy: vi.fn(),
  hubFetchAs: vi.fn(),
  deliverApplicationInvite: vi.fn(),
}));

vi.mock("@/lib/hub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hub")>()),
  requireSharing: mocks.requireSharing,
  hubProxy: mocks.hubProxy,
  hubFetchAs: mocks.hubFetchAs,
}));
vi.mock("@/lib/invitations", () => ({
  deliverApplicationInvite: mocks.deliverApplicationInvite,
}));

import { HttpError } from "@/lib/hub";
import { GET as listAccess } from "@/app/api/finch/access/route";
import { POST as requestAccess } from "@/app/api/finch/access/request/route";
import { POST as approveAccess } from "@/app/api/finch/access/approve/route";
import { POST as denyAccess } from "@/app/api/finch/access/deny/route";
import { POST as revokeAccess } from "@/app/api/finch/access/revoke/route";
import { POST as addAcl } from "@/app/api/finch/acl/route";
import { DELETE as removeAcl } from "@/app/api/finch/acl/[id]/route";

const context = {
  tenant: "tenant_1",
  userId: "user_1",
  memberId: "member_1",
  email: "admin@example.com",
  role: "admin" as const,
  isAdmin: true,
};

const jsonRequest = (path: string, value: unknown, raw = false) =>
  new Request(`https://app.example.com${path}`, {
    method: "POST",
    body: raw ? String(value) : JSON.stringify(value),
    headers: { "content-type": "application/json" },
  });

const pendingRow = {
  id: "ar_1",
  email: "person@example.com",
  service: "scraper",
  requestedBy: "admin@example.com",
  status: "pending" as const,
  created: 1,
};

const validLens = (overrides: Record<string, unknown> = {}) => ({
  requests: [pendingRow],
  grants: [],
  ...overrides,
});

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSharing.mockResolvedValue(context);
  mocks.hubProxy.mockResolvedValue(Response.json({ ok: true }));
  mocks.hubFetchAs.mockResolvedValue(Response.json(validLens()));
  mocks.deliverApplicationInvite.mockResolvedValue("sent");
});

describe("access and ACL authorization boundary", () => {
  it("fails closed before parsing bodies or reaching mutation helpers", async () => {
    mocks.requireSharing.mockRejectedValue(new HttpError(401, "unauthenticated"));
    const malformed = "{";
    const calls = [
      requestAccess(jsonRequest("/api/finch/access/request", malformed, true)),
      approveAccess(jsonRequest("/api/finch/access/approve", malformed, true)),
      denyAccess(jsonRequest("/api/finch/access/deny", malformed, true)),
      revokeAccess(jsonRequest("/api/finch/access/revoke", malformed, true)),
      addAcl(jsonRequest("/api/finch/acl", malformed, true)),
      listAccess(),
      removeAcl(new Request("https://app.example.com"), {
        params: Promise.resolve({ id: "r_1" }),
      }),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(401);
    }
    expect(mocks.hubProxy).not.toHaveBeenCalled();
    expect(mocks.hubFetchAs).not.toHaveBeenCalled();
  });
});

describe("POST /api/finch/access/request", () => {
  it("normalizes a valid request and supplies server-owned actor fields", async () => {
    mocks.hubFetchAs.mockResolvedValue(Response.json({ ok: true, request: pendingRow }));
    await requestAccess(
      jsonRequest("/api/finch/access/request", {
        email: "  Person@Example.COM ",
        service: " scraper ",
        requestedBy: "attacker",
      }),
    );
    expect(mocks.hubFetchAs).toHaveBeenCalledWith("tenant_1", "/api/access/request", {
      method: "POST",
      body: JSON.stringify({
        email: "person@example.com",
        service: "scraper",
        requestedBy: "admin@example.com",
        requestedByUserId: "user_1",
      }),
    });
  });

  it.each([
    ["malformed JSON", "{", true],
    ["non-object JSON", [], false],
    ["non-string email", { email: {}, service: "scraper" }, false],
    ["header-like email", { email: "a@b.com\nBcc:x@y.com", service: "scraper" }, false],
    ["non-string service", { email: "a@b.com", service: ["scraper"] }, false],
  ])("rejects %s without proxying", async (_label, value, raw) => {
    const response = await requestAccess(
      jsonRequest("/api/finch/access/request", value, raw as boolean),
    );
    expect(response.status).toBe(400);
    expect(mocks.hubFetchAs).not.toHaveBeenCalled();
  });

  it("bounds streamed request bodies", async () => {
    const response = await requestAccess(
      jsonRequest("/api/finch/access/request", `{"email":"${"a".repeat(70_000)}"}`, true),
    );
    expect(response.status).toBe(413);
    expect(mocks.hubFetchAs).not.toHaveBeenCalled();
  });

  it("fails closed when a successful hub response lacks a valid request row", async () => {
    mocks.hubFetchAs.mockResolvedValue(Response.json({ ok: true, request: null }));
    const response = await requestAccess(
      jsonRequest("/api/finch/access/request", {
        email: "person@example.com",
        service: "scraper",
      }),
    );
    expect(response.status).toBe(502);
  });
});

describe("POST /api/finch/access/approve", () => {
  it("forwards only a bounded string id and server-owned actor identity", async () => {
    mocks.hubFetchAs.mockResolvedValue(
      Response.json({ ok: true, status: "granted", email: "person@example.com" }),
    );
    const response = await approveAccess(
      jsonRequest("/api/finch/access/approve", { id: " ar_1 " }),
    );
    expect(response.status).toBe(200);
    expect(mocks.hubFetchAs).toHaveBeenCalledWith("tenant_1", "/api/access/approve", {
      method: "POST",
      body: JSON.stringify({
        id: "ar_1",
        actor: {
          clerkUserId: "user_1",
          memberId: "member_1",
          label: "admin@example.com",
        },
      }),
    });
  });

  it("does not stringify object ids into an upstream request", async () => {
    const response = await approveAccess(
      jsonRequest("/api/finch/access/approve", { id: { toString: "ar_victim" } }),
    );
    expect(response.status).toBe(400);
    expect(mocks.hubFetchAs).not.toHaveBeenCalled();
  });

  it("preserves a structured upstream error without attempting delivery", async () => {
    mocks.hubFetchAs.mockResolvedValue(
      Response.json({ error: "unknown request" }, { status: 404 }),
    );
    const response = await approveAccess(
      jsonRequest("/api/finch/access/approve", { id: "ar_missing" }),
    );
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({ error: "unknown request" });
    expect(mocks.deliverApplicationInvite).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", new Response("not-json", { status: 200 })],
    ["missing success contract", Response.json({}, { status: 200 })],
    ["missing invited member", Response.json({ ok: true, status: "invited", email: "new@example.com" })],
  ])("maps %s from the hub to 502", async (_label, upstream) => {
    mocks.hubFetchAs.mockResolvedValue(upstream);
    const response = await approveAccess(
      jsonRequest("/api/finch/access/approve", { id: "ar_1" }),
    );
    expect(response.status).toBe(502);
    expect(mocks.deliverApplicationInvite).not.toHaveBeenCalled();
  });

  it("delivers an invitation only after a valid invited response", async () => {
    mocks.hubFetchAs.mockResolvedValue(
      Response.json({
        ok: true,
        status: "invited",
        email: "new@example.com",
        member: { email: "new@example.com" },
      }),
    );
    const response = await approveAccess(
      jsonRequest("/api/finch/access/approve", { id: "ar_1" }),
    );
    expect(await body(response)).toMatchObject({ delivery: "sent" });
    expect(mocks.deliverApplicationInvite).toHaveBeenCalledWith(
      "new@example.com",
      "https://app.example.com",
    );
  });
});

describe("access list and deny transitions", () => {
  it("rejects malformed access-list state instead of exposing it as valid", async () => {
    mocks.hubFetchAs.mockResolvedValue(Response.json({ requests: {}, grants: [] }));
    const response = await listAccess();
    expect(response.status).toBe(502);
  });

  it("bounds an oversized hub response", async () => {
    mocks.hubFetchAs.mockResolvedValue(
      new Response("{}", { headers: { "content-length": String(600 * 1024) } }),
    );
    expect((await listAccess()).status).toBe(502);
  });

  it("refuses to relabel a granted row while its grant survives", async () => {
    mocks.hubFetchAs.mockResolvedValue(
      Response.json({ error: "already granted — revoke it instead" }, { status: 409 }),
    );
    const response = await denyAccess(
      jsonRequest("/api/finch/access/deny", { id: "ar_1" }),
    );
    expect(response.status).toBe(409);
  });

  it("rejects unknown and corrupt rows before a status mutation", async () => {
    mocks.hubFetchAs.mockResolvedValue(
      Response.json({ error: "unknown access request id" }, { status: 404 }),
    );
    expect(
      (await denyAccess(jsonRequest("/api/finch/access/deny", { id: "ar_missing" }))).status,
    ).toBe(404);
    mocks.hubFetchAs.mockResolvedValue(Response.json({ ok: true, status: "pending" }));
    expect(
      (await denyAccess(jsonRequest("/api/finch/access/deny", { id: "ar_1" }))).status,
    ).toBe(502);
  });

  it("denies a pending row with server-owned resolver identity", async () => {
    mocks.hubFetchAs.mockResolvedValue(Response.json({ ok: true, status: "denied" }));
    const response = await denyAccess(
      jsonRequest("/api/finch/access/deny", { id: " ar_1 " }),
    );
    expect(response.status).toBe(200);
    expect(mocks.hubFetchAs).toHaveBeenCalledWith("tenant_1", "/api/access/deny", {
      method: "POST",
      body: JSON.stringify({
        id: "ar_1",
        actor: {
          clerkUserId: "user_1",
          memberId: "member_1",
          label: "admin@example.com",
        },
      }),
    });
  });
});

describe("POST /api/finch/access/revoke", () => {
  it("rejects ambiguous handles before reading state", async () => {
    const response = await revokeAccess(
      jsonRequest("/api/finch/access/revoke", { id: "ar_1", ruleId: "r_1" }),
    );
    expect(response.status).toBe(400);
    expect(mocks.hubFetchAs).not.toHaveBeenCalled();
  });

  it("refuses a multi-service rule without partially revoking any destination", async () => {
    mocks.hubFetchAs.mockResolvedValue(
      Response.json({ error: "multi-service grants must be edited atomically" }, { status: 409 }),
    );
    const response = await revokeAccess(
      jsonRequest("/api/finch/access/revoke", { ruleId: "r_multi" }),
    );
    expect(response.status).toBe(409);
    expect(mocks.hubFetchAs).toHaveBeenCalledTimes(1);
  });

  it("refuses a mixed service-and-broader rule before stripping only one destination", async () => {
    mocks.hubFetchAs.mockResolvedValue(
      Response.json({ error: "broader grants must be edited atomically" }, { status: 409 }),
    );
    const response = await revokeAccess(
      jsonRequest("/api/finch/access/revoke", { ruleId: "r_mixed" }),
    );
    expect(response.status).toBe(409);
    expect(mocks.hubFetchAs).toHaveBeenCalledTimes(1);
  });

  it("does not corrupt queue state when a revoke result is malformed", async () => {
    mocks.hubFetchAs.mockResolvedValue(Response.json({ ok: true, removed: "yes", denied: 1 }));
    const response = await revokeAccess(
      jsonRequest("/api/finch/access/revoke", { id: "ar_1" }),
    );
    expect(response.status).toBe(502);
  });

  it("reports broader coverage and leaves request rows unchanged", async () => {
    mocks.hubFetchAs.mockResolvedValue(
      Response.json({ error: "access is still granted by a broader rule" }, { status: 409 }),
    );
    const response = await revokeAccess(
      jsonRequest("/api/finch/access/revoke", { id: "ar_1" }),
    );
    expect(response.status).toBe(409);
  });

  it("closes every non-denied row for exactly the revoked user-service pair", async () => {
    mocks.hubFetchAs.mockResolvedValue(
      Response.json({ ok: true, removed: true, denied: 2 }),
    );
    const response = await revokeAccess(
      jsonRequest("/api/finch/access/revoke", { id: "ar_1" }),
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ removed: true, denied: 2 });
    expect(mocks.hubFetchAs).toHaveBeenCalledTimes(1);
  });
});

describe("ACL mutation routes", () => {
  it("canonicalizes a valid rule before forwarding it", async () => {
    mocks.hubFetchAs.mockResolvedValue(Response.json({ id: "r_1" }));
    const response = await addAcl(
      jsonRequest("/api/finch/acl", {
        src: { type: "user", name: " Person@Example.COM " },
        dst: [{ type: "tag", name: " ops " }],
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.hubFetchAs).toHaveBeenCalledWith("tenant_1", "/api/acl", {
      method: "POST",
      body: JSON.stringify({
        src: { type: "user", name: "person@example.com" },
        dst: [{ type: "tag", name: "ops" }],
      }),
    });
  });

  it.each([
    ["a scalar source", { src: "user:a", dst: [{ type: "tag", name: "ops" }] }],
    ["a forbidden source type", { src: { type: "service", name: "svc" }, dst: [{ type: "tag", name: "ops" }] }],
    ["an empty destination", { src: { type: "user", name: "a@b.com" }, dst: [] }],
    ["a destination without a name", { src: { type: "user", name: "a@b.com" }, dst: [{ type: "tag" }] }],
    ["duplicate destinations", { src: { type: "user", name: "a@b.com" }, dst: [{ type: "tag", name: "ops" }, { type: "tag", name: "OPS" }] }],
    ["all mixed with narrower destinations", { src: { type: "user", name: "a@b.com" }, dst: [{ type: "all" }, { type: "tag", name: "ops" }] }],
  ])("rejects %s before persistent state mutation", async (_label, payload) => {
    const response = await addAcl(jsonRequest("/api/finch/acl", payload));
    expect(response.status).toBe(400);
    expect(mocks.hubFetchAs).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed successful hub response", async () => {
    mocks.hubFetchAs.mockResolvedValue(Response.json({ ok: true }));
    const response = await addAcl(
      jsonRequest("/api/finch/acl", {
        src: { type: "key", name: "crawler" },
        dst: [{ type: "tag", name: "ops" }],
      }),
    );
    expect(response.status).toBe(502);
  });

  it("validates deletion ids and URL-encodes accepted ids", async () => {
    expect(
      (await removeAcl(new Request("https://app.example.com"), { params: Promise.resolve({ id: "" }) })).status,
    ).toBe(400);
    expect(
      (await removeAcl(new Request("https://app.example.com"), { params: Promise.resolve({ id: "   " }) })).status,
    ).toBe(400);
    expect(mocks.hubProxy).not.toHaveBeenCalled();

    mocks.hubProxy.mockResolvedValue(Response.json({ ok: true }));
    const response = await removeAcl(new Request("https://app.example.com"), {
      params: Promise.resolve({ id: "r/a?b" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.hubProxy).toHaveBeenCalledWith("/api/acl/r%2Fa%3Fb", { method: "DELETE" });
  });
});
