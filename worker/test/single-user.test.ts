import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import worker from "../src/index";
import { signAssertion } from "../src/auth";

// SINGLE-USER TENANCY at the control API. A signed-in Clerk user acts on
// their personal tenant (their Clerk user id) or a tenant they OWN (a
// workspace, or a Clerk-org tenant claimed before the cut or at sign-in) —
// whichever one holds their fleet, never silently switching between two that
// both do. Pre-cut rosters, directory rows and invitations stay in storage,
// but only an owner resolves.

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

/** Give a tenant something its owner would lose track of: one service. */
async function populate(tenantId: string) {
  const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
  const res = await stub.fetch("https://tenant/op", {
    method: "POST",
    body: JSON.stringify({ op: "enroll", name: "Scraper" }),
  });
  expect(res.ok).toBe(true);
}

async function tenantState(tenantId: string): Promise<any> {
  return runInDO(env.TENANT.get(env.TENANT.idFromName(tenantId)), (instance: any) =>
    instance.ctx.storage.get("state"),
  );
}

async function directoryRows(clerkUserId: string): Promise<any[]> {
  return (
    (await runInDO(env.DIRECTORY.get(env.DIRECTORY.idFromName("global")), (instance: any) =>
      instance.ctx.storage.get(`u:${clerkUserId}`),
    )) ?? []
  );
}

describe("/api/user/sync — legacy Clerk-org tenants stay reachable for their owner", () => {
  it("claims an unmigrated org tenant that holds state for the org admin who signs in", async () => {
    const user = `user_orgadmin_${Date.now()}_${seq++}`;
    const org = `org_unclaimed_${Date.now()}_${seq++}`;
    await populate(org);
    const out = (await (await post("/api/user/sync", { tenant: user, kind: "user" }, {
      emails: ["admin@example.com"],
      primaryEmail: "admin@example.com",
      adminOrgIds: [org],
    })).json()) as any;
    expect(out.tenant).toBe(org);
    expect(out.claimable).toEqual([]);
    expect(out.tenants.map((t: any) => t.tenantId)).toEqual([org, user]);
    expect(out.tenants[0]).toMatchObject({ role: "owner", state: "active", kind: "team", email: "admin@example.com" });

    // A single owner row, the org recorded, nothing else in the tenant touched.
    const s = await tenantState(org);
    expect(s.tenantMeta).toMatchObject({ kind: "team", clerkOrgId: org, bootstrappedFrom: "legacy-org" });
    expect(s.members).toHaveLength(1);
    expect(s.services.map((x: any) => x.id)).toEqual(["scraper"]);
    expect(s.acl.find((r: any) => r.id === "r_owner").src).toEqual({ type: "user", name: "admin@example.com" });

    // Indexed, so it keeps resolving even when the web stops naming the org.
    expect((await directoryRows(user)).map((r: any) => r.tenantId)).toEqual([org]);
    const later = (await (await post("/api/user/sync", { tenant: user, kind: "user" }, { emails: [] })).json()) as any;
    expect(later.tenant).toBe(org);

    // A second admin of the same org does not take it over.
    const other = `user_orgadmin2_${Date.now()}_${seq++}`;
    const second = (await (await post("/api/user/sync", { tenant: other, kind: "user" }, {
      emails: ["two@example.com"],
      primaryEmail: "two@example.com",
      adminOrgIds: [org],
    })).json()) as any;
    expect(second.tenant).toBe(other);
    expect(second.tenants.map((t: any) => t.tenantId)).toEqual([other]);
    expect((await tenantState(org)).members).toHaveLength(1);
  });

  it("reports the org as claimable instead when no verified email is sent", async () => {
    const user = `user_noemail_${Date.now()}_${seq++}`;
    const org = `org_noemail_${Date.now()}_${seq++}`;
    await populate(org);
    const out = (await (await post("/api/user/sync", { tenant: user, kind: "user" }, {
      emails: [],
      adminOrgIds: [org],
    })).json()) as any;
    expect(out.claimable).toEqual([{ clerkOrgId: org }]);
    expect(out.tenant).toBe(user);
    expect((await tenantState(org)).tenantMeta).toBeUndefined();
  });

  it("never claims an empty org tenant or a non-org id", async () => {
    const user = `user_emptyorg_${Date.now()}_${seq++}`;
    const org = `org_empty_${Date.now()}_${seq++}`;
    const notOrg = `ft_notorg_${Date.now()}_${seq++}`;
    await populate(notOrg);
    const out = (await (await post("/api/user/sync", { tenant: user, kind: "user" }, {
      emails: ["e@example.com"],
      primaryEmail: "e@example.com",
      adminOrgIds: [org, notOrg, 42],
    })).json()) as any;
    expect(out.tenant).toBe(user);
    expect(out.claimable).toEqual([]);
    expect(out.tenants.map((t: any) => t.tenantId)).toEqual([user]);
    expect((await tenantState(notOrg)).tenantMeta).toBeUndefined();
  });
});

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

  it("lists every tenant the user OWNS — workspaces and claimed org tenants — not ones they merely joined", async () => {
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
    expect(out.tenants.map((t: any) => t.tenantId)).toEqual([owned, org, user]);
    expect(out.tenants[0]).toMatchObject({ role: "owner", state: "active", kind: "team", memberId: "m_0" });
    // None of them holds anything: the personal tenant, as before the cut.
    expect(out.tenant).toBe(user);
  });

  it("never switches a user away from a personal tenant that holds their fleet to an empty workspace", async () => {
    const user = `user_fleet_${Date.now()}_${seq++}`;
    const empty = `ft_empty_${Date.now()}_${seq++}`;
    await populate(user);
    await seedTeamTenant(empty, [{ clerkUserId: user, email: "f@example.com", role: "owner", state: "active" }]);
    await seedDirectory(user, [{ tenantId: empty, role: "owner", state: "active" }]);
    const out = (await (await post("/api/user/sync", { tenant: user, kind: "user" }, { emails: [] })).json()) as any;
    expect(out.tenant).toBe(user);
    expect(out.tenants.map((t: any) => t.tenantId)).toEqual([empty, user]);
  });

  it("picks the one owned workspace that holds state over an empty personal tenant", async () => {
    const user = `user_team_${Date.now()}_${seq++}`;
    const team = `ft_full_${Date.now()}_${seq++}`;
    const idle = `ft_idle_${Date.now()}_${seq++}`;
    await populate(team);
    await seedTeamTenant(team, [{ clerkUserId: user, email: "t@example.com", role: "owner", state: "active" }]);
    await seedTeamTenant(idle, [{ clerkUserId: user, email: "t@example.com", role: "owner", state: "active" }]);
    await seedDirectory(user, [
      { tenantId: idle, role: "owner", state: "active" },
      { tenantId: team, role: "owner", state: "active" },
    ]);
    const out = (await (await post("/api/user/sync", { tenant: user, kind: "user" }, { emails: [] })).json()) as any;
    expect(out.tenant).toBe(team);
  });

  it("refuses to pick (tenant: null) when more than one owned tenant holds state", async () => {
    const user = `user_both_${Date.now()}_${seq++}`;
    const team = `ft_both_${Date.now()}_${seq++}`;
    await populate(user);
    await populate(team);
    await seedTeamTenant(team, [{ clerkUserId: user, email: "b@example.com", role: "owner", state: "active" }]);
    await seedDirectory(user, [{ tenantId: team, role: "owner", state: "active" }]);
    const out = (await (await post("/api/user/sync", { tenant: user, kind: "user" }, { emails: [] })).json()) as any;
    expect(out.tenant).toBeNull();
    expect(out.tenants.map((t: any) => t.tenantId)).toEqual([team, user]);
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

  it("trusts the tenant, not the row — ownership a lagging row misses still resolves", async () => {
    const user = `user_lag_${Date.now()}_${seq++}`;
    const promoted = `ft_promoted_${Date.now()}_${seq++}`;
    await seedTeamTenant(promoted, [{ clerkUserId: user, email: "p@example.com", role: "owner", state: "active" }]);
    await seedDirectory(user, [{ tenantId: promoted, role: "admin", state: "active" }]);
    const out = (await (await post("/api/user/sync", { tenant: user, kind: "user" }, { emails: [] })).json()) as any;
    expect(out.tenants.map((t: any) => t.tenantId)).toEqual([promoted, user]);
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

describe("CLI tokens minted before the single-user cut", () => {
  /** Stored state as a pre-cut tenant left it: no cut flag, epoch 0. */
  async function seedPreCut(
    tenantId: string,
    kind: "personal" | "team",
    members: { clerkUserId: string | null; email: string; role: string; state: string }[],
  ) {
    const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
    await runInDO(stub, async (instance: any) => {
      const now = Date.now();
      await instance.ctx.storage.put("state", {
        host: "", services: [], keys: [], groups: [], accessRequests: [], logs: [],
        cliTokenEpoch: 0,
        tenantMeta: {
          id: tenantId, kind, displayName: tenantId, createdAt: now,
          bootstrappedFrom: "fresh", membershipVersion: 1,
        },
        members: members.map((m, i) => ({ id: `m_${i}`, tenantId, createdAt: now + i, updatedAt: now, ...m })),
      });
    });
    return stub;
  }

  async function whoami(tenant: string, epoch: number): Promise<Response> {
    const token = await signAssertion({ tenant, exp: nowSec() + 300, kind: "cli", epoch }, SERVICE);
    return call(
      new Request(`http://${HOST}/api/cli/whoami`, {
        headers: { host: HOST, Authorization: `Bearer ${token}` },
      }),
    );
  }

  /** The epoch after a restart: a new instance re-reads the flag from storage. */
  async function epochAfterRestart(stub: DurableObjectStub): Promise<number> {
    await runInDO(stub, (instance: any) => {
      instance.cliCutChecked = false;
    });
    const res = await stub.fetch("https://tenant/op", { method: "POST", body: JSON.stringify({ op: "cliEpoch" }) });
    return (await res.json<{ epoch: number }>()).epoch;
  }

  it("revokes every outstanding token of a team tenant once, on first access", async () => {
    const t = `ws_cli_team_${++seq}`;
    const stub = await seedPreCut(t, "team", [
      { clerkUserId: "user_cli_owner", email: "owner@x.test", role: "owner", state: "active" },
      { clerkUserId: "user_cli_admin", email: "admin@x.test", role: "admin", state: "active" },
    ]);
    const stale = await whoami(t, 0);
    expect(stale.status).toBe(401);
    expect((await stale.json<any>()).error).toMatch(/revoked/);
    // The owner's next `finch login` mints at the new epoch, which keeps working.
    expect((await whoami(t, 1)).status).toBe(200);
    expect((await whoami(t, 1)).status).toBe(200);
    expect(await epochAfterRestart(stub)).toBe(1);
    const s = await tenantState(t);
    expect(s.cliSingleUserCut).toBe(true);
    expect(s.logs.filter((l: any) => /single-user/.test(l.action))).toHaveLength(1);
  });

  it("also revokes when a personal tenant had another member who ever signed in", async () => {
    const t = `user_cli_shared_${++seq}`;
    const stub = await seedPreCut(t, "personal", [
      { clerkUserId: t, email: "me@x.test", role: "owner", state: "active" },
      { clerkUserId: "user_cli_former", email: "former@x.test", role: "member", state: "disabled" },
    ]);
    expect((await whoami(t, 0)).status).toBe(401);
    expect(await epochAfterRestart(stub)).toBe(1);
  });

  it("leaves a personal tenant with only its owner alone, so the owner's login keeps working", async () => {
    const t = `user_cli_solo_${++seq}`;
    const stub = await seedPreCut(t, "personal", [
      { clerkUserId: t, email: "me@x.test", role: "owner", state: "active" },
      // A pending invitation never had access; it does not count.
      { clerkUserId: null, email: "invitee@x.test", role: "member", state: "invited" },
    ]);
    expect((await whoami(t, 0)).status).toBe(200);
    expect((await whoami(t, 0)).status).toBe(200);
    expect(await epochAfterRestart(stub)).toBe(0);
    expect((await tenantState(t)).cliSingleUserCut).toBe(true);
  });

  it("writes nothing for a tenant that has no stored state", async () => {
    const t = `user_cli_none_${++seq}`;
    expect((await whoami(t, 0)).status).toBe(200);
    expect(await tenantState(t)).toBeUndefined();
  });
});
