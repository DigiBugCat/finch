import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  clerkClient: vi.fn(),
  userFetch: vi.fn(),
  hubFetchAs: vi.fn(),
  syncIdentity: vi.fn(),
  serializeSyncedIdentity: vi.fn((identity: unknown) => JSON.stringify(identity)),
  organizationsUnavailable: vi.fn(() => false),
  readActiveTenant: vi.fn(),
  writeActiveTenant: vi.fn(),
  clearActiveTenant: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
  clerkClient: mocks.clerkClient,
}));
vi.mock("@/lib/hub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hub")>()),
  userFetch: mocks.userFetch,
  hubFetchAs: mocks.hubFetchAs,
}));
vi.mock("@/lib/identity", () => ({
  syncIdentity: mocks.syncIdentity,
  serializeSyncedIdentity: mocks.serializeSyncedIdentity,
  organizationsUnavailable: mocks.organizationsUnavailable,
}));
vi.mock("@/lib/tenant-cookie", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-cookie")>()),
  readActiveTenant: mocks.readActiveTenant,
  writeActiveTenant: mocks.writeActiveTenant,
  clearActiveTenant: mocks.clearActiveTenant,
}));

import { GET as listTenants } from "@/app/api/finch/tenants/route";
import { POST as createTenant } from "@/app/api/finch/tenants/create/route";
import { POST as selectTenant } from "@/app/api/finch/tenants/select/route";
import { POST as claimTenant } from "@/app/api/finch/tenants/claim/route";

const post = (body: string | unknown, headers?: HeadersInit) => new Request("https://app.example/api", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: "user_owner" });
  mocks.syncIdentity.mockResolvedValue({
    emails: ["owner@example.com"],
    primaryEmail: "owner@example.com",
    adminOrgIds: [],
  });
  mocks.readActiveTenant.mockResolvedValue(null);
});

describe("tenant route request and upstream boundaries", () => {
  it("rejects unauthenticated calls before reading attacker-controlled bodies", async () => {
    mocks.auth.mockResolvedValue({ userId: null });
    const requests = [
      createTenant(post("{")),
      selectTenant(post("{")),
      claimTenant(post("{")),
      listTenants(),
    ];
    for (const response of await Promise.all(requests)) expect(response.status).toBe(401);
    expect(mocks.userFetch).not.toHaveBeenCalled();
    expect(mocks.hubFetchAs).not.toHaveBeenCalled();
  });

  it("bounds JSON bytes and rejects valid non-object JSON as client errors", async () => {
    expect((await createTenant(post("null"))).status).toBe(400);
    expect((await selectTenant(post("[]"))).status).toBe(400);
    expect((await claimTenant(post(JSON.stringify({ padding: "x".repeat(4096) })))).status).toBe(413);
    expect(mocks.syncIdentity).not.toHaveBeenCalled();
    expect(mocks.hubFetchAs).not.toHaveBeenCalled();
    expect(mocks.clerkClient).not.toHaveBeenCalled();
  });

  it("treats 64 Unicode code points as 64 characters and sets only a validated tenant id", async () => {
    const name = "🪶".repeat(64);
    mocks.userFetch.mockResolvedValue(Response.json({ tenantId: "ft_12345678" }));

    const response = await createTenant(post({ name: ` ${name} ` }));

    expect(response.status).toBe(200);
    const [, , init] = mocks.userFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ name, email: "owner@example.com" });
    expect(mocks.writeActiveTenant).toHaveBeenCalledWith("ft_12345678");
  });

  it("forwards a valid idempotency key to the hub and drops a malformed one", async () => {
    // The key is what makes a retry after a failed index write REPAIR the
    // original workspace instead of duplicating it — the hub derives the
    // tenant id from (user, key). Nothing in the type system holds this
    // forwarding, so pin the seam: dropped silently, every retry would mint a
    // fresh workspace again.
    mocks.userFetch.mockResolvedValue(Response.json({ tenantId: "ft_12345678" }));

    await createTenant(post({ name: "Acme", idempotencyKey: "attempt-1234" }));
    let [, , init] = mocks.userFetch.mock.calls[0];
    expect(JSON.parse(init.body).idempotencyKey).toBe("attempt-1234");

    // Malformed (bad charset / too short) degrades to the non-idempotent path
    // rather than failing an otherwise valid create.
    for (const bad of ["short", "has spaces in it", "x".repeat(65), 42]) {
      mocks.userFetch.mockClear();
      mocks.userFetch.mockResolvedValue(Response.json({ tenantId: "ft_12345678" }));
      await createTenant(post({ name: "Acme", idempotencyKey: bad }));
      [, , init] = mocks.userFetch.mock.calls[0];
      expect("idempotencyKey" in JSON.parse(init.body)).toBe(false);
    }
  });

  it("rejects overlong or control-bearing workspace names without side effects", async () => {
    for (const name of ["a".repeat(65), "line\nbreak"]) {
      expect((await createTenant(post({ name }))).status).toBe(400);
    }
    expect(mocks.syncIdentity).not.toHaveBeenCalled();
    expect(mocks.userFetch).not.toHaveBeenCalled();
    expect(mocks.writeActiveTenant).not.toHaveBeenCalled();
  });

  it("does not persist a corrupt tenant id from a successful hub response", async () => {
    mocks.userFetch.mockResolvedValue(Response.json({ tenantId: "bad tenant/id" }));

    const response = await createTenant(post({ name: "Team" }));

    expect(response.status).toBe(502);
    expect(mocks.writeActiveTenant).not.toHaveBeenCalled();
  });

  it("preserves a structured hub failure instead of attempting a cookie write", async () => {
    mocks.userFetch.mockResolvedValue(Response.json({ error: "conflict" }, { status: 409 }));

    const response = await createTenant(post({ name: "Team" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict" });
    expect(mocks.writeActiveTenant).not.toHaveBeenCalled();
  });

  it("selects only after an active membership response and forwards the authenticated user", async () => {
    mocks.hubFetchAs.mockResolvedValue(Response.json({
      member: { id: "m_owner", role: "owner", state: "active", email: "owner@example.com" },
      tenantMeta: { id: "org_acme" },
    }));

    const response = await selectTenant(post({ tenantId: "org_acme" }));

    expect(response.status).toBe(200);
    expect(mocks.hubFetchAs).toHaveBeenCalledWith("org_acme", "/api/member-context", {
      method: "POST",
      body: JSON.stringify({ clerkUserId: "user_owner" }),
    });
    expect(mocks.writeActiveTenant).toHaveBeenCalledWith("org_acme");
  });

  it("distinguishes membership denial, hub outage, and corrupt 2xx state without changing cookies", async () => {
    mocks.hubFetchAs
      .mockResolvedValueOnce(Response.json({ error: "missing" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ error: "down" }, { status: 503 }))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(Response.json({
        member: { id: "m_owner", role: "owner", state: "active", email: "owner@example.com" },
        tenantMeta: { id: "org_other" },
      }));

    expect((await selectTenant(post({ tenantId: "org_acme" }))).status).toBe(403);
    expect((await selectTenant(post({ tenantId: "org_acme" }))).status).toBe(503);
    expect((await selectTenant(post({ tenantId: "org_acme" }))).status).toBe(502);
    expect((await selectTenant(post({ tenantId: "org_acme" }))).status).toBe(403);
    expect(mocks.writeActiveTenant).not.toHaveBeenCalled();
  });
});

describe("tenant bootstrap state reconciliation", () => {
  it("preserves a bounded worker rejection instead of masking it as a bridge failure", async () => {
    mocks.userFetch.mockResolvedValue(Response.json(
      { error: "request body too large" },
      { status: 413 },
    ));

    const response = await listTenants();

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body too large" });
  });

  it("fails closed when a 2xx sync response is malformed or structurally corrupt", async () => {
    mocks.userFetch
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(Response.json({ tenants: null, claimable: [] }));

    expect((await listTenants()).status).toBe(502);
    expect((await listTenants()).status).toBe(502);
  });

  it("clears a selected workspace revoked from the synchronized active memberships", async () => {
    mocks.readActiveTenant.mockResolvedValue("org_revoked");
    mocks.userFetch.mockResolvedValue(Response.json({
      tenants: [{ tenantId: "user_owner", state: "active" }],
      claimable: [],
    }));

    const response = await listTenants();

    expect(response.status).toBe(200);
    expect((await response.json()).activeTenant).toBe("user_owner");
    expect(mocks.clearActiveTenant).toHaveBeenCalledOnce();
  });

  it("retains a synchronized active team selection", async () => {
    mocks.readActiveTenant.mockResolvedValue("org_acme");
    mocks.userFetch.mockResolvedValue(Response.json({
      tenants: [{ tenantId: "org_acme", state: "active" }],
      claimable: [],
    }));

    const response = await listTenants();

    expect((await response.json()).activeTenant).toBe("org_acme");
    expect(mocks.clearActiveTenant).not.toHaveBeenCalled();
  });
});

describe("legacy organization claims", () => {
  function clerkFixture() {
    const users = {
      getOrganizationMembershipList: vi.fn().mockResolvedValue({
        data: [{ organization: { id: "org_acme" }, role: "org:admin" }],
      }),
      getUser: vi.fn(async (userId: string) => ({
        primaryEmailAddressId: `email_${userId}`,
        emailAddresses: [{
          id: `email_${userId}`,
          emailAddress: userId === "user_owner" ? "OWNER@example.com" : "member@example.com",
          verification: { status: "verified" },
        }],
      })),
    };
    const organizations = {
      getOrganization: vi.fn().mockResolvedValue({ name: "Acme" }),
      getOrganizationMembershipList: vi.fn().mockResolvedValue({
        data: [
          { publicUserData: { userId: "user_owner", identifier: "owner@example.com" }, role: "org:admin" },
          { publicUserData: { userId: "user_member", identifier: "member@example.com" }, role: "org:member" },
        ],
      }),
      getOrganizationInvitationList: vi.fn().mockResolvedValue({
        data: [
          { emailAddress: "MEMBER@example.com" },
          { emailAddress: "invitee@example.com" },
        ],
      }),
    };
    return { users, organizations };
  }

  it("imports normalized, deduplicated identities and persists only a confirmed bootstrap", async () => {
    const clerk = clerkFixture();
    mocks.clerkClient.mockResolvedValue(clerk);
    mocks.userFetch.mockResolvedValue(Response.json({ ok: true }));

    const response = await claimTenant(post({ clerkOrgId: "org_acme" }));

    expect(response.status).toBe(200);
    const payload = JSON.parse(mocks.userFetch.mock.calls[0][2].body);
    expect(payload.members).toEqual([
      { clerkUserId: "user_owner", email: "owner@example.com", role: "owner", state: "active" },
      { clerkUserId: "user_member", email: "member@example.com", role: "member", state: "active" },
      { email: "invitee@example.com", role: "member", state: "invited" },
    ]);
    expect(mocks.writeActiveTenant).toHaveBeenCalledWith("org_acme");
  });

  it("rejects malformed and overlong organization ids before Clerk lookup", async () => {
    for (const clerkOrgId of ["org_", `org_${"a".repeat(125)}`, "org_a/b"]) {
      expect((await claimTenant(post({ clerkOrgId }))).status).toBe(400);
    }
    expect(mocks.clerkClient).not.toHaveBeenCalled();
  });

  it("caps pathological full-page caller membership scans", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      organization: { id: `org_other_${i}` },
      role: "org:admin",
    }));
    const clerk = clerkFixture();
    clerk.users.getOrganizationMembershipList.mockResolvedValue({ data: fullPage });
    mocks.clerkClient.mockResolvedValue(clerk);

    const response = await claimTenant(post({ clerkOrgId: "org_acme" }));

    expect(response.status).toBe(409);
    expect(clerk.users.getOrganizationMembershipList).toHaveBeenCalledTimes(10);
    expect(clerk.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("rejects an organization over the import ceiling before per-user expansion", async () => {
    const clerk = clerkFixture();
    clerk.organizations.getOrganizationMembershipList.mockImplementation(async ({ offset }: { offset: number }) => ({
      data: Array.from({ length: offset < 200 ? 100 : 1 }, (_, i) => ({
        publicUserData: { userId: `user_${offset + i}`, identifier: `u${offset + i}@example.com` },
        role: "org:member",
      })),
    }));
    mocks.clerkClient.mockResolvedValue(clerk);

    const response = await claimTenant(post({ clerkOrgId: "org_acme" }));

    expect(response.status).toBe(409);
    expect(clerk.users.getUser).not.toHaveBeenCalled();
    expect(mocks.userFetch).not.toHaveBeenCalled();
  });

  it("revalidates admin authority after identity expansion before claiming", async () => {
    const clerk = clerkFixture();
    clerk.users.getOrganizationMembershipList
      .mockResolvedValueOnce({
        data: [{ organization: { id: "org_acme" }, role: "org:admin" }],
      })
      .mockResolvedValueOnce({
        data: [{ organization: { id: "org_acme" }, role: "org:member" }],
      });
    mocks.clerkClient.mockResolvedValue(clerk);

    const response = await claimTenant(post({ clerkOrgId: "org_acme" }));

    expect(response.status).toBe(403);
    expect(mocks.userFetch).not.toHaveBeenCalled();
    expect(mocks.writeActiveTenant).not.toHaveBeenCalled();
  });

  it("does not set a cookie when a successful bootstrap response lacks confirmation", async () => {
    mocks.clerkClient.mockResolvedValue(clerkFixture());
    mocks.userFetch.mockResolvedValue(Response.json({ members: [] }));

    const response = await claimTenant(post({ clerkOrgId: "org_acme" }));

    expect(response.status).toBe(502);
    expect(mocks.writeActiveTenant).not.toHaveBeenCalled();
  });
});
