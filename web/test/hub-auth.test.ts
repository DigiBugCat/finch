// Unit tests for lib/hub.ts authorization logic: resolveTenant / requireAdmin
// (which exercise the private roleIsAdmin) plus the exported role helpers.
//
// resolveTenant/requireAdmin call Clerk's auth(); we mock @clerk/nextjs/server
// so we can drive every (orgId, orgRole) combination and assert the admin
// decision + the 401/403 throw behavior the mutating routes rely on.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Clerk server module BEFORE importing the module under test.
const authMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
}));

import {
  resolveTenant,
  requireAdmin,
  isClerkOrgAdmin,
  toClerkOrgRole,
  HttpError,
} from "@/lib/hub";

beforeEach(() => {
  authMock.mockReset();
});

describe("resolveTenant", () => {
  it("throws 401 when unauthenticated", async () => {
    authMock.mockResolvedValue({ userId: null, orgId: null, orgRole: null });
    await expect(resolveTenant()).rejects.toMatchObject({
      status: 401,
    });
    await expect(resolveTenant()).rejects.toBeInstanceOf(HttpError);
  });

  it("personal (no-org) tenant: tenant = userId, lone user is admin", async () => {
    authMock.mockResolvedValue({ userId: "user_1", orgId: null, orgRole: null });
    const ctx = await resolveTenant();
    expect(ctx.tenant).toBe("user_1");
    expect(ctx.orgId).toBeNull();
    expect(ctx.isAdmin).toBe(true);
  });

  it("org admin: tenant = orgId, isAdmin true", async () => {
    authMock.mockResolvedValue({
      userId: "user_1",
      orgId: "org_9",
      orgRole: "org:admin",
    });
    const ctx = await resolveTenant();
    expect(ctx.tenant).toBe("org_9");
    expect(ctx.isAdmin).toBe(true);
  });

  it("org member: isAdmin false (read-only)", async () => {
    authMock.mockResolvedValue({
      userId: "user_1",
      orgId: "org_9",
      orgRole: "org:member",
    });
    const ctx = await resolveTenant();
    expect(ctx.tenant).toBe("org_9");
    expect(ctx.isAdmin).toBe(false);
  });

  it("org owner role counts as admin", async () => {
    authMock.mockResolvedValue({
      userId: "user_1",
      orgId: "org_9",
      orgRole: "org:owner",
    });
    expect((await resolveTenant()).isAdmin).toBe(true);
  });
});

describe("requireAdmin", () => {
  it("returns the resolved tenant for an admin", async () => {
    authMock.mockResolvedValue({
      userId: "user_1",
      orgId: "org_9",
      orgRole: "org:admin",
    });
    const ctx = await requireAdmin();
    expect(ctx.tenant).toBe("org_9");
    expect(ctx.isAdmin).toBe(true);
  });

  it("throws 403 for a non-admin org member", async () => {
    authMock.mockResolvedValue({
      userId: "user_1",
      orgId: "org_9",
      orgRole: "org:member",
    });
    await expect(requireAdmin()).rejects.toMatchObject({ status: 403 });
  });

  it("throws 401 when unauthenticated", async () => {
    authMock.mockResolvedValue({ userId: null, orgId: null, orgRole: null });
    await expect(requireAdmin()).rejects.toMatchObject({ status: 401 });
  });
});

describe("isClerkOrgAdmin", () => {
  it("true only for admin org roles", () => {
    expect(isClerkOrgAdmin("org:admin")).toBe(true);
    expect(isClerkOrgAdmin("admin")).toBe(true);
    expect(isClerkOrgAdmin("org:member")).toBe(false);
    // Narrower than roleIsAdmin: "owner" forms are NOT Clerk membership roles.
    expect(isClerkOrgAdmin("org:owner")).toBe(false);
    expect(isClerkOrgAdmin(null)).toBe(false);
    expect(isClerkOrgAdmin(undefined)).toBe(false);
  });
});

describe("toClerkOrgRole", () => {
  it("maps dashboard + raw roles to a Clerk org role", () => {
    expect(toClerkOrgRole("Admin")).toBe("org:admin");
    expect(toClerkOrgRole("org:admin")).toBe("org:admin");
    expect(toClerkOrgRole("Member")).toBe("org:member");
    expect(toClerkOrgRole(undefined)).toBe("org:member");
  });
});
