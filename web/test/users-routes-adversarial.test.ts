import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnv } from "./test-env";

const authMock = vi.fn();
const createInvitationMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
  clerkClient: async () => ({
    invitations: { createInvitation: createInvitationMock },
  }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, delete: vi.fn(), set: vi.fn() }),
}));

setupTestEnv({ HUB_URL: "https://hub.example.com", FINCH_SERVICE_SECRET: "test-service-secret" });

import { DELETE as removeMember } from "@/app/api/finch/users/[id]/route";
import { POST as setRole } from "@/app/api/finch/users/[id]/role/route";
import { POST as enableMember } from "@/app/api/finch/users/[id]/enable/route";
import { POST as inviteMember } from "@/app/api/finch/users/invite/route";

const ownerContext = () => Response.json({
  member: {
    id: "member_owner",
    role: "owner",
    state: "active",
    email: "owner@example.com",
  },
  tenantMeta: { id: "user_owner" },
});

function request(path: string, body: string): Request {
  return new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  authMock.mockReset();
  createInvitationMock.mockReset();
  vi.restoreAllMocks();
  authMock.mockResolvedValue({ userId: "user_owner" });
});

describe("member mutation route input boundaries", () => {
  it.each(["null", "[]", '"text"', "{"])(
    "rejects malformed/non-object role JSON (%s) without mutating the hub",
    async (body) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext());
      const response = await setRole(
        request("/api/finch/users/member_1/role", body),
        { params: Promise.resolve({ id: "member_1" }) },
      );
      expect(response.status).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects wrong field types instead of coercing them", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext());
    const response = await inviteMember(request(
      "/api/finch/users/invite",
      JSON.stringify({ email: ["victim@example.com"], role: { toString: "admin" } }),
    ));
    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-boolean revoke flag instead of silently preserving grants", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext());
    const response = await removeMember(
      request("/api/finch/users/member_1", JSON.stringify({ revokeGrants: "true" })),
      { params: Promise.resolve({ id: "member_1" }) },
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized or malformed member IDs before the mutation call", async () => {
    for (const id of ["", "with/slash", "a".repeat(129), "member\n1"]) {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ownerContext());
      const response = await enableMember(
        request(`/api/finch/users/${encodeURIComponent(id)}/enable`, "{}"),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status, `id=${JSON.stringify(id)}`).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    }
  });

  it("injects the authenticated actor and ignores attacker-owned actor fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockResolvedValueOnce(Response.json({ ok: true, member: { id: "member_1" } }));
    const response = await setRole(
      request("/api/finch/users/member_1/role", JSON.stringify({
        role: "ADMIN",
        actor: { clerkUserId: "attacker" },
      })),
      { params: Promise.resolve({ id: "member_1" }) },
    );
    expect(response.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      memberId: "member_1",
      role: "admin",
      actor: {
        clerkUserId: "user_owner",
        memberId: "member_owner",
        label: "owner@example.com",
      },
    });
  });

  it("turns a malformed successful hub invite into 502 without sending email", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerContext())
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    const response = await inviteMember(request(
      "/api/finch/users/invite",
      JSON.stringify({ email: "user@example.com", role: "member" }),
    ));
    expect(response.status).toBe(502);
    expect(createInvitationMock).not.toHaveBeenCalled();
  });
});
