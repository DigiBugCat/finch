import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { hashKey } from "../src/auth";

// Drive the REAL TenantDO op logic through its fetch() RPC — exactly how
// index.ts / api.ts call it (POST { op, ...args }). Each test names its own
// tenant id so the DOs (and their SQLite storage) are fully isolated.

let seq = 0;
function freshTenant() {
  return `t_${Date.now()}_${seq++}`;
}

async function op<T = any>(
  tenant: string,
  op: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const stub = env.TENANT.get(env.TENANT.idFromName(tenant));
  const res = await stub.fetch("https://tenant/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...args }),
  });
  return (await res.json()) as T;
}

describe("TenantDO.enroll — slug derivation + dedup", () => {
  it("derives a slug id from the name", async () => {
    const t = freshTenant();
    const r = await op<{ id: string }>(t, "enroll", { name: "Web Scraper" });
    expect(r.id).toBe("web-scraper");
  });

  it("dedups a repeated name with a -N suffix", async () => {
    const t = freshTenant();
    const a = await op<{ id: string }>(t, "enroll", { name: "Printer" });
    const b = await op<{ id: string }>(t, "enroll", { name: "Printer" });
    const c = await op<{ id: string }>(t, "enroll", { name: "Printer" });
    expect(a.id).toBe("printer");
    expect(b.id).toBe("printer-2");
    expect(c.id).toBe("printer-3");
  });

  it("falls back to 'service' for an empty/symbol-only name", async () => {
    const t = freshTenant();
    const r = await op<{ id: string }>(t, "enroll", { name: "!!!" });
    expect(r.id).toBe("service");
  });

  it("creates the service in 'invited' state with the default group", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Embeddings" });
    const state = await op<any>(t, "getState");
    const ap = state.services.find((a: any) => a.id === "embeddings");
    expect(ap).toBeTruthy();
    expect(ap.state).toBe("invited");
    expect(ap.group).toBe("default"); // default group
  });

  it("records an explicit group on the service without keeping a group list", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper", group: "Lab B" });
    const state = await op<any>(t, "getState");
    expect(state.services[0].group).toBe("Lab B");
    // Groups were ACL sources; there are none any more, stored or reported.
    expect(state).not.toHaveProperty("groups");
    expect(state).not.toHaveProperty("acl");
    expect(state).not.toHaveProperty("accessRequests");
  });
});

describe("TenantDO.registerBox — box state", () => {
  it("registers a new box as 'pending' when requireApproval (default)", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const r = await op<{ ok: boolean; state: string }>(t, "registerBox", {
      service: "scraper",
      box: "box-1",
      os: "linux",
      version: "1.4.0",
    });
    expect(r.ok).toBe(true);
    expect(r.state).toBe("pending");

    const state = await op<any>(t, "getState");
    const ap = state.services.find((a: any) => a.id === "scraper");
    expect(ap.boxes).toHaveLength(1);
    expect(ap.boxes[0].name).toBe("box-1");
    expect(ap.boxes[0].os).toBe("linux");
  });

  it("registers as 'chirping' when approval is not required", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "updateSetting", { key: "requireApproval", val: false });
    const r = await op<{ state: string }>(t, "registerBox", {
      service: "scraper",
      box: "box-1",
      os: "linux",
      version: "1.4.0",
    });
    expect(r.state).toBe("online");
  });

  it("auto-creates the service if it joins an unknown service id", async () => {
    const t = freshTenant();
    const r = await op<{ ok: boolean }>(t, "registerBox", {
      service: "ghost",
      box: "box-1",
      os: "darwin",
      version: "1.4.0",
    });
    expect(r.ok).toBe(true);
    const state = await op<any>(t, "getState");
    expect(state.services.some((a: any) => a.id === "ghost")).toBe(true);
  });

  it("refreshes (not duplicates) an existing box on re-join", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "registerBox", {
      service: "scraper",
      box: "box-1",
      os: "linux",
      version: "1.0.0",
    });
    await op(t, "registerBox", {
      service: "scraper",
      box: "box-1",
      os: "linux",
      version: "1.6.0",
    });
    const state = await op<any>(t, "getState");
    const ap = state.services.find((a: any) => a.id === "scraper");
    expect(ap.boxes).toHaveLength(1);
    expect(ap.boxes[0].version).toBe("1.6.0");
    expect(ap.boxes[0].outdated).toBe(false); // matches LATEST_AGENT
  });

  it("marks a box on an outdated agent version", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "registerBox", {
      service: "scraper",
      box: "old-box",
      os: "linux",
      version: "0.9.0",
    });
    const state = await op<any>(t, "getState");
    const ap = state.services.find((a: any) => a.id === "scraper");
    expect(ap.boxes[0].outdated).toBe(true);
  });
});

describe("TenantDO.checkKey — scope gate (structured)", () => {
  // A key is allowed iff it exists, has not expired, and its scope covers the
  // service. Scope is STRUCTURED: {all:true} | {services:[...]}; magic strings/CSV
  // are gone (security M2). mintKey validates every listed service id exists.
  async function mint(
    t: string,
    label: string,
    scope?: unknown,
  ): Promise<string> {
    const r = await op<{ plaintext: string }>(t, "mintKey", { label, scope });
    return r.plaintext;
  }

  it("denies an unknown key hash with reason 'no-key'", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const r = await op<{ allowed: boolean; reason: string }>(t, "checkKey", {
      hash: await hashKey("finch_does_not_exist"),
      service: "scraper",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("no-key");
  });

  it("allows an {all:true} scoped key (owner ACL passes)", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const key = await mint(t, "wide", { all: true });
    const r = await op<{ allowed: boolean }>(t, "checkKey", {
      hash: await hashKey(key),
      service: "scraper",
    });
    expect(r.allowed).toBe(true);
  });

  it("defaults to LEAST-PRIVILEGE (empty scope) — denies with reason 'scope'", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const key = await mint(t, "bare"); // no scope → reaches nothing
    const r = await op<{ allowed: boolean; reason: string }>(t, "checkKey", {
      hash: await hashKey(key),
      service: "scraper",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("scope");
  });

  it("denies with reason 'scope' when the service is not in the list", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "enroll", { name: "Printer" });
    const key = await mint(t, "narrow", { services: ["printer"] });
    const r = await op<{ allowed: boolean; reason: string }>(t, "checkKey", {
      hash: await hashKey(key),
      service: "scraper",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("scope");
  });

  it("allows an service list that includes the target", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "enroll", { name: "Printer" });
    const key = await mint(t, "list", { services: ["printer", "scraper"] });
    const r = await op<{ allowed: boolean }>(t, "checkKey", {
      hash: await hashKey(key),
      service: "scraper",
    });
    expect(r.allowed).toBe(true);
  });

  it("rejects minting a key scoped to an UNKNOWN service id (400)", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const r = await op<{ error?: string; plaintext?: string }>(t, "mintKey", {
      label: "bad-scope",
      scope: { services: ["ghost"] },
    });
    expect(r.plaintext).toBeUndefined();
    expect(r.error).toMatch(/unknown service/i);
  });
});

describe("TenantDO.checkKey — no ACL layer", () => {
  async function allowed(t: string, plaintext: string, service = "scraper") {
    return op<{ allowed: boolean; reason?: string }>(t, "checkKey", {
      hash: await hashKey(plaintext),
      service,
    });
  }

  it("admits a scoped key on scope alone: tags, groups and stored rules play no part", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper", group: "lab" });
    await op(t, "setTags", { id: "scraper", tags: ["prod"] });
    const { plaintext } = await op<{ plaintext: string }>(t, "mintKey", {
      label: "k",
      scope: { services: ["scraper"] },
    });
    expect(await allowed(t, plaintext)).toMatchObject({ allowed: true });
  });

  it("denies a key for a service that does not exist, even with {all:true}", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const { plaintext } = await op<{ plaintext: string }>(t, "mintKey", { label: "wide", scope: { all: true } });
    expect(await allowed(t, plaintext, "nope")).toEqual({
      allowed: false,
      keyLabel: "wide",
      reason: "no-service",
    });
  });

  it("denies an empty hash rather than matching a key", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "mintKey", { label: "wide", scope: { all: true } });
    const r = await op<any>(t, "checkKey", { hash: "", service: "scraper" });
    expect(r).toMatchObject({ allowed: false, reason: "no-key" });
  });

  it("stops admitting a key the moment it is revoked", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const minted = await op<{ plaintext: string; key: { id: string } }>(t, "mintKey", {
      label: "short-lived",
      scope: { all: true },
    });
    expect((await allowed(t, minted.plaintext)).allowed).toBe(true);
    expect(await op(t, "revokeBoxKey", { service: "", box: "", key: minted.key.id })).toEqual({ ok: true });
    expect(await allowed(t, minted.plaintext)).toMatchObject({ allowed: false, reason: "no-key" });
  });

  it("labels every key with the tenant owner, whatever owner the caller names", async () => {
    const t = `user_${freshTenant()}`;
    await op(t, "enroll", { name: "Scraper" });
    const before = await op<any>(t, "mintKey", { label: "pre", scope: { all: true }, owner: "mallory" });
    expect(before.key.owner).toBe("you");
    await op(t, "memberContext", { clerkUserId: t, email: "Me@Example.com" });
    const after = await op<any>(t, "mintKey", { label: "post", scope: { all: true }, owner: "mallory" });
    expect(after.key.owner).toBe("me@example.com");
    // Bootstrap rewrote the placeholder on the earlier key too.
    const owners = (await op<any>(t, "getState")).keys.map((k: any) => k.owner);
    expect(owners).toEqual(["me@example.com", "me@example.com"]);
  });
});

describe("TenantDO.claimTicket — single-use jti (M1 replay protection)", () => {
  it("burns a jti once: first claim ok, replay rejected", async () => {
    const t = freshTenant();
    const exp = Math.floor(Date.now() / 1000) + 900;
    const first = await op<{ ok: boolean }>(t, "claimTicket", {
      jti: "jti-abc",
      exp,
    });
    const second = await op<{ ok: boolean }>(t, "claimTicket", {
      jti: "jti-abc",
      exp,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("allows distinct jtis independently", async () => {
    const t = freshTenant();
    const exp = Math.floor(Date.now() / 1000) + 900;
    expect((await op<{ ok: boolean }>(t, "claimTicket", { jti: "a", exp })).ok).toBe(true);
    expect((await op<{ ok: boolean }>(t, "claimTicket", { jti: "b", exp })).ok).toBe(true);
  });

  it("legacy ticket (no jti) is allowed through (exp still bounds it)", async () => {
    const t = freshTenant();
    expect((await op<{ ok: boolean }>(t, "claimTicket", {})).ok).toBe(true);
  });
});

describe("TenantDO.checkKey — expiry gate (#11)", () => {
  it("ignores expiry when enforceExpiry is OFF (default)", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    // keyExpiry default "90 days" stamps an expiresAt; enforce is off by default.
    const r = await op<{ plaintext: string }>(t, "mintKey", {
      label: "k",
      scope: { all: true },
    });
    const chk = await op<{ allowed: boolean }>(t, "checkKey", {
      hash: await hashKey(r.plaintext),
      service: "scraper",
    });
    expect(chk.allowed).toBe(true);
  });

  it("a 'never'-expiry key stays valid even with enforceExpiry ON", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    // keyExpiry "never" → no expiresAt stamped; enforce on must not reject it
    // (no expiry to enforce). The time-based rejection path can't be exercised
    // without fast-forwarding the clock, but this proves the gate only fires when
    // an expiresAt exists.
    await op(t, "updateSetting", { key: "keyExpiry", val: "never" });
    await op(t, "updateSetting", { key: "enforceExpiry", val: true });
    const r = await op<{ plaintext: string }>(t, "mintKey", {
      label: "no-exp",
      scope: { all: true },
    });
    const chk = await op<{ allowed: boolean }>(t, "checkKey", {
      hash: await hashKey(r.plaintext),
      service: "scraper",
    });
    expect(chk.allowed).toBe(true);
  });

  it("stamps a future expiresAt from keyExpiry days at mint", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "updateSetting", { key: "keyExpiry", val: "30 days" });
    await op(t, "mintKey", { label: "exp30", scope: { all: true } });
    const state = await op<any>(t, "getState");
    const k = state.keys.find((kk: any) => kk.label === "exp30");
    expect(typeof k.expiresAt).toBe("number");
    expect(k.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("TenantDO.revokeBoxKey — revoke by id (#10)", () => {
  it("detaches a key from exactly one box without revoking it or its other assignments", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "enroll", { name: "Printer" });
    for (const [service, box] of [
      ["scraper", "scraper-a"],
      ["scraper", "scraper-b"],
      ["printer", "printer-a"],
    ]) {
      await op(t, "registerBox", {
        service,
        box,
        os: "linux",
        version: "1.4.0",
      });
    }
    const minted = await op<{ plaintext: string; key: { id: string } }>(
      t,
      "mintKey",
      { label: "live", scope: { all: true } },
    );

    const detached = await op<{ ok: boolean }>(t, "revokeBoxKey", {
      service: "scraper",
      box: "scraper-a",
      key: minted.key.id,
    });
    expect(detached.ok).toBe(true);

    const state = await op<any>(t, "getState");
    const scraper = state.services.find((service: any) => service.id === "scraper");
    const printer = state.services.find((service: any) => service.id === "printer");
    expect(state.keys.map((key: any) => key.id)).toContain(minted.key.id);
    expect(scraper.keys).toContain(minted.key.id);
    expect(printer.keys).toContain(minted.key.id);
    expect(scraper.boxes.find((box: any) => box.name === "scraper-a").keys)
      .not.toContain(minted.key.id);
    expect(scraper.boxes.find((box: any) => box.name === "scraper-b").keys)
      .toContain(minted.key.id);
    expect(printer.boxes.find((box: any) => box.name === "printer-a").keys)
      .toContain(minted.key.id);

    const stillAuthorized = await op<{ allowed: boolean }>(t, "checkKey", {
      hash: await hashKey(minted.plaintext),
      service: "scraper",
    });
    expect(stillAuthorized.allowed).toBe(true);

    // A malformed half-scope is neither a box detach nor permission to widen
    // the operation into a tenant-global revoke.
    const partial = await op<{ ok: boolean }>(t, "revokeBoxKey", {
      service: "scraper",
      box: "",
      key: minted.key.id,
    });
    expect(partial.ok).toBe(false);
    expect((await op<any>(t, "getState")).keys.map((key: any) => key.id))
      .toContain(minted.key.id);
  });

  it("globally revokes only when scope is absent", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "registerBox", {
      service: "scraper",
      box: "box-a",
      os: "linux",
      version: "1.4.0",
    });
    const minted = await op<{ plaintext: string; key: { id: string } }>(t, "mintKey", {
      label: "global",
      scope: { all: true },
    });

    const revoked = await op<{ ok: boolean }>(t, "revokeBoxKey", {
      service: "",
      box: "",
      key: minted.key.id,
    });
    expect(revoked.ok).toBe(true);
    const state = await op<any>(t, "getState");
    const scraper = state.services.find((service: any) => service.id === "scraper");
    expect(state.keys.map((key: any) => key.id)).not.toContain(minted.key.id);
    expect(scraper.keys).not.toContain(minted.key.id);
    expect(scraper.boxes[0].keys).not.toContain(minted.key.id);
    const after = await op<{ allowed: boolean; reason?: string }>(t, "checkKey", {
      hash: await hashKey(minted.plaintext),
      service: "scraper",
    });
    expect(after).toMatchObject({ allowed: false, reason: "no-key" });
  });
});

describe("TenantDO.enroll — DNS-safe canonical id boundaries", () => {
  it("caps ids at 63 characters and keeps collision suffixes inside the cap", async () => {
    const t = freshTenant();
    const name63 = "a".repeat(63);
    const first = await op<{ id: string }>(t, "enroll", { name: name63 });
    const over = await op<{ id: string }>(t, "enroll", { name: `${name63}z` });
    const overAgain = await op<{ id: string }>(t, "enroll", { name: `${name63}other` });
    expect(first.id).toBe(name63);
    expect(over.id).toBe(`${"a".repeat(61)}-2`);
    expect(overAgain.id).toBe(`${"a".repeat(61)}-3`);
    for (const id of [first.id, over.id, overAgain.id]) {
      expect(id).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
      expect(id.length).toBeLessThanOrEqual(63);
    }
  });

  it("rejects a 64-character service id before registerBox can create it", async () => {
    const t = freshTenant();
    const boundary = "b".repeat(63);
    expect((await op<{ ok: boolean }>(t, "registerBox", {
      service: boundary,
      box: "box-63",
      os: "linux",
      version: "1.4.0",
    })).ok).toBe(true);

    const oversized = `${boundary}b`;
    expect(await op(t, "registerBox", {
      service: oversized,
      box: "box-64",
      os: "linux",
      version: "1.4.0",
    })).toEqual({ error: "invalid service id" });
    const state = await op<any>(t, "getState");
    expect(state.services.map((service: any) => service.id)).toContain(boundary);
    expect(state.services.map((service: any) => service.id)).not.toContain(oversized);
  });
});

describe("TenantDO.registerBox — re-join preserves approved state (#5)", () => {
  it("does NOT demote an approved+connected box to pending on re-join", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    // requireApproval default true → first join is pending.
    await op(t, "registerBox", {
      service: "scraper",
      box: "box-1",
      os: "linux",
      version: "1.4.0",
    });
    await op(t, "approve", { id: "scraper" });
    await op(t, "markBox", {
      service: "scraper",
      box: "box-1",
      connected: true,
    });
    // Agent restart re-joins the SAME box.
    const rj = await op<{ ok: boolean; state: string }>(t, "registerBox", {
      service: "scraper",
      box: "box-1",
      os: "linux",
      version: "1.4.0",
    });
    expect(rj.state).not.toBe("pending"); // not demoted
    const state = await op<any>(t, "getState");
    const m = state.boxes.find((mm: any) => mm.name === "box-1");
    expect(m.state).not.toBe("pending");
  });
});

describe("TenantDO.approve — derives liveness from connected (#12)", () => {
  it("an approved-but-disconnected box reads resting, not chirping", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "registerBox", {
      service: "scraper",
      box: "box-1",
      os: "linux",
      version: "1.4.0",
    });
    // Approve WITHOUT ever connecting.
    await op(t, "approve", { id: "scraper" });
    const state = await op<any>(t, "getState");
    const m = state.boxes.find((mm: any) => mm.name === "box-1");
    expect(m.state).toBe("offline"); // not "online"
  });
});

// Single-user tenancy: a tenant is one Clerk user. Its id is their Clerk user
// id, and that user — as its owner — is the only human principal.
describe("TenantDO — single-user owner gates", () => {
  it("memberContext bootstraps the tenant's own user as its owner from an email", async () => {
    const t = `user_${freshTenant()}`;
    expect(await op<any>(t, "memberContext", { clerkUserId: t })).toEqual({
      member: null,
      tenantMeta: null,
      needsBootstrap: true,
    });
    const boot = await op<any>(t, "memberContext", { clerkUserId: t, email: "Me@Example.com" });
    expect(boot.member).toMatchObject({ role: "owner", state: "active", email: "me@example.com" });
    expect(boot.tenantMeta).toMatchObject({ kind: "personal", id: t });
    // Idempotent: the same owner row, and still exactly one member.
    const again = await op<any>(t, "memberContext", { clerkUserId: t, email: "other@example.com" });
    expect(again.member.id).toBe(boot.member.id);
    expect(again.member.email).toBe("me@example.com");
    expect((await op<any>(t, "getState")).members).toHaveLength(1);
  });

  it("memberContext never bootstraps or reports anyone else", async () => {
    const t = `user_${freshTenant()}`;
    for (const clerkUserId of ["user_intruder", "", undefined, 42]) {
      const out = await op<any>(t, "memberContext", { clerkUserId, email: "x@example.com" });
      expect(out).toEqual({ member: null, tenantMeta: null });
    }
    expect((await op<any>(t, "getState")).tenant).toBeUndefined();
    await op(t, "memberContext", { clerkUserId: t, email: "me@example.com" });
    // Once bootstrapped, another user still learns nothing about the tenant.
    expect(await op<any>(t, "memberContext", { clerkUserId: "user_intruder" })).toEqual({
      member: null,
      tenantMeta: null,
    });
  });

  it("gateOauth admits the tenant's own user and nobody else", async () => {
    const t = `user_${freshTenant()}`;
    await op(t, "enroll", { name: "Scraper" });
    expect(await op<any>(t, "gateOauth", { clerkUserId: t, service: "scraper" })).toEqual({ allowed: true });
    await op(t, "memberContext", { clerkUserId: t, email: "me@example.com" });
    expect(await op<any>(t, "gateOauth", { clerkUserId: t, service: "scraper" })).toEqual({ allowed: true });
    expect(await op<any>(t, "gateOauth", { clerkUserId: "user_other", service: "scraper" })).toEqual({ allowed: false });
    expect(await op<any>(t, "gateOauth", { service: "scraper" })).toEqual({ allowed: false });
  });

  it("gateOauth ignores organization claims entirely", async () => {
    const t = `org_${freshTenant()}`;
    await op(t, "enroll", { name: "Scraper" });
    const r = await op<any>(t, "gateOauth", {
      clerkUserId: "user_admin",
      service: "scraper",
      orgIdClaim: t,
      orgRole: "org:admin",
    });
    expect(r).toEqual({ allowed: false });
  });

  it("gateOauth lets anyone reach a public service", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Status" });
    await op(t, "setAuth", { service: "status", mode: "public" });
    expect(await op<any>(t, "gateOauth", { clerkUserId: "user_anyone", service: "status" })).toEqual({
      allowed: true,
      public: true,
    });
  });

  it("strips the svc subject from every log row on the way out", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "recordCall", { service: "scraper", box: "b1", route: "/mcp", status: 200, ms: 5, caller: "k" });
    const logs = (await op<any>(t, "getState")).logs;
    expect(logs.length).toBeGreaterThan(0);
    for (const entry of logs) expect(entry).not.toHaveProperty("svc");
  });

  it("no longer answers the retired team, sharing, org and Aviary ops", async () => {
    const t = freshTenant();
    for (const retired of [
      "inviteMember", "bindIdentity", "bootstrapMembers", "setMemberRole", "removeMember",
      "requestAccess", "approveAccess", "listAccess", "addAcl", "removeAcl", "removeUserGrant",
      "checkUserAccess", "gateBrowser", "sessionEpoch", "bumpSessionEpoch", "ensureOwner",
      "setGroup", "registerAviaryService", "legacyClaimStatus", "claimLegacyOrg", "holdings",
      "routeAllowed", "boxCredentialEpoch",
    ]) {
      const res = await env.TENANT.get(env.TENANT.idFromName(t)).fetch("https://tenant/op", {
        method: "POST",
        body: JSON.stringify({ op: retired }),
      });
      expect(res.status, retired).toBe(400);
    }
  });
});

describe("TenantDO.recordCall — metadata-only persistence", () => {
  it("drops request/response payload fields before public and raw durable state", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });

    const requestMarker = `PRIVATE_REQUEST_${crypto.randomUUID()}`;
    const responseMarker = `PRIVATE_RESPONSE_${crypto.randomUUID()}`;
    await op(t, "recordCall", {
      service: "scraper",
      box: "box-1",
      status: 201,
      ms: 37,
      caller: "privacy-test",
      route: "/mcp",
      // Deliberately emulate a future caller accidentally attaching payloads.
      // The recordCall boundary must select its six metadata fields and discard
      // every unknown property rather than spreading the RPC object into state.
      requestBody: requestMarker,
      responseBody: responseMarker,
      payload: { requestMarker, responseMarker },
      headers: { authorization: requestMarker },
    });

    const publicState = await op<any>(t, "getState");
    const service = publicState.services.find((item: any) => item.id === "scraper");
    expect(service.recentCalls).toHaveLength(1);
    expect(service.recentCalls[0]).toMatchObject({
      route: "/mcp",
      caller: "privacy-test",
      status: 201,
      ms: 37,
    });
    expect(Object.keys(service.recentCalls[0]).sort()).toEqual(
      ["ago", "caller", "ms", "route", "status", "ts"].sort(),
    );
    const requestLog = publicState.logs.find((item: any) => item.cat === "request");
    expect(Object.keys(requestLog).sort()).toEqual(
      ["action", "actor", "ago", "cat", "ip", "result", "target", "ts"].sort(),
    );
    expect(JSON.stringify(publicState)).not.toContain(requestMarker);
    expect(JSON.stringify(publicState)).not.toContain(responseMarker);

    // Inspect the real stored object too: getState is a projection and could
    // otherwise hide a payload that was still written to Durable Object state.
    const stub = env.TENANT.get(env.TENANT.idFromName(t));
    const runInDO = runInDurableObject as unknown as (
      target: typeof stub,
      callback: (instance: any) => unknown,
    ) => Promise<any>;
    const stored = await runInDO(stub, (instance) =>
      instance.ctx.storage.get("state"),
    );
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(requestMarker);
    expect(serialized).not.toContain(responseMarker);
  });
});

describe("TenantDO.boxExists — /refresh revocation gate", () => {
  it("returns true for a registered box, false otherwise", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "registerBox", {
      service: "scraper",
      box: "box-1",
      os: "linux",
      version: "1.4.0",
    });
    expect(await op<{ exists: boolean }>(t, "boxExists", { service: "scraper", box: "box-1" })).toEqual({ exists: true });
    expect(await op<{ exists: boolean }>(t, "boxExists", { service: "scraper", box: "ghost" })).toEqual({ exists: false });
    expect(await op<{ exists: boolean }>(t, "boxExists", { service: "nope", box: "box-1" })).toEqual({ exists: false });
  });

  // REGRESSION: updateSetting lowercased/trimmed the subdomain and handed it
  // straight to routerRegister. slugify() exists but was not applied here, and
  // router-do's isValidHostKey accepts ANY dotted name outside the
  // finchmcp.com/workers.dev families -- so a dotted value claimed an arbitrary
  // host key in the shared RouterDO, bypassing the vanity-tier gate and the
  // CF-for-SaaS provisioning that /api/hostnames performs. Registrations are
  // first-come and non-owners cannot unregister, so the squat was durable.
  it("rejects a dotted subdomain instead of registering a host key", async () => {
    const t = freshTenant();
    const before = await op<any>(t, "getState");
    for (const val of ["ops.aviary.run", "app.somecustomer.com", "a.b"]) {
      const res = await op<{ ok: boolean; error?: string }>(t, "updateSetting", {
        key: "subdomain",
        val,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("invalid subdomain");
    }
    // Nothing was persisted, and no dotted host was advertised.
    const after = await op<any>(t, "getState");
    expect(after.settings.subdomain).toBe(before.settings.subdomain);
    expect(after.host).toBe(before.host);
    expect(after.host).not.toContain("aviary.run");
  });

  it("still accepts a bare label subdomain", async () => {
    const t = freshTenant();
    const res = await op<{ ok: boolean }>(t, "updateSetting", {
      key: "subdomain",
      val: "  Demo-Team  ",
    });
    expect(res.ok).toBe(true);
    const state = await op<any>(t, "getState");
    expect(state.settings.subdomain).toBe("demo-team");
    expect(state.host).toBe("demo-team.finchmcp.com");
  });
});
