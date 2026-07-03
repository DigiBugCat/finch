import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
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

  it("falls back to 'appliance' for an empty/symbol-only name", async () => {
    const t = freshTenant();
    const r = await op<{ id: string }>(t, "enroll", { name: "!!!" });
    expect(r.id).toBe("appliance");
  });

  it("creates the appliance in 'invited' state with the default group", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Embeddings" });
    const state = await op<any>(t, "getState");
    const ap = state.appliances.find((a: any) => a.id === "embeddings");
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

describe("TenantDO.registerMachine — machine state", () => {
  it("registers a new machine as 'pending' when requireApproval (default)", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const r = await op<{ ok: boolean; state: string }>(t, "registerMachine", {
      appliance: "scraper",
      machine: "box-1",
      os: "linux",
      version: "1.4.0",
    });
    expect(r.ok).toBe(true);
    expect(r.state).toBe("pending");

    const state = await op<any>(t, "getState");
    const ap = state.appliances.find((a: any) => a.id === "scraper");
    expect(ap.machines).toHaveLength(1);
    expect(ap.machines[0].name).toBe("box-1");
    expect(ap.machines[0].os).toBe("linux");
  });

  it("registers as 'chirping' when approval is not required", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "updateSetting", { key: "requireApproval", val: false });
    const r = await op<{ state: string }>(t, "registerMachine", {
      appliance: "scraper",
      machine: "box-1",
      os: "linux",
      version: "1.4.0",
    });
    expect(r.state).toBe("chirping");
  });

  it("auto-creates the appliance if it joins an unknown appliance id", async () => {
    const t = freshTenant();
    const r = await op<{ ok: boolean }>(t, "registerMachine", {
      appliance: "ghost",
      machine: "box-1",
      os: "darwin",
      version: "1.4.0",
    });
    expect(r.ok).toBe(true);
    const state = await op<any>(t, "getState");
    expect(state.appliances.some((a: any) => a.id === "ghost")).toBe(true);
  });

  it("refreshes (not duplicates) an existing machine on re-join", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "registerMachine", {
      appliance: "scraper",
      machine: "box-1",
      os: "linux",
      version: "1.0.0",
    });
    await op(t, "registerMachine", {
      appliance: "scraper",
      machine: "box-1",
      os: "linux",
      version: "1.5.1",
    });
    const state = await op<any>(t, "getState");
    const ap = state.appliances.find((a: any) => a.id === "scraper");
    expect(ap.machines).toHaveLength(1);
    expect(ap.machines[0].version).toBe("1.5.1");
    expect(ap.machines[0].outdated).toBe(false); // matches LATEST_AGENT
  });

  it("marks a machine on an outdated agent version", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "registerMachine", {
      appliance: "scraper",
      machine: "old-box",
      os: "linux",
      version: "0.9.0",
    });
    const state = await op<any>(t, "getState");
    const ap = state.appliances.find((a: any) => a.id === "scraper");
    expect(ap.machines[0].outdated).toBe(true);
  });
});

describe("TenantDO.checkKey — scope gate (structured)", () => {
  // The owner rule (user:you -> all) is seeded fresh, and mintKey owner defaults
  // to "you", so a default key passes the ACL gate — letting us isolate scope.
  // Scope is now STRUCTURED: {all:true} | {appliances:[...]}; magic strings/CSV
  // are gone (security M2). mintKey validates every listed appliance id exists.
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
      appliance: "scraper",
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
      appliance: "scraper",
    });
    expect(r.allowed).toBe(true);
  });

  it("defaults to LEAST-PRIVILEGE (empty scope) — denies with reason 'scope'", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const key = await mint(t, "bare"); // no scope → reaches nothing
    const r = await op<{ allowed: boolean; reason: string }>(t, "checkKey", {
      hash: await hashKey(key),
      appliance: "scraper",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("scope");
  });

  it("denies with reason 'scope' when the appliance is not in the list", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "enroll", { name: "Printer" });
    const key = await mint(t, "narrow", { appliances: ["printer"] });
    const r = await op<{ allowed: boolean; reason: string }>(t, "checkKey", {
      hash: await hashKey(key),
      appliance: "scraper",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("scope");
  });

  it("allows an appliance list that includes the target", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "enroll", { name: "Printer" });
    const key = await mint(t, "list", { appliances: ["printer", "scraper"] });
    const r = await op<{ allowed: boolean }>(t, "checkKey", {
      hash: await hashKey(key),
      appliance: "scraper",
    });
    expect(r.allowed).toBe(true);
  });

  it("rejects minting a key scoped to an UNKNOWN service id (400)", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const r = await op<{ error?: string; plaintext?: string }>(t, "mintKey", {
      label: "bad-scope",
      scope: { appliances: ["ghost"] },
    });
    expect(r.plaintext).toBeUndefined();
    expect(r.error).toMatch(/unknown service/i);
  });
});

describe("TenantDO.evalAccess — ACL matrix (default-deny)", () => {
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
    appliance = "scraper",
  ): Promise<boolean> {
    const r = await op<{ allowed: boolean; reason?: string }>(t, "checkKey", {
      hash: await hashKey(keyPlain),
      appliance,
    });
    return r.allowed;
  }

  it("DENY by default: a non-owner key with no matching rule is blocked", async () => {
    const t = freshTenant();
    await setup(t);
    const key = await mintNonOwner(t, "k1");
    expect(await allowed(t, key)).toBe(false);
  });

  it("ALLOW via key rule: src key:<label> -> appliance", async () => {
    const t = freshTenant();
    await setup(t);
    const key = await mintNonOwner(t, "k-by-label");
    await op(t, "addAcl", {
      src: { type: "key", name: "k-by-label" },
      dst: [{ type: "appliance", name: "scraper" }],
    });
    expect(await allowed(t, key)).toBe(true);
  });

  it("ALLOW via user rule: src user:<owner> -> appliance", async () => {
    const t = freshTenant();
    await setup(t);
    const key = await mintNonOwner(t, "k-user");
    await op(t, "addAcl", {
      src: { type: "user", name: ALICE },
      dst: [{ type: "appliance", name: "scraper" }],
    });
    expect(await allowed(t, key)).toBe(true);
  });

  it("ALLOW via group rule: key is a member of the src group -> appliance", async () => {
    const t = freshTenant();
    // enroll auto-creates the group "lab" with member ["you"]. keyIdentities
    // adds a group to the key's identities when the key's LABEL is a member of
    // that group — so a key LABELED "you" presents as a member of "lab" even
    // though its owner ("alice") is not. That isolates the GROUP src path from
    // the seeded user:you owner rule (which matches on owner, not label).
    await setup(t, { group: "lab" });
    const key = await mintNonOwner(t, "you"); // label "you", owner "alice"
    await op(t, "addAcl", {
      src: { type: "group", name: "lab" },
      dst: [{ type: "appliance", name: "scraper" }],
    });
    expect(await allowed(t, key)).toBe(true);
  });

  it("DENY group rule: a key in no matching group is blocked", async () => {
    const t = freshTenant();
    await setup(t, { group: "lab" });
    const key = await mintNonOwner(t, "k-not-in-group"); // not a member of "lab"
    await op(t, "addAcl", {
      src: { type: "group", name: "lab" },
      dst: [{ type: "appliance", name: "scraper" }],
    });
    expect(await allowed(t, key)).toBe(false);
  });

  it("ALLOW via tag rule: src key -> tag matches an appliance tag", async () => {
    const t = freshTenant();
    await setup(t, { tags: ["prod", "scrapers"] });
    const key = await mintNonOwner(t, "k-tag");
    await op(t, "addAcl", {
      src: { type: "key", name: "k-tag" },
      dst: [{ type: "tag", name: "prod" }],
    });
    expect(await allowed(t, key)).toBe(true);
  });

  it("ALLOW via appliance-group rule: src key -> group matches", async () => {
    const t = freshTenant();
    await setup(t, { group: "homelab" });
    const key = await mintNonOwner(t, "k-applgroup");
    await op(t, "addAcl", {
      src: { type: "key", name: "k-applgroup" },
      dst: [{ type: "group", name: "homelab" }],
    });
    expect(await allowed(t, key)).toBe(true);
  });

  it("ALLOW via src:all -> any matching dst", async () => {
    const t = freshTenant();
    await setup(t, { tags: ["x"] });
    const key = await mintNonOwner(t, "k-all-src");
    await op(t, "addAcl", {
      src: { type: "all" },
      dst: [{ type: "tag", name: "x" }],
    });
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

  it("DENY when the allow rule targets a DIFFERENT appliance", async () => {
    const t = freshTenant();
    await setup(t);
    await op(t, "enroll", { name: "Printer" });
    const key = await mintNonOwner(t, "k-wrong-dst");
    await op(t, "addAcl", {
      src: { type: "key", name: "k-wrong-dst" },
      dst: [{ type: "appliance", name: "printer" }], // not scraper
    });
    expect(await allowed(t, key, "scraper")).toBe(false);
    expect(await allowed(t, key, "printer")).toBe(true);
  });

  it("DENY when the src does not match (rule for a different key label)", async () => {
    const t = freshTenant();
    await setup(t);
    const key = await mintNonOwner(t, "k-real");
    await op(t, "addAcl", {
      src: { type: "key", name: "some-other-key" },
      dst: [{ type: "appliance", name: "scraper" }],
    });
    expect(await allowed(t, key)).toBe(false);
  });

  it("DENY when the appliance does not exist (evalAccess returns false)", async () => {
    const t = freshTenant();
    await setup(t);
    const key = await mintNonOwner(t, "k-ghost-dst");
    await op(t, "addAcl", {
      src: { type: "key", name: "k-ghost-dst" },
      dst: [{ type: "all" }],
    });
    // appliance "nope" doesn't exist -> evalAccess findAppliance fails -> deny.
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
      appliance: "scraper",
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
      appliance: "scraper",
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

describe("TenantDO.revokeMachineKey — revoke by id (#10)", () => {
  it("revoking by Key.id makes the hash lookup stop matching", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const minted = await op<{ plaintext: string; key: { id: string } }>(
      t,
      "mintKey",
      { label: "live", scope: { all: true } },
    );
    // Sanity: the key authorizes before revoke.
    const before = await op<{ allowed: boolean }>(t, "checkKey", {
      hash: await hashKey(minted.plaintext),
      appliance: "scraper",
    });
    expect(before.allowed).toBe(true);
    // Revoke by id.
    const rev = await op<{ ok: boolean }>(t, "revokeMachineKey", {
      appliance: "scraper",
      machine: "—",
      key: minted.key.id,
    });
    expect(rev.ok).toBe(true);
    const after = await op<{ allowed: boolean; reason?: string }>(t, "checkKey", {
      hash: await hashKey(minted.plaintext),
      appliance: "scraper",
    });
    expect(after.allowed).toBe(false);
    expect(after.reason).toBe("no-key");
  });

  it("populates the appliance key display list at mint (scoped)", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const minted = await op<{ key: { id: string } }>(t, "mintKey", {
      label: "scoped",
      scope: { appliances: ["scraper"] },
    });
    const state = await op<any>(t, "getState");
    const ap = state.appliances.find((a: any) => a.id === "scraper");
    expect(ap.keys).toContain(minted.key.id);
  });
});

describe("TenantDO.registerMachine — re-join preserves approved state (#5)", () => {
  it("does NOT demote an approved+connected machine to pending on re-join", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    // requireApproval default true → first join is pending.
    await op(t, "registerMachine", {
      appliance: "scraper",
      machine: "box-1",
      os: "linux",
      version: "1.4.0",
    });
    await op(t, "approve", { id: "scraper" });
    await op(t, "markMachine", {
      appliance: "scraper",
      machine: "box-1",
      connected: true,
    });
    // Agent restart re-joins the SAME machine.
    const rj = await op<{ ok: boolean; state: string }>(t, "registerMachine", {
      appliance: "scraper",
      machine: "box-1",
      os: "linux",
      version: "1.4.0",
    });
    expect(rj.state).not.toBe("pending"); // not demoted
    const state = await op<any>(t, "getState");
    const m = state.machines.find((mm: any) => mm.name === "box-1");
    expect(m.state).not.toBe("pending");
  });
});

describe("TenantDO.approve — derives liveness from connected (#12)", () => {
  it("an approved-but-disconnected machine reads resting, not chirping", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "registerMachine", {
      appliance: "scraper",
      machine: "box-1",
      os: "linux",
      version: "1.4.0",
    });
    // Approve WITHOUT ever connecting.
    await op(t, "approve", { id: "scraper" });
    const state = await op<any>(t, "getState");
    const m = state.machines.find((mm: any) => mm.name === "box-1");
    expect(m.state).toBe("resting"); // not "chirping"
  });
});

describe("TenantDO.machineExists — /refresh revocation gate", () => {
  it("returns true for a registered machine, false otherwise", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "registerMachine", {
      appliance: "scraper",
      machine: "box-1",
      os: "linux",
      version: "1.4.0",
    });
    expect(await op<{ exists: boolean }>(t, "machineExists", { appliance: "scraper", machine: "box-1" })).toEqual({ exists: true });
    expect(await op<{ exists: boolean }>(t, "machineExists", { appliance: "scraper", machine: "ghost" })).toEqual({ exists: false });
    expect(await op<{ exists: boolean }>(t, "machineExists", { appliance: "nope", machine: "box-1" })).toEqual({ exists: false });
  });
});
