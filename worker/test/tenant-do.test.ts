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

const runInDO = runInDurableObject as unknown as (
  target: DurableObjectStub,
  callback: (instance: any) => unknown,
) => Promise<any>;

/** Rewrite a tenant's STORED record directly. The ops that used to write
 *  ACL rules and member rosters were removed with the team features, but
 *  tenants created before the cut still carry that data and every gate must
 *  keep honoring (or ignoring) it correctly — so tests seed it here. */
async function seedState(t: string, mutate: (s: any) => void): Promise<void> {
  await op(t, "getState"); // materialize the stored record first
  await runInDO(env.TENANT.get(env.TENANT.idFromName(t)), async (instance: any) => {
    const s: any = await instance.ctx.storage.get("state");
    mutate(s);
    await instance.ctx.storage.put("state", s);
  });
}

/** Seed a pre-cut ACL allow rule (formerly written by the addAcl op). */
function addRule(t: string, src: unknown, dst: unknown[]): Promise<void> {
  return seedState(t, (s) => {
    s.acl.push({ id: "r_" + crypto.randomUUID().slice(0, 8), src, dst, action: "allow" });
  });
}

/** Seed a pre-cut TEAM tenant (formerly written by bootstrapMembers): tenant
 *  metadata plus a roster, with the locked owner rule pointed at the first
 *  owner the way bootstrap left it. */
function seedTeam(
  t: string,
  members: { clerkUserId: string | null; email: string; role: string; state: string }[],
): Promise<void> {
  return seedState(t, (s) => {
    const now = Date.now();
    s.tenantMeta = {
      id: t,
      kind: "team",
      displayName: "Fleet",
      createdAt: now,
      bootstrappedFrom: "fresh",
      membershipVersion: 1,
    };
    s.members = members.map((m, i) => ({
      id: `m_${i}`,
      tenantId: t,
      createdAt: now,
      updatedAt: now,
      ...m,
    }));
    const owner = members.find((m) => m.role === "owner" && m.state === "active");
    const rule = s.acl.find((r: any) => r.id === "r_owner");
    if (owner && rule) rule.src = { type: "user", name: owner.email };
  });
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

  it("honors an explicit group and creates the group", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper", group: "Lab B" });
    const state = await op<any>(t, "getState");
    expect(state.groups.some((g: any) => g.name === "Lab B")).toBe(true);
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
  // The owner rule (user:you -> all) is seeded fresh, and mintKey owner defaults
  // to "you", so a default key passes the ACL gate — letting us isolate scope.
  // Scope is now STRUCTURED: {all:true} | {services:[...]}; magic strings/CSV
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

describe("TenantDO.evalAccess — ACL matrix (default-deny)", () => {
  // The key gate still evaluates the tenant's stored ACL rules exactly as
  // before the single-user cut (no key gains or loses access). Rule-editing
  // ops are gone, so these tests seed rules straight into storage (addRule).
  // To isolate the ACL gate we always mint with scope "all services" (scope
  // passes) and a non-owner owner so the seeded owner rule (user:you) does NOT
  // auto-allow. Then we add specific allow rules and assert allow/deny.
  const ALICE = "alice";

  async function setup(t: string, opts?: { tags?: string[]; group?: string }) {
    await op(t, "enroll", { name: "Scraper", group: opts?.group });
    if (opts?.tags) await op(t, "setTags", { id: "scraper", tags: opts.tags });
  }

  async function mintNonOwner(t: string, label: string): Promise<string> {
    const r = await op<{ plaintext: string }>(t, "mintKey", {
      label,
      scope: { all: true }, // structured: scope passes, isolate the ACL gate
      owner: ALICE,
    });
    return r.plaintext;
  }

  async function allowed(
    t: string,
    keyPlain: string,
    service = "scraper",
  ): Promise<boolean> {
    const r = await op<{ allowed: boolean; reason?: string }>(t, "checkKey", {
      hash: await hashKey(keyPlain),
      service,
    });
    return r.allowed;
  }

  it("DENY by default: a non-owner key with no matching rule is blocked", async () => {
    const t = freshTenant();
    await setup(t);
    const key = await mintNonOwner(t, "k1");
    expect(await allowed(t, key)).toBe(false);
  });

  it("ALLOW via key rule: src key:<label> -> service", async () => {
    const t = freshTenant();
    await setup(t);
    const key = await mintNonOwner(t, "k-by-label");
    await addRule(t, { type: "key", name: "k-by-label" }, [{ type: "service", name: "scraper" }]);
    expect(await allowed(t, key)).toBe(true);
  });

  it("ALLOW via user rule: src user:<owner> -> service", async () => {
    const t = freshTenant();
    await setup(t);
    const key = await mintNonOwner(t, "k-user");
    await addRule(t, { type: "user", name: ALICE }, [{ type: "service", name: "scraper" }]);
    expect(await allowed(t, key)).toBe(true);
  });

  it("ALLOW via group rule: key is a member of the src group -> service", async () => {
    const t = freshTenant();
    // enroll auto-creates the group "lab" with member ["you"]. keyIdentities
    // adds a group to the key's identities when the key's LABEL is a member of
    // that group — so a key LABELED "you" presents as a member of "lab" even
    // though its owner ("alice") is not. That isolates the GROUP src path from
    // the seeded user:you owner rule (which matches on owner, not label).
    await setup(t, { group: "lab" });
    const key = await mintNonOwner(t, "you"); // label "you", owner "alice"
    await addRule(t, { type: "group", name: "lab" }, [{ type: "service", name: "scraper" }]);
    expect(await allowed(t, key)).toBe(true);
  });

  it("DENY group rule: a key in no matching group is blocked", async () => {
    const t = freshTenant();
    await setup(t, { group: "lab" });
    const key = await mintNonOwner(t, "k-not-in-group"); // not a member of "lab"
    await addRule(t, { type: "group", name: "lab" }, [{ type: "service", name: "scraper" }]);
    expect(await allowed(t, key)).toBe(false);
  });

  it("ALLOW via tag rule: src key -> tag matches an service tag", async () => {
    const t = freshTenant();
    await setup(t, { tags: ["prod", "scrapers"] });
    const key = await mintNonOwner(t, "k-tag");
    await addRule(t, { type: "key", name: "k-tag" }, [{ type: "tag", name: "prod" }]);
    expect(await allowed(t, key)).toBe(true);
  });

  it("ALLOW via service-group rule: src key -> group matches", async () => {
    const t = freshTenant();
    await setup(t, { group: "homelab" });
    const key = await mintNonOwner(t, "k-applgroup");
    await addRule(t, { type: "key", name: "k-applgroup" }, [{ type: "group", name: "homelab" }]);
    expect(await allowed(t, key)).toBe(true);
  });

  it("ALLOW via src:all -> any matching dst", async () => {
    const t = freshTenant();
    await setup(t, { tags: ["x"] });
    const key = await mintNonOwner(t, "k-all-src");
    await addRule(t, { type: "all" }, [{ type: "tag", name: "x" }]);
    expect(await allowed(t, key)).toBe(true);
  });

  it("ALLOW via dst:all (owner-style blanket) for the seeded owner key", async () => {
    const t = freshTenant();
    await setup(t);
    // The default 'you' owner: mint with default owner so it matches user:you.
    const r = await op<{ plaintext: string }>(t, "mintKey", {
      label: "owner-key",
      scope: { all: true },
    });
    expect(await allowed(t, r.plaintext)).toBe(true);
  });

  it("DENY when the allow rule targets a DIFFERENT service", async () => {
    const t = freshTenant();
    await setup(t);
    await op(t, "enroll", { name: "Printer" });
    const key = await mintNonOwner(t, "k-wrong-dst");
    await addRule(t, { type: "key", name: "k-wrong-dst" }, [{ type: "service", name: "printer" }]); // not scraper
    expect(await allowed(t, key, "scraper")).toBe(false);
    expect(await allowed(t, key, "printer")).toBe(true);
  });

  it("DENY when the src does not match (rule for a different key label)", async () => {
    const t = freshTenant();
    await setup(t);
    const key = await mintNonOwner(t, "k-real");
    await addRule(t, { type: "key", name: "some-other-key" }, [{ type: "service", name: "scraper" }]);
    expect(await allowed(t, key)).toBe(false);
  });

  it("DENY when the service does not exist (evalAccess returns false)", async () => {
    const t = freshTenant();
    await setup(t);
    const key = await mintNonOwner(t, "k-ghost-dst");
    await addRule(t, { type: "key", name: "k-ghost-dst" }, [{ type: "all" }]);
    // service "nope" doesn't exist -> evalAccess findService fails -> deny.
    expect(await allowed(t, key, "nope")).toBe(false);
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

// Single-user tenancy: the tenant OWNER is the only human principal. These
// gates run on tenants that may still carry a pre-cut team roster, invites or
// access-request rows — none of which may authorize anyone.
describe("TenantDO — single-user owner gates", () => {
  it("memberContext bootstraps a personal tenant's owner from an email", async () => {
    const t = `user_${freshTenant()}`;
    expect(await op<any>(t, "memberContext", { clerkUserId: t })).toEqual({
      member: null,
      tenantMeta: null,
      needsBootstrap: true,
    });
    const boot = await op<any>(t, "memberContext", { clerkUserId: t, email: "Me@Example.com" });
    expect(boot.member).toMatchObject({ role: "owner", state: "active", email: "me@example.com" });
    expect(boot.tenantMeta).toMatchObject({ kind: "personal", id: t });
    // Idempotent, and the placeholder owner rule now names the owner.
    const again = await op<any>(t, "memberContext", { clerkUserId: t, email: "me@example.com" });
    expect(again.member.id).toBe(boot.member.id);
    const rule = (await op<any>(t, "getState")).acl.find((r: any) => r.id === "r_owner");
    expect(rule.src.name).toBe("me@example.com");
  });

  it("memberContext never bootstraps someone else's personal tenant", async () => {
    const t = `user_${freshTenant()}`;
    const out = await op<any>(t, "memberContext", { clerkUserId: "user_intruder", email: "x@example.com" });
    expect(out.member).toBeNull();
    expect((await op<any>(t, "getState")).tenant).toBeUndefined();
  });

  it("memberContext reports ONLY the owner of a legacy team tenant", async () => {
    const t = freshTenant();
    await seedTeam(t, [
      { clerkUserId: "u_owner", email: "owner@example.com", role: "owner", state: "active" },
      { clerkUserId: "u_admin", email: "admin@example.com", role: "admin", state: "active" },
      { clerkUserId: "u_member", email: "member@example.com", role: "member", state: "active" },
    ]);
    const owner = await op<any>(t, "memberContext", { clerkUserId: "u_owner" });
    expect(owner.member).toMatchObject({ role: "owner", state: "active", email: "owner@example.com" });
    expect(owner.tenantMeta).toMatchObject({ kind: "team" });
    for (const uid of ["u_admin", "u_member", "u_stranger"]) {
      expect((await op<any>(t, "memberContext", { clerkUserId: uid })).member).toBeNull();
    }
  });

  it("gateOauth admits the personal tenant's own user and nobody else", async () => {
    const t = `user_${freshTenant()}`;
    await op(t, "enroll", { name: "Scraper" });
    expect(await op<any>(t, "gateOauth", { clerkUserId: t, service: "scraper" })).toEqual({ allowed: true });
    expect(await op<any>(t, "gateOauth", { clerkUserId: "user_other", service: "scraper" })).toEqual({ allowed: false });
    expect(await op<any>(t, "gateOauth", { service: "scraper" })).toEqual({ allowed: false });
  });

  it("gateOauth admits a team tenant's active owner only — not admins, members or grants", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await seedTeam(t, [
      { clerkUserId: "u_owner", email: "owner@example.com", role: "owner", state: "active" },
      { clerkUserId: "u_gone", email: "gone@example.com", role: "owner", state: "disabled" },
      { clerkUserId: "u_admin", email: "admin@example.com", role: "admin", state: "active" },
      { clerkUserId: "u_member", email: "member@example.com", role: "member", state: "active" },
    ]);
    // A pre-cut per-user grant for the member must not open the door.
    await addRule(t, { type: "user", name: "member@example.com" }, [{ type: "service", name: "scraper" }]);
    const gate = async (clerkUserId: string) =>
      (await op<any>(t, "gateOauth", { clerkUserId, service: "scraper" })).allowed;
    expect(await gate("u_owner")).toBe(true);
    expect(await gate("u_gone")).toBe(false);
    expect(await gate("u_admin")).toBe(false);
    expect(await gate("u_member")).toBe(false);
    // The tenant id itself is not an identity once the tenant has an owner row.
    expect(await gate(t)).toBe(false);
  });

  it("honours ONE owner of a pre-cut multi-owner team: the one the owner rule names", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await seedTeam(t, [
      { clerkUserId: "u_first", email: "first@example.com", role: "owner", state: "active" },
      { clerkUserId: "u_second", email: "second@example.com", role: "owner", state: "active" },
    ]);
    const gate = async (clerkUserId: string) =>
      (await op<any>(t, "gateOauth", { clerkUserId, service: "scraper" })).allowed;
    // seedTeam points r_owner at the first owner.
    expect(await gate("u_first")).toBe(true);
    expect(await gate("u_second")).toBe(false);
    expect((await op<any>(t, "memberContext", { clerkUserId: "u_second" })).member).toBeNull();
    // Re-point the owner rule and the principal follows it.
    await seedState(t, (s) => {
      s.acl.find((r: any) => r.id === "r_owner").src = { type: "user", name: "second@example.com" };
    });
    expect(await gate("u_first")).toBe(false);
    expect(await gate("u_second")).toBe(true);
    expect((await op<any>(t, "memberContext", { clerkUserId: "u_second" })).member).toMatchObject({
      role: "owner",
      email: "second@example.com",
    });
  });

  it("gateOauth admits an org-admin token to its own UNCLAIMED legacy org tenant only", async () => {
    const t = `org_${freshTenant()}`;
    await op(t, "enroll", { name: "Scraper" });
    const gate = async (args: Record<string, unknown>) =>
      (await op<any>(t, "gateOauth", { clerkUserId: "u_admin", service: "scraper", ...args })).allowed;
    expect(await gate({ orgIdClaim: t, orgRole: "org:admin" })).toBe(true);
    expect(await gate({ orgIdClaim: t, orgRole: "admin" })).toBe(true);
    expect(await gate({ orgIdClaim: t, orgRole: "org:member" })).toBe(false);
    expect(await gate({ orgIdClaim: t })).toBe(false);
    expect(await gate({ orgIdClaim: "org_other", orgRole: "org:admin" })).toBe(false);

    // Once claimed, only the claimant passes; the org claim no longer does.
    const claimed = await op<any>(t, "claimLegacyOrg", { clerkOrgId: t, clerkUserId: "u_admin", email: "A@example.com" });
    expect(claimed.member).toMatchObject({ role: "owner", state: "active", email: "a@example.com" });
    expect(await gate({})).toBe(true);
    expect(
      (await op<any>(t, "gateOauth", { clerkUserId: "u_admin2", service: "scraper", orgIdClaim: t, orgRole: "org:admin" }))
        .allowed,
    ).toBe(false);
  });

  it("claimLegacyOrg is idempotent for its owner and refuses everyone and everything else", async () => {
    const t = `org_${freshTenant()}`;
    const claim = async (args: Record<string, unknown>) => {
      const stub = env.TENANT.get(env.TENANT.idFromName(t));
      const res = await stub.fetch("https://tenant/op", {
        method: "POST",
        body: JSON.stringify({ op: "claimLegacyOrg", clerkOrgId: t, clerkUserId: "u_a", email: "a@example.com", ...args }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await claim({})).status).toBe(409); // empty: nothing to claim
    await op(t, "enroll", { name: "Scraper" });
    expect((await claim({ clerkOrgId: "org_elsewhere" })).status).toBe(400);
    expect((await claim({ email: "" })).status).toBe(400);
    const first = await claim({});
    expect(first.status).toBe(200);
    const again = await claim({});
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ already: true, member: { id: first.body.member.id } });
    expect((await claim({ clerkUserId: "u_b", email: "b@example.com" })).status).toBe(409);
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

  it("keeps pre-cut team data in storage and in the state snapshot", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await seedTeam(t, [
      { clerkUserId: "u_owner", email: "owner@example.com", role: "owner", state: "active" },
      { clerkUserId: null, email: "invitee@example.com", role: "member", state: "invited" },
    ]);
    await seedState(t, (s) => {
      s.accessRequests.push({
        id: "ar_legacy",
        email: "invitee@example.com",
        service: "scraper",
        requestedBy: "owner@example.com",
        status: "invited",
        created: Date.now(),
      });
    });
    // Any mutation re-saves the whole record; nothing may be dropped.
    await op(t, "setTags", { id: "scraper", tags: ["ops"] });
    const state = await op<any>(t, "getState");
    expect(state.members.map((m: any) => m.email)).toEqual(["owner@example.com", "invitee@example.com"]);
    expect(state.accessRequests.map((r: any) => r.id)).toEqual(["ar_legacy"]);
    expect(state.viewerScoped).toBeUndefined();
  });

  it("strips the svc subject from every log row on the way out", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "recordCall", { service: "scraper", box: "b1", route: "/mcp", status: 200, ms: 5, caller: "k" });
    const logs = (await op<any>(t, "getState")).logs;
    expect(logs.length).toBeGreaterThan(0);
    for (const entry of logs) expect(entry).not.toHaveProperty("svc");
  });

  it("no longer answers the retired team, sharing and login-wall ops", async () => {
    const t = freshTenant();
    for (const retired of [
      "inviteMember", "bindIdentity", "bootstrapMembers", "setMemberRole", "removeMember",
      "requestAccess", "approveAccess", "listAccess", "addAcl", "removeAcl", "removeUserGrant",
      "checkUserAccess", "gateBrowser", "sessionEpoch", "bumpSessionEpoch", "ensureOwner",
      "setGroup", "registerAviaryService", "legacyClaimStatus",
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

// REGRESSION (P1, Codex round 4): a locked owner rule stranded on someone who
// is no longer an active owner (the demotion happened under older code) must
// be repaired on load, or that person's keys keep reaching every service.
describe("TenantDO — repairing state that predates the fix", () => {
  const reachesWithKeyOwnedBy = async (t: string, owner: string) => {
    const minted = await op<{ plaintext: string }>(t, "mintKey", {
      label: `k-${owner}`,
      scope: { all: true },
      owner,
    });
    return (await op<any>(t, "checkKey", { hash: await hashKey(minted.plaintext), service: "scraper" })).allowed;
  };

  it("moves a locked owner grant already stranded on a non-owner", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await seedTeam(t, [
      { clerkUserId: "u_owner", email: "owner@example.com", role: "owner", state: "active" },
      { clerkUserId: "u_second", email: "second@example.com", role: "owner", state: "active" },
    ]);

    // Exactly what a pre-upgrade DO holds: the demotion already happened under
    // the old code, so the locked rule still names the demoted member and no
    // future transition will ever revisit it.
    await seedState(t, (s) => {
      s.members.find((m: any) => m.email === "owner@example.com").role = "member";
    });

    // load() normalizes in memory, so the very first read after deploy is
    // already correct -- no migration, and the key gate sees it immediately.
    expect(await reachesWithKeyOwnedBy(t, "owner@example.com")).toBe(false);
    expect(await reachesWithKeyOwnedBy(t, "second@example.com")).toBe(true);
    const locked = (await op<any>(t, "getState")).acl.find((r: any) => r.id === "r_owner");
    expect(locked.src.name).toBe("second@example.com");
  });

  it("leaves the locked grant alone when no active owner remains", async () => {
    // The rule is the lockout backstop. With no heir, a stale grant beats an
    // unreachable tenant -- and a pre-bootstrap tenant still carries the "you"
    // placeholder, which must survive untouched.
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const fresh = (await op<any>(t, "getState")).acl.find((r: any) => r.id === "r_owner");
    expect(fresh.src.name).toBe("you");
  });

});
