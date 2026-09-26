import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import worker from "../src/index";
import { hashKey, signAssertion } from "../src/auth";
import { SINGLE_USER_PURGE_VERSION } from "../src/tenant-do";

// SINGLE-USER TENANCY. A tenant is one Clerk user: its id is their Clerk user
// id and they are its only member. The first request a TenantDO serves after
// this ships purges what the retired team, sharing and Aviary features left
// behind (TenantDO.purgeLegacyTenancy), once.

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

async function post(path: string, tenant: string, body: unknown = {}) {
  return call(
    new Request(`http://${HOST}${path}`, {
      method: "POST",
      headers: {
        host: HOST,
        "content-type": "application/json",
        "X-Finch-Service": SERVICE,
        "X-Finch-Auth": await signAssertion({ tenant, exp: nowSec() + 300 }, SERVICE),
      },
      body: JSON.stringify(body),
    }),
  );
}

const stubFor = (tenant: string) => env.TENANT.get(env.TENANT.idFromName(tenant));

async function op<T = any>(tenant: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await stubFor(tenant).fetch("https://tenant/op", {
    method: "POST",
    body: JSON.stringify({ op: name, ...args }),
  });
  return (await res.json()) as T;
}

async function stored(tenant: string): Promise<any> {
  return runInDO(stubFor(tenant), (instance: any) => instance.ctx.storage.get("state"));
}

/** Forget that this instance already ran the purge, as a fresh instance
 *  (after eviction or a deploy) would; the stored flag then decides. */
async function restart(tenant: string): Promise<void> {
  await runInDO(stubFor(tenant), (instance: any) => {
    instance.purgeChecked = false;
  });
}

async function whoami(tenant: string, epoch: number): Promise<Response> {
  const token = await signAssertion({ tenant, exp: nowSec() + 300, kind: "cli", epoch }, SERVICE);
  return call(
    new Request(`http://${HOST}/api/cli/whoami`, {
      headers: { host: HOST, Authorization: `Bearer ${token}` },
    }),
  );
}

const key = (id: string, owner: string, services: string[] | "all" = "all") => ({
  id,
  label: `label-${id}`,
  owner,
  created: "2026-01-01",
  scope: services === "all" ? { all: true } : { services },
  hash: `hash-${id}`,
  last4: id.slice(-4),
});

const member = (i: number, tenantId: string, m: Record<string, unknown>) => ({
  id: `m_${i}`,
  tenantId,
  createdAt: 1_000 + i,
  updatedAt: 1_000 + i,
  ...m,
});

/** A stored record exactly as the team era left it: roster, invitations,
 *  groups, ACL rules, access requests, the login wall's session epoch, Aviary
 *  fields on a service and its box, and keys minted by several people. */
function teamEraState(tenant: string, extra: Record<string, unknown> = {}) {
  return {
    host: "",
    settings: { subdomain: "", requireApproval: true, defaultGroup: "default", keyExpiry: "never" },
    services: [
      {
        id: "scraper",
        label: "Scraper",
        state: "offline",
        group: "lab",
        tags: [],
        auth: "key",
        routes: ["/mcp", "/api/v1"],
        keys: ["k_owner", "k_admin", "k_you"],
        aviaryManaged: true,
        aviaryManifestSha256: "sha-manifest",
        aviaryApprovalNonce: "nonce-1",
        boxes: [
          {
            name: "box-1",
            state: "offline",
            keys: ["k_owner", "k_admin"],
            aviaryCredentialEpoch: 3,
            aviaryPendingCredentialEpoch: 4,
            aviaryPendingApprovalNonce: "nonce-2",
          },
        ],
        recentCalls: [],
      },
      { id: "notes", label: "Notes", state: "offline", group: "default", tags: [], auth: "key", routes: [], keys: ["k_you"], boxes: [], recentCalls: [] },
    ],
    keys: [key("k_owner", "Owner@Example.com"), key("k_admin", "admin@example.com"), key("k_you", "you")],
    groups: [{ name: "lab", members: ["owner@example.com", "admin@example.com"] }],
    acl: [
      { id: "r_owner", src: { type: "user", name: "owner@example.com" }, dst: [{ type: "all" }], action: "allow", locked: true },
      { id: "r_admin", src: { type: "user", name: "admin@example.com" }, dst: [{ type: "service", name: "scraper" }], action: "allow" },
    ],
    accessRequests: [
      { id: "ar_1", email: "friend@example.com", service: "scraper", requestedBy: "owner@example.com", status: "granted", created: 1 },
    ],
    sessionEpoch: 5,
    cliSingleUserCut: true,
    cliTokenEpoch: 2,
    usedTickets: {},
    logs: [
      { cat: "access", actor: "m_0", action: "invited member", target: "friend@example.com", ip: "", svc: "", ts: 7, ago: "" },
      { cat: "key", actor: "Admin@Example.com", action: "minted key", target: "label-k_admin", ip: "", svc: "", ts: 6, ago: "" },
      { cat: "admin", actor: "m_1", action: "changed setting", target: "keyExpiry → never", ip: "", svc: "", ts: 5, ago: "" },
      { cat: "key", actor: "owner@example.com", action: "minted key", target: "label-k_owner", ip: "", svc: "", ts: 4, ago: "" },
      { cat: "device", actor: "scraper", action: "came online", target: "box-1", ip: "", svc: "scraper", ts: 2, ago: "" },
      { cat: "access", actor: "m_0", action: "granted access", target: "friend@example.com", ip: "", svc: "scraper", ts: 1, ago: "" },
    ],
    tenantMeta: { id: tenant, kind: "personal", displayName: tenant, createdAt: 1, bootstrappedFrom: "legacy-personal", membershipVersion: 4 },
    members: [
      member(0, tenant, { clerkUserId: tenant, email: "owner@example.com", role: "owner", state: "active" }),
      member(1, tenant, { clerkUserId: "user_admin", email: "admin@example.com", role: "admin", state: "active" }),
      member(2, tenant, { clerkUserId: null, email: "friend@example.com", role: "member", state: "invited", invitedBy: "m_0" }),
    ],
    ...extra,
  };
}

/** Seed a stored record the way a pre-purge deploy left it (no flag). */
async function seed(tenant: string, state: Record<string, unknown>): Promise<void> {
  await runInDO(stubFor(tenant), async (instance: any) => {
    await instance.ctx.storage.put("state", state);
    instance.purgeChecked = false;
  });
}

describe("single-user purge — a tenant that had other members", () => {
  it("keeps only the owner, their keys and their fleet, and revokes every CLI token once", async () => {
    const t = `user_team_${++seq}`;
    await seed(t, teamEraState(t));

    // First access after deploy: the pre-purge CLI token (epoch 2) is dead.
    const stale = await whoami(t, 2);
    expect(stale.status).toBe(401);
    expect((await stale.json<any>()).error).toMatch(/revoked/);

    const s = await stored(t);
    expect(s.singleUserPurge).toBe(SINGLE_USER_PURGE_VERSION);
    expect(s.cliTokenEpoch).toBe(3); // bumped exactly once
    expect(s.members).toEqual([
      expect.objectContaining({ id: "m_0", clerkUserId: t, email: "owner@example.com", role: "owner", state: "active" }),
    ]);
    expect(s.members[0]).not.toHaveProperty("invitedBy");
    expect(s.tenantMeta).toMatchObject({ id: t, kind: "personal", membershipVersion: 1 });
    // The owner's key survives; the admin's and the ambiguous "you" key (minted
    // while others were members) are revoked and detached everywhere.
    expect(s.keys.map((k: any) => k.id)).toEqual(["k_owner"]);
    expect(s.services[0].keys).toEqual(["k_owner"]);
    expect(s.services[0].boxes[0].keys).toEqual(["k_owner"]);
    expect(s.services[1].keys).toEqual([]);
    // Every legacy field is gone.
    for (const field of ["groups", "acl", "accessRequests", "sessionEpoch", "cliSingleUserCut"]) {
      expect(s, field).not.toHaveProperty(field);
    }
    for (const field of ["aviaryManaged", "aviaryManifestSha256", "aviaryApprovalNonce"]) {
      expect(s.services[0], field).not.toHaveProperty(field);
    }
    expect(s.services[0].routes).toEqual([]); // the Aviary manifest's routes
    for (const field of ["aviaryCredentialEpoch", "aviaryPendingCredentialEpoch", "aviaryPendingApprovalNonce"]) {
      expect(s.services[0].boxes[0], field).not.toHaveProperty(field);
    }
    // Sharing audit rows and every row naming a non-owner member (by email,
    // case-insensitively, or member id) are deleted; the owner's and the
    // fleet's rows stay, plus one row recording the migration.
    expect(s.logs.map((l: any) => [l.cat, l.ts])).toEqual([
      ["key", expect.any(Number)],
      ["key", 4],
      ["device", 2],
    ]);
    expect(s.logs[0].action).toMatch(/revoked 2 key\(s\).*every CLI token/);
    expect(JSON.stringify(s)).not.toContain("friend@example.com");
    expect(JSON.stringify(s)).not.toContain("admin@example.com");

    // The owner's next `finch login` mints at the new epoch, which works.
    expect((await whoami(t, 3)).status).toBe(200);
    // The relay's key gate agrees: the admin's key is simply gone.
    expect(await op(t, "checkKey", { hash: "hash-k_admin", service: "scraper" })).toMatchObject({
      allowed: false,
      reason: "no-key",
    });
    expect(await op(t, "checkKey", { hash: "hash-k_owner", service: "scraper" })).toMatchObject({ allowed: true });
    // And only the owner resolves at sign-in.
    const ctx = await (await post("/api/member-context", t, { clerkUserId: t })).json<any>();
    expect(ctx.member).toEqual({ id: "m_0", role: "owner", state: "active", email: "owner@example.com" });
    const admin = await (await post("/api/member-context", t, { clerkUserId: "user_admin" })).json<any>();
    expect(admin.member).toBeNull();
  });

  it("is a no-op on every later access, including after a restart", async () => {
    const t = `user_again_${++seq}`;
    await seed(t, teamEraState(t));
    await op(t, "cliEpoch");
    const once = await stored(t);
    expect(once.cliTokenEpoch).toBe(3);

    await op(t, "cliEpoch");
    await restart(t);
    expect(await op(t, "cliEpoch")).toEqual({ epoch: 3 });
    await restart(t);
    await op(t, "getState");
    const later = await stored(t);
    expect(later.cliTokenEpoch).toBe(3);
    expect(later.members).toEqual(once.members);
    expect(later.keys).toEqual(once.keys);
    expect(later.logs.filter((l: any) => /single-user migration/.test(l.action))).toHaveLength(1);
  });

  it("restores a tenant's own user who had been demoted by a co-owner", async () => {
    const t = `user_demoted_${++seq}`;
    await seed(t, teamEraState(t, {
      members: [
        member(0, t, { clerkUserId: "user_coowner", email: "co@example.com", role: "owner", state: "active" }),
        member(1, t, { clerkUserId: t, email: "me@example.com", role: "member", state: "disabled", disabledAt: 5 }),
      ],
      keys: [key("k_me", "me@example.com"), key("k_co", "co@example.com")],
    }));
    const ctx = await (await post("/api/member-context", t, { clerkUserId: t })).json<any>();
    expect(ctx.member).toEqual({ id: "m_1", role: "owner", state: "active", email: "me@example.com" });
    const s = await stored(t);
    expect(s.members).toHaveLength(1);
    expect(s.members[0]).not.toHaveProperty("disabledAt");
    expect(s.keys.map((k: any) => k.id)).toEqual(["k_me"]);
    const co = await (await post("/api/member-context", t, { clerkUserId: "user_coowner" })).json<any>();
    expect(co.member).toBeNull();
  });
});

describe("single-user purge — tenants that are nobody's any more", () => {
  it("empties a team workspace: no members, no identity, no keys, no CLI tokens", async () => {
    const t = `ft_workspace_${++seq}`;
    await seed(t, teamEraState(t, {
      tenantMeta: { id: t, kind: "team", displayName: "Acme", createdAt: 1, bootstrappedFrom: "fresh", membershipVersion: 2 },
      members: [member(0, t, { clerkUserId: "user_creator", email: "owner@example.com", role: "owner", state: "active" })],
    }));
    await op(t, "getState");
    const s = await stored(t);
    expect(s.members).toEqual([]);
    expect(s.tenantMeta).toBeUndefined();
    expect(s.keys).toEqual([]);
    expect(s.cliTokenEpoch).toBe(3);
    // Its services and boxes stay (their hosts may still be registered), but
    // no one can sign in to it: it is no Clerk user's tenant.
    expect(s.services.map((x: any) => x.id)).toEqual(["scraper", "notes"]);
    const creator = await (await post("/api/member-context", t, { clerkUserId: "user_creator" })).json<any>();
    expect(creator).toEqual({ member: null, tenantMeta: null });
    expect(await op(t, "gateOauth", { clerkUserId: "user_creator", service: "scraper" })).toEqual({ allowed: false });
  });

  it("revokes an unclaimed Clerk-org tenant's keys and CLI tokens even with no member rows", async () => {
    const t = `org_unclaimed_${++seq}`;
    await seed(t, {
      host: "",
      services: [],
      keys: [key("k_you", "you")],
      logs: [],
      settings: {},
      cliTokenEpoch: 0,
      members: [],
    });
    expect((await whoami(t, 0)).status).toBe(401);
    const s = await stored(t);
    expect(s.keys).toEqual([]);
    expect(s.cliTokenEpoch).toBe(1);
  });
});

describe("single-user purge — a tenant only its owner ever used", () => {
  it("changes nothing but the flag", async () => {
    const t = `user_solo_${++seq}`;
    const before = {
      host: "solo.finchmcp.com",
      services: [
        { id: "notes", label: "Notes", state: "offline", group: "default", tags: [], auth: "key", routes: [], keys: ["k_1"], boxes: [{ name: "b", state: "offline", keys: ["k_1"] }], recentCalls: [] },
      ],
      keys: [key("k_1", "me@example.com", ["notes"])],
      logs: [{ cat: "device", actor: "notes", action: "joined", target: "b", ip: "", svc: "notes", ts: 1, ago: "" }],
      settings: { subdomain: "solo" },
      usedTickets: {},
      cliTokenEpoch: 4,
      tenantMeta: { id: t, kind: "personal", displayName: t, createdAt: 1, bootstrappedFrom: "legacy-personal", membershipVersion: 1 },
      members: [member(0, t, { clerkUserId: t, email: "me@example.com", role: "owner", state: "active", boundAt: 7 })],
    };
    await seed(t, before);
    expect((await whoami(t, 4)).status).toBe(200);
    const after = await stored(t);
    const { singleUserPurge, ...rest } = after;
    expect(singleUserPurge).toBe(SINGLE_USER_PURGE_VERSION);
    const expected = structuredClone(before) as any;
    // The owner row is re-written in its canonical shape, same values.
    expected.members[0].updatedAt = rest.members[0].updatedAt;
    expect(rest).toEqual(expected);
  });

  it("keeps an un-bootstrapped tenant's placeholder keys and CLI tokens (its user minted them)", async () => {
    const t = `user_fresh_${++seq}`;
    await seed(t, {
      host: "",
      services: [],
      keys: [key("k_you", "you")],
      groups: [{ name: "default", members: ["you"] }],
      acl: [{ id: "r_owner", src: { type: "user", name: "you" }, dst: [{ type: "all" }], action: "allow", locked: true }],
      logs: [],
      settings: {},
      cliTokenEpoch: 0,
      members: [],
    });
    expect((await whoami(t, 0)).status).toBe(200);
    const s = await stored(t);
    expect(s.keys.map((k: any) => k.id)).toEqual(["k_you"]);
    expect(s.cliTokenEpoch).toBe(0);
    expect(s).not.toHaveProperty("acl");
    expect(s).not.toHaveProperty("groups");
    expect(s.logs).toEqual([]); // nothing revoked, nothing to record
    // Bootstrapping later labels the key with the owner.
    await post("/api/member-context", t, { clerkUserId: t, email: "me@example.com" });
    expect((await stored(t)).keys[0].owner).toBe("me@example.com");
  });

  it("writes nothing for a tenant that has no stored state", async () => {
    const t = `user_none_${++seq}`;
    expect((await whoami(t, 0)).status).toBe(200);
    expect(await stored(t)).toBeUndefined();
  });

  it("is born flagged: a tenant created now is never purged", async () => {
    const t = `user_new_${++seq}`;
    await op(t, "enroll", { name: "Notes" });
    expect((await stored(t)).singleUserPurge).toBe(SINGLE_USER_PURGE_VERSION);
    const minted = await op<any>(t, "mintKey", { label: "k", scope: { all: true } });
    await restart(t);
    expect(await op(t, "checkKey", { hash: await hashKey(minted.plaintext), service: "notes" })).toMatchObject({
      allowed: true,
    });
  });
});

describe("/api/member-context — the tenant is the Clerk user", () => {
  it("bootstraps the tenant's own user on first sign-in and reports needsBootstrap before", async () => {
    const user = `user_ctx_${++seq}`;
    const before = (await (await post("/api/member-context", user, { clerkUserId: user })).json()) as any;
    expect(before).toEqual({ member: null, tenantMeta: null, needsBootstrap: true });
    const after = (await (
      await post("/api/member-context", user, { clerkUserId: user, email: "me@example.com" })
    ).json()) as any;
    expect(after.member).toMatchObject({ role: "owner", state: "active", email: "me@example.com" });
  });

  it("answers null for any other Clerk user, and never bootstraps for them", async () => {
    const user = `user_ctx_other_${++seq}`;
    const res = await post("/api/member-context", user, { clerkUserId: "user_someone", email: "x@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ member: null, tenantMeta: null });
    expect(await stored(user)).toBeUndefined();
  });
});

describe("retired hub surfaces", () => {
  it("no longer answers the Aviary enrollment API at all", async () => {
    for (const path of ["/api/aviary/device/start", "/api/aviary/device/poll", "/api/cli/aviary/approve"]) {
      const res = await call(
        new Request(`http://${HOST}${path}`, { method: "POST", headers: { host: HOST }, body: "{}" }),
      );
      // Unauthenticated: the ordinary control-plane / CLI-token refusal.
      expect(res.status, path).toBe(401);
    }
    const authed = await post("/api/aviary/device/start", `user_x_${++seq}`);
    expect(authed.status).toBe(404);
  });

  it("no longer routes the team, sharing, login-wall, owner-lookup and dead dashboard endpoints", async () => {
    const tenant = `user_gone_${++seq}`;
    for (const [method, path] of [
      ["POST", "/api/user/sync"],
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

  it("has no DirectoryDO or AviaryEnrollmentDO binding left", () => {
    expect((env as any).DIRECTORY).toBeUndefined();
    expect((env as any).AVIARY_ENROLLMENT).toBeUndefined();
  });
});
