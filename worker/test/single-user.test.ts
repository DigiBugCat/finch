import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import worker from "../src/index";
import { signAssertion } from "../src/auth";

// SINGLE-USER TENANCY at the control API. A signed-in Clerk user acts on the
// tenant they OWN if one exists (a workspace or Clerk-org tenant claimed before
// the cut), else their personal tenant (their Clerk user id). Pre-cut rosters,
// directory rows and invitations stay in storage, but only an owner resolves.

const SERVICE = env.FINCH_SERVICE_SECRET;
const HOST = "hub.test";
const nowSec = () => Math.floor(Date.now() / 1000);
let seq = 0;

const runInDO = runInDurableObject as unknown as (
  target: DurableObjectStub,
  callback: (instance: any) => unknown,
) => Promise<any>;

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function post(path: string, auth: { tenant: string; kind?: string }, body: unknown = {}) {
  return call(
    new Request(`http://${HOST}${path}`, {
      method: "POST",
      headers: {
        host: HOST,
        "content-type": "application/json",
        "X-Finch-Service": SERVICE,
        "X-Finch-Auth": await signAssertion(
          { tenant: auth.tenant, exp: nowSec() + 300, ...(auth.kind ? { kind: auth.kind } : {}) },
          SERVICE,
        ),
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Write a pre-cut team tenant (the retired bootstrapMembers op's output). */
async function seedTeamTenant(
  tenantId: string,
  members: { clerkUserId: string | null; email: string; role: string; state: string }[],
  meta: Record<string, unknown> = {},
) {
  const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
  await stub.fetch("https://tenant/op", { method: "POST", body: JSON.stringify({ op: "getState" }) });
  await runInDO(stub, async (instance: any) => {
    const s: any = await instance.ctx.storage.get("state");
    const now = Date.now();
    s.tenantMeta = {
      id: tenantId, kind: "team", displayName: `Team ${tenantId}`, createdAt: now,
      bootstrappedFrom: "fresh", membershipVersion: 1, ...meta,
    };
    s.members = members.map((m, i) => ({ id: `m_${i}`, tenantId, createdAt: now, updatedAt: now, ...m }));
    await instance.ctx.storage.put("state", s);
  });
}

/** Write pre-cut directory rows for a user (the retired upsertMembership). */
async function seedDirectory(clerkUserId: string, rows: { tenantId: string; role: string; state: string }[]) {
  await runInDO(env.DIRECTORY.get(env.DIRECTORY.idFromName("global")), async (instance: any) => {
    await instance.ctx.storage.put(
      `u:${clerkUserId}`,
      rows.map((r, i) => ({ memberId: `m_${i}`, ...r })),
    );
  });
}

describe("/api/user/sync — resolves the tenant a user owns", () => {
  it("falls back to the personal tenant, bootstrapping it from the verified email", async () => {
    const user = `user_solo_${Date.now()}_${seq++}`;
    const res = await post("/api/user/sync", { tenant: user, kind: "user" }, {
      emails: ["solo@example.com"],
      primaryEmail: "solo@example.com",
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as any;
    expect(out.tenant).toBe(user);
    expect(out.claimable).toEqual([]);
    expect(out.tenants).toEqual([
      expect.objectContaining({ tenantId: user, role: "owner", state: "active", kind: "personal" }),
    ]);
  });

  it("reports an un-bootstrapped personal tenant as invited when no email is sent", async () => {
    const user = `user_fresh_${Date.now()}_${seq++}`;
    const out = (await (await post("/api/user/sync", { tenant: user, kind: "user" }, { emails: [] })).json()) as any;
    expect(out.tenant).toBe(user);
    expect(out.tenants).toEqual([
      expect.objectContaining({ tenantId: user, role: "owner", state: "invited", kind: "personal" }),
    ]);
  });

  it("puts an OWNED legacy workspace first, ahead of the personal tenant", async () => {
    const user = `user_owner_${Date.now()}_${seq++}`;
    const owned = `ft_owned_${Date.now()}_${seq++}`;
    const org = `org_legacy_${Date.now()}_${seq++}`;
    const memberOf = `ft_member_${Date.now()}_${seq++}`;
    await seedTeamTenant(owned, [{ clerkUserId: user, email: "o@example.com", role: "owner", state: "active" }]);
    // A claimed legacy Clerk-org tenant resolves for its owner too.
    await seedTeamTenant(org, [{ clerkUserId: user, email: "o@example.com", role: "owner", state: "active" }], {
      clerkOrgId: org,
      bootstrappedFrom: "legacy-org",
    });
    // Mere membership (admin) in somebody else's workspace no longer counts.
    await seedTeamTenant(memberOf, [
      { clerkUserId: "user_someone_else", email: "x@example.com", role: "owner", state: "active" },
      { clerkUserId: user, email: "o@example.com", role: "admin", state: "active" },
    ]);
    await seedDirectory(user, [
      { tenantId: owned, role: "owner", state: "active" },
      { tenantId: memberOf, role: "admin", state: "active" },
      { tenantId: org, role: "owner", state: "active" },
    ]);

    const out = (await (await post("/api/user/sync", { tenant: user, kind: "user" }, { emails: [] })).json()) as any;
    expect(out.tenant).toBe(owned);
    expect(out.tenants.map((t: any) => t.tenantId)).toEqual([owned, org, user]);
    expect(out.tenants[0]).toMatchObject({ role: "owner", state: "active", kind: "team", memberId: "m_0" });
  });

  it("re-verifies directory rows against the tenant — a stale owner row does not resolve", async () => {
    const user = `user_stale_${Date.now()}_${seq++}`;
    const demoted = `ft_demoted_${Date.now()}_${seq++}`;
    await seedTeamTenant(demoted, [
      { clerkUserId: "user_new_owner", email: "n@example.com", role: "owner", state: "active" },
      { clerkUserId: user, email: "s@example.com", role: "member", state: "active" },
    ]);
    await seedDirectory(user, [{ tenantId: demoted, role: "owner", state: "active" }]);
    const out = (await (await post("/api/user/sync", { tenant: user, kind: "user" }, { emails: [] })).json()) as any;
    expect(out.tenant).toBe(user);
    expect(out.tenants.map((t: any) => t.tenantId)).toEqual([user]);
  });
});

describe("/api/member-context — only the owner is a member", () => {
  it("keeps its response shape and answers null for a non-owner", async () => {
    const tenant = `ft_ctx_${Date.now()}_${seq++}`;
    await seedTeamTenant(tenant, [
      { clerkUserId: "user_ctx_owner", email: "owner@example.com", role: "owner", state: "active" },
      { clerkUserId: "user_ctx_admin", email: "admin@example.com", role: "admin", state: "active" },
    ]);
    const owner = (await (await post("/api/member-context", { tenant }, { clerkUserId: "user_ctx_owner" })).json()) as any;
    expect(owner.member).toEqual({ id: "m_0", role: "owner", state: "active", email: "owner@example.com" });
    expect(owner.tenantMeta).toMatchObject({ id: tenant, kind: "team" });
    const admin = (await (await post("/api/member-context", { tenant }, { clerkUserId: "user_ctx_admin" })).json()) as any;
    expect(admin.member).toBeNull();
  });

  it("bootstraps a personal tenant on first sign-in and reports needsBootstrap before", async () => {
    const user = `user_ctx_${Date.now()}_${seq++}`;
    const before = (await (await post("/api/member-context", { tenant: user }, { clerkUserId: user })).json()) as any;
    expect(before).toEqual({ member: null, tenantMeta: null, needsBootstrap: true });
    const after = (await (
      await post("/api/member-context", { tenant: user }, { clerkUserId: user, email: "me@example.com" })
    ).json()) as any;
    expect(after.member).toMatchObject({ role: "owner", state: "active", email: "me@example.com" });
  });
});

describe("retired hub surfaces", () => {
  it("answers the Aviary enrollment API with 410 on both its public and CLI paths", async () => {
    for (const path of ["/api/aviary/device/start", "/api/aviary/device/poll", "/api/cli/aviary/approve"]) {
      const res = await call(
        new Request(`http://${HOST}${path}`, { method: "POST", headers: { host: HOST }, body: "{}" }),
      );
      expect(res.status, path).toBe(410);
    }
  });

  it("no longer routes the team, sharing, login-wall and dead dashboard endpoints", async () => {
    const tenant = `ft_gone_${Date.now()}_${seq++}`;
    for (const [method, path] of [
      ["POST", "/api/sessions-revoke"],
      ["POST", "/api/portal-grant"],
      ["POST", "/api/members/invite"],
      ["POST", "/api/access/approve"],
      ["POST", "/api/access/request"],
      ["POST", "/api/access/status"],
      ["POST", "/api/access/revoke-grant"],
      ["GET", "/api/access"],
      ["POST", "/api/acl"],
      ["PUT", "/api/services/svc/auth"],
      ["PUT", "/api/services/svc/group"],
    ]) {
      const res = await call(
        new Request(`http://${HOST}${path}`, {
          method,
          headers: {
            host: HOST,
            "content-type": "application/json",
            "X-Finch-Service": SERVICE,
            "X-Finch-Auth": await signAssertion({ tenant, exp: nowSec() + 300 }, SERVICE),
          },
          body: method === "GET" ? undefined : "{}",
        }),
      );
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("has no /chat test interface any more", async () => {
    const res = await call(new Request(`http://${HOST}/chat`, { headers: { host: HOST } }));
    expect(res.status).not.toBe(200);
    expect(res.headers.get("content-type") || "").not.toContain("text/html");
  });
});
