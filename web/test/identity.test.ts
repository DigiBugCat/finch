import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const getMemberships = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    users: { getUser, getOrganizationMembershipList: getMemberships },
  }),
}));

import {
  MAX_IDENTITY_SYNC_BODY_BYTES,
  organizationsUnavailable,
  serializeSyncedIdentity,
  syncIdentity,
} from "@/lib/identity";

const email = (id: string, emailAddress: string, status = "verified") => ({
  id,
  emailAddress,
  verification: { status },
});

describe("syncIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({
      primaryEmailAddressId: "e_primary",
      emailAddresses: [email("e_primary", "Primary@Example.com")],
    });
  });

  it("falls back to the first usable verified address and canonicalizes duplicates", async () => {
    getUser.mockResolvedValue({
      primaryEmailAddressId: "e_primary",
      emailAddresses: [
        email("e_primary", "NO@example.com", "unverified"),
        email("e_blank", "   "),
        email("e_secondary", " Verified@Example.com "),
        email("e_duplicate", "VERIFIED@example.com"),
      ],
    });

    const out = await syncIdentity("u_1");

    expect(out).toEqual({
      emails: ["verified@example.com"],
      primaryEmail: "verified@example.com",
      adminOrgIds: [],
    });
    expect(getMemberships).not.toHaveBeenCalled();
  });

  it("paginates organization memberships, recognizes both admin roles, and deduplicates races", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      role: index === 0 ? "org:admin" : "org:member",
      organization: { id: index === 0 ? "org_shared" : `org_member_${index}` },
    }));
    getMemberships
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({
        data: [
          { role: "admin", organization: { id: "org_shared" } },
          { role: "org:admin", organization: { id: "org_second" } },
        ],
      });

    const out = await syncIdentity("u_1", { includeOrgs: true });

    expect(getMemberships).toHaveBeenNthCalledWith(1, {
      userId: "u_1",
      limit: 100,
      offset: 0,
    });
    expect(getMemberships).toHaveBeenNthCalledWith(2, {
      userId: "u_1",
      limit: 100,
      offset: 100,
    });
    expect(out.adminOrgIds).toEqual(["org_shared", "org_second"]);
  });

  it("bounds a malformed API that repeats full pages forever", async () => {
    getMemberships.mockResolvedValue({
      data: Array.from({ length: 100 }, () => ({
        role: "org:member",
        organization: { id: "org_ignored" },
      })),
    });

    await expect(syncIdentity("u_1", { includeOrgs: true })).rejects.toThrow(
      "pagination exceeded safe limit",
    );
    expect(getMemberships).toHaveBeenCalledTimes(100);
  });

  it("rejects more than 1,000 unique admin organizations before building an oversized sync", async () => {
    getMemberships.mockImplementation(async ({ offset }: { offset: number }) => ({
      data: Array.from({ length: offset < 1_000 ? 100 : 1 }, (_, index) => ({
        role: "org:admin",
        organization: { id: `org_${offset + index}` },
      })),
    }));

    await expect(syncIdentity("u_1", { includeOrgs: true })).rejects.toThrow(
      "admin organization membership limit exceeded",
    );
    expect(getMemberships).toHaveBeenCalledTimes(11);
  });

  it("accepts an identity body exactly at 256 KiB and rejects one UTF-8 byte more", () => {
    const encoder = new TextEncoder();
    const empty = JSON.stringify({ emails: [""], adminOrgIds: [] });
    const padding = "a".repeat(MAX_IDENTITY_SYNC_BODY_BYTES - encoder.encode(empty).byteLength);
    const atLimit = { emails: [padding], adminOrgIds: [] };

    const serialized = serializeSyncedIdentity(atLimit);
    expect(encoder.encode(serialized)).toHaveLength(MAX_IDENTITY_SYNC_BODY_BYTES);
    expect(() => serializeSyncedIdentity({ ...atLimit, emails: [`${padding}a`] })).toThrow(
      "identity sync body exceeded worker limit",
    );
  });

  it("fails closed on malformed organization membership data", async () => {
    getMemberships.mockResolvedValue({
      data: [{ role: "org:admin", organization: {} }],
    });

    await expect(syncIdentity("u_1", { includeOrgs: true })).rejects.toThrow(
      "invalid admin organization membership",
    );
  });

  it("rejects an oversized page instead of trusting a broken server-side limit", async () => {
    getMemberships.mockResolvedValue({
      data: Array.from({ length: 101 }, () => ({
        role: "org:member",
        organization: { id: "org_ignored" },
      })),
    });

    await expect(syncIdentity("u_1", { includeOrgs: true })).rejects.toThrow(
      "page exceeded requested limit",
    );
    expect(getMemberships).toHaveBeenCalledTimes(1);
  });

  it("degrades only when Clerk explicitly reports organizations are disabled", async () => {
    getMemberships.mockRejectedValue({
      errors: [{ code: "some_other_error" }, { code: "organization_not_enabled_in_instance" }],
    });

    await expect(syncIdentity("u_1", { includeOrgs: true })).resolves.toMatchObject({
      adminOrgIds: [],
    });
    expect(
      organizationsUnavailable({ errors: [{ code: "organization_not_enabled_in_instance" }] }),
    ).toBe(true);
  });

  it("does not swallow unrelated not-found failures", async () => {
    const failure = { errors: [{ code: "user_not_found" }] };
    getMemberships.mockRejectedValue(failure);

    await expect(syncIdentity("u_1", { includeOrgs: true })).rejects.toBe(failure);
    expect(organizationsUnavailable(failure)).toBe(false);
  });
});
