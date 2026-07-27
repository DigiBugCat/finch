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
    await op(t, "addAcl", {
      src: { type: "key", name: "k-by-label" },
      dst: [{ type: "service", name: "scraper" }],
    });
    expect(await allowed(t, key)).toBe(true);
  });

  it("ALLOW via user rule: src user:<owner> -> service", async () => {
    const t = freshTenant();
    await setup(t);
    const key = await mintNonOwner(t, "k-user");
    await op(t, "addAcl", {
      src: { type: "user", name: ALICE },
      dst: [{ type: "service", name: "scraper" }],
    });
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
    await op(t, "addAcl", {
      src: { type: "group", name: "lab" },
      dst: [{ type: "service", name: "scraper" }],
    });
    expect(await allowed(t, key)).toBe(true);
  });

  it("DENY group rule: a key in no matching group is blocked", async () => {
    const t = freshTenant();
    await setup(t, { group: "lab" });
    const key = await mintNonOwner(t, "k-not-in-group"); // not a member of "lab"
    await op(t, "addAcl", {
      src: { type: "group", name: "lab" },
      dst: [{ type: "service", name: "scraper" }],
    });
    expect(await allowed(t, key)).toBe(false);
  });

  it("ALLOW via tag rule: src key -> tag matches an service tag", async () => {
    const t = freshTenant();
    await setup(t, { tags: ["prod", "scrapers"] });
    const key = await mintNonOwner(t, "k-tag");
    await op(t, "addAcl", {
      src: { type: "key", name: "k-tag" },
      dst: [{ type: "tag", name: "prod" }],
    });
    expect(await allowed(t, key)).toBe(true);
  });

  it("ALLOW via service-group rule: src key -> group matches", async () => {
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

  it("DENY when the allow rule targets a DIFFERENT service", async () => {
    const t = freshTenant();
    await setup(t);
    await op(t, "enroll", { name: "Printer" });
    const key = await mintNonOwner(t, "k-wrong-dst");
    await op(t, "addAcl", {
      src: { type: "key", name: "k-wrong-dst" },
      dst: [{ type: "service", name: "printer" }], // not scraper
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
      dst: [{ type: "service", name: "scraper" }],
    });
    expect(await allowed(t, key)).toBe(false);
  });

  it("DENY when the service does not exist (evalAccess returns false)", async () => {
    const t = freshTenant();
    await setup(t);
    const key = await mintNonOwner(t, "k-ghost-dst");
    await op(t, "addAcl", {
      src: { type: "key", name: "k-ghost-dst" },
      dst: [{ type: "all" }],
    });
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

describe("TenantDO access requests — queue + listAccess", () => {
  it("requestAccess creates a pending row (email lowercased)", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const r = await op<any>(t, "requestAccess", {
      email: "Alice@Example.COM",
      service: "scraper",
      requestedBy: "you",
    });
    expect(r.ok).toBe(true);
    expect(r.request.email).toBe("alice@example.com");
    expect(r.request.service).toBe("scraper");
    expect(r.request.status).toBe("pending");
    expect(r.request.requestedBy).toBe("you");
    expect(typeof r.request.created).toBe("number");
  });

  it("is idempotent: a second request for the same email+service returns the existing row", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const a = await op<any>(t, "requestAccess", {
      email: "bob@x.com",
      service: "scraper",
      requestedBy: "you",
    });
    const b = await op<any>(t, "requestAccess", {
      email: "BOB@x.com",
      service: "scraper",
      requestedBy: "someone-else",
    });
    expect(b.request.id).toBe(a.request.id);
    const list = await op<any>(t, "listAccess");
    expect(list.requests).toHaveLength(1);
  });

  it("dedupes against an 'invited' row too, but not a resolved one", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const a = await op<any>(t, "requestAccess", {
      email: "c@x.com",
      service: "scraper",
      requestedBy: "you",
    });
    await op(t, "setAccessStatus", {
      id: a.request.id,
      status: "invited",
      resolvedBy: "you",
    });
    const b = await op<any>(t, "requestAccess", {
      email: "c@x.com",
      service: "scraper",
      requestedBy: "you",
    });
    expect(b.request.id).toBe(a.request.id); // invited still dedupes
    await op(t, "setAccessStatus", {
      id: a.request.id,
      status: "denied",
      resolvedBy: "you",
    });
    const c = await op<any>(t, "requestAccess", {
      email: "c@x.com",
      service: "scraper",
      requestedBy: "you",
    });
    expect(c.request.id).not.toBe(a.request.id); // denied → a fresh row
  });

  it("setAccessStatus transitions and stamps resolvedBy/resolvedAt", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const a = await op<any>(t, "requestAccess", {
      email: "d@x.com",
      service: "scraper",
      requestedBy: "you",
    });
    const r = await op<any>(t, "setAccessStatus", {
      id: a.request.id,
      status: "granted",
      resolvedBy: "admin@x.com",
    });
    expect(r.ok).toBe(true);
    expect(r.request.status).toBe("granted");
    expect(r.request.resolvedBy).toBe("admin@x.com");
    expect(typeof r.request.resolvedAt).toBe("number");
  });

  it("setAccessStatus rejects an unknown id", async () => {
    const t = freshTenant();
    const r = await op<any>(t, "setAccessStatus", {
      id: "ar_nope",
      status: "denied",
      resolvedBy: "you",
    });
    expect(r.error).toMatch(/unknown access request/i);
  });

  it("setAccessStatus rejects an invalid status", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const a = await op<any>(t, "requestAccess", {
      email: "e@x.com",
      service: "scraper",
      requestedBy: "you",
    });
    const r = await op<any>(t, "setAccessStatus", {
      id: a.request.id,
      status: "bogus",
      resolvedBy: "you",
    });
    expect(r.error).toMatch(/invalid status/i);
  });

  it("listAccess returns requests + user→service ACL grants only", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "requestAccess", {
      email: "f@x.com",
      service: "scraper",
      requestedBy: "you",
    });
    await op(t, "addAcl", {
      src: { type: "user", name: "f@x.com" },
      dst: [{ type: "service", name: "scraper" }],
    });
    await op(t, "addAcl", {
      src: { type: "key", name: "some-key" },
      dst: [{ type: "service", name: "scraper" }],
    });
    const list = await op<any>(t, "listAccess");
    expect(list.requests).toHaveLength(1);
    // grants = UNLOCKED user-src rules only: the key-src rule AND the seeded
    // locked user:you owner rule are filtered out (the owner rule is not a
    // revocable share — surfacing it gave every app a phantom granted row).
    expect(list.grants.every((g: any) => g.src.type === "user")).toBe(true);
    expect(list.grants.some((g: any) => g.locked)).toBe(false);
    expect(list.grants.some((g: any) => g.src.name === "you")).toBe(false);
    expect(
      list.grants.some((g: any) => g.src.name === "f@x.com"),
    ).toBe(true);
    expect(
      list.grants.some((g: any) => g.src.name === "some-key"),
    ).toBe(false);
  });

  it("persists accessRequests in the state snapshot (round-trip)", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const a = await op<any>(t, "requestAccess", {
      email: "g@x.com",
      service: "scraper",
      requestedBy: "you",
    });
    // An unrelated mutation forces a load()+save() cycle over the stored record.
    await op(t, "updateSetting", { key: "defaultGroup", val: "lab" });
    const state = await op<any>(t, "getState");
    expect(state.accessRequests).toHaveLength(1);
    expect(state.accessRequests[0].id).toBe(a.request.id);
    expect(state.accessRequests[0].email).toBe("g@x.com");
  });

  it("evicts oldest resolved rows at the cap instead of growing unbounded", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    // Fill to the cap (200) with resolved rows.
    for (let i = 0; i < 200; i++) {
      const r = await op<any>(t, "requestAccess", {
        email: `u${i}@x.com`,
        service: "scraper",
        requestedBy: "you",
      });
      await op(t, "setAccessStatus", {
        id: r.request.id,
        status: "denied",
        resolvedBy: "you",
      });
    }
    const extra = await op<any>(t, "requestAccess", {
      email: "fresh@x.com",
      service: "scraper",
      requestedBy: "you",
    });
    expect(extra.ok).toBe(true); // a resolved row was evicted to make room
    const list = await op<any>(t, "listAccess");
    expect(list.requests.length).toBeLessThanOrEqual(200);
    expect(list.requests.some((r: any) => r.email === "fresh@x.com")).toBe(true);
  });
});

describe("TenantDO addAcl/removeUserGrant — grant idempotence + surgical revoke", () => {
  it("addAcl is idempotent: an identical rule returns the existing id", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const a = await op<any>(t, "addAcl", {
      src: { type: "user", name: "alice@x.com" },
      dst: [{ type: "service", name: "scraper" }],
    });
    const b = await op<any>(t, "addAcl", {
      src: { type: "user", name: "ALICE@x.com" },
      dst: [{ type: "service", name: "scraper" }],
    });
    expect(b.id).toBe(a.id);
    const list = await op<any>(t, "listAccess");
    expect(
      list.grants.filter((g: any) => g.src.name?.toLowerCase() === "alice@x.com"),
    ).toHaveLength(1);
  });

  it("removeUserGrant strips ONE service from a multi-dst rule", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "enroll", { name: "Kestrel" });
    await op(t, "addAcl", {
      src: { type: "user", name: "alice@x.com" },
      dst: [
        { type: "service", name: "scraper" },
        { type: "service", name: "kestrel" },
      ],
    });
    const r = await op<any>(t, "removeUserGrant", {
      email: "alice@x.com",
      service: "scraper",
    });
    expect(r.removed).toBe(true);
    expect(r.stillAllowed).toBe(false);
    // kestrel access survives the scraper revoke.
    const kestrel = await op<any>(t, "checkUserAccess", {
      user: "alice@x.com",
      service: "kestrel",
    });
    expect(kestrel.allowed).toBe(true);
    const scraper = await op<any>(t, "checkUserAccess", {
      user: "alice@x.com",
      service: "scraper",
    });
    expect(scraper.allowed).toBe(false);
  });

  it("removeUserGrant deletes a single-dst rule outright", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "addAcl", {
      src: { type: "user", name: "bob@x.com" },
      dst: [{ type: "service", name: "scraper" }],
    });
    const r = await op<any>(t, "removeUserGrant", {
      email: "bob@x.com",
      service: "scraper",
    });
    expect(r.removed).toBe(true);
    const list = await op<any>(t, "listAccess");
    expect(list.grants.some((g: any) => g.src.name === "bob@x.com")).toBe(false);
  });

  it("removeUserGrant reports stillAllowed for a dst:all rule it can't narrow", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "addAcl", {
      src: { type: "user", name: "carol@x.com" },
      dst: [{ type: "all" }],
    });
    const r = await op<any>(t, "removeUserGrant", {
      email: "carol@x.com",
      service: "scraper",
    });
    expect(r.removed).toBe(false);
    expect(r.stillAllowed).toBe(true);
  });
});

describe("TenantDO.checkUserAccess — the browser/OAuth door gate", () => {
  it("denies a member with no grant, allows one with a user→service rule", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const before = await op<any>(t, "checkUserAccess", {
      user: "dave@x.com",
      service: "scraper",
    });
    expect(before.allowed).toBe(false); // default-deny — org membership is not enough
    await op(t, "addAcl", {
      src: { type: "user", name: "dave@x.com" },
      dst: [{ type: "service", name: "scraper" }],
    });
    const after = await op<any>(t, "checkUserAccess", {
      user: "DAVE@x.com",
      service: "scraper",
    });
    expect(after.allowed).toBe(true);
  });

  it("allows anyone on a public service", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op(t, "setAuth", { service: "scraper", mode: "public" });
    const r = await op<any>(t, "checkUserAccess", {
      user: "",
      service: "scraper",
    });
    expect(r.allowed).toBe(true);
    expect(r.public).toBe(true);
  });

  it("denies an unknown service", async () => {
    const t = freshTenant();
    const r = await op<any>(t, "checkUserAccess", {
      user: "dave@x.com",
      service: "ghost",
    });
    expect(r.allowed).toBe(false);
  });
});

// REGRESSION: the dashboard read handed every caller the WHOLE fleet. The web
// layer could only blank fields (keys, addresses, callers), never narrow the
// collections -- it has no ACL -- so a `member`, the role approveAccess mints
// for an outsider granted exactly ONE service, still received every service id,
// owner, route, box and metric in the tenant. Scoping lives here because this
// is where the ACL is, and it must agree with the door (gateBrowser).
describe("TenantDO.getState — viewer scoping", () => {
  async function fleet() {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" }); // granted to the member
    await op(t, "enroll", { name: "Kestrel" }); // NOT granted
    await op(t, "enroll", { name: "Status" });
    await op(t, "setAuth", { service: "status", mode: "public" });
    for (const [service, box] of [["scraper", "b1"], ["kestrel", "b2"], ["status", "b3"]]) {
      await op(t, "registerBox", { service, box, os: "linux", version: "1.4.0" });
    }
    const boot = await op<any>(t, "bootstrapMembers", {
      kind: "team",
      displayName: "Fleet",
      bootstrappedFrom: "fresh",
      claimantClerkUserId: "u_owner",
      members: [
        { clerkUserId: "u_owner", email: "owner@example.com", role: "owner", state: "active" },
        { clerkUserId: "u_member", email: "member@example.com", role: "member", state: "active" },
      ],
    });
    const [owner, member] = boot.members;
    await op(t, "addAcl", {
      src: { type: "user", name: "member@example.com" },
      dst: [{ type: "service", name: "scraper" }],
    });
    return { t, owner, member };
  }

  const ids = (state: any) => state.services.map((a: any) => a.id).sort();

  it("narrows a member to granted + public services, boxes and overview", async () => {
    const { t, member } = await fleet();
    const state = await op<any>(t, "getState", { viewer: member.id });

    // `status` is public — the door lets the member call it unauthenticated, so
    // hiding it from the dashboard would hide something they already reach.
    expect(ids(state)).toEqual(["scraper", "status"]);
    // The flattened Boxes lens is derived from the SAME narrowed list, and so
    // are the fleet totals — otherwise the hidden services leak back as counts.
    expect(state.boxes.map((m: any) => m.name).sort()).toEqual(["b1", "b3"]);
    expect(state.overview.total).toBe(2);
    expect(state.viewerScoped).toBe(true);
    expect(JSON.stringify(state.services)).not.toContain("kestrel");
  });

  // REGRESSION: narrowing services[] narrowed every Overview field EXCEPT
  // keysActive, which was computed over the tenant's whole key set and so
  // handed a member the tenant-wide credential count -- through the one
  // aggregate services[] narrowing could not reach, and which the web layer
  // explicitly treats as a fleet magnitude that must not leak.
  it("zeroes keysActive for a scoped viewer and leaves it intact for an admin", async () => {
    const { t, member, owner } = await fleet();
    await op(t, "mintKey", { label: "k1", scope: { all: true } });
    await op(t, "mintKey", { label: "k2", scope: { all: true } });

    const unscoped = await op<any>(t, "getState");
    expect(unscoped.overview.keysActive).toBe(2);
    // An admin viewer takes the unnarrowed path — byte-for-byte unchanged.
    expect((await op<any>(t, "getState", { viewer: owner.id })).overview.keysActive).toBe(2);

    const scoped = await op<any>(t, "getState", { viewer: member.id });
    expect(scoped.overview.keysActive).toBe(0);
    // The rest of the Overview still reflects the member's narrowed fleet
    // rather than being blanked wholesale.
    expect(scoped.overview.total).toBe(2);
  });

  it("agrees with the door gate on every service it hides", async () => {
    const { t, member } = await fleet();
    const state = await op<any>(t, "getState", { viewer: member.id });
    const visible = new Set(ids(state));
    for (const service of ["scraper", "kestrel", "status"]) {
      const gate = await op<any>(t, "gateBrowser", {
        clerkUserId: "u_member",
        email: "member@example.com",
        epoch: 0,
        service,
      });
      expect(gate.allowed).toBe(visible.has(service));
    }
  });

  it("leaves an admin viewer and an unscoped read untouched", async () => {
    const { t, owner } = await fleet();
    expect(ids(await op<any>(t, "getState", { viewer: owner.id }))).toEqual([
      "kestrel", "scraper", "status",
    ]);
    // No viewer at all — the CLI's /api/cli/state and the internal lookups.
    const unscoped = await op<any>(t, "getState");
    expect(ids(unscoped)).toEqual(["kestrel", "scraper", "status"]);
    expect(unscoped.viewerScoped).toBeUndefined();
  });

  it("fails closed for a viewer id that is not an active member", async () => {
    const { t, member } = await fleet();
    await op(t, "setMemberState", {
      memberId: member.id,
      state: "disabled",
      actor: { memberId: (await op<any>(t, "getState")).members[0].id, clerkUserId: "u_owner" },
    });
    for (const viewer of [member.id, "m_ghost"]) {
      const state = await op<any>(t, "getState", { viewer });
      expect(state.services).toEqual([]);
      expect(state.boxes).toEqual([]);
      expect(state.logs).toEqual([]);
      expect(state.viewerScoped).toBe(true);
    }
  });

  // REGRESSION (F8 round 2): narrowing services[] alone did not close the hole
  // -- the AUDIT LOG re-supplies the same data. A `request` row is
  // `${service} ${route}` + status (the per-route call feed the finding named,
  // 500 deep), a `device` row is service -> box, `set-auth` is
  // `${id} -> ${mode}`. The web layer keeps exactly those two categories for a
  // member, so an ungated log handed back every hidden service anyway.
  describe("audit log", () => {
    async function busyFleet() {
      const f = await fleet();
      // Traffic + a control-plane change on each service, so every row shape
      // the member could read exists for BOTH a granted and a denied service.
      for (const service of ["scraper", "kestrel", "status"]) {
        await op(f.t, "recordCall", {
          service,
          box: service === "scraper" ? "b1" : service === "kestrel" ? "b2" : "b3",
          route: `/${service}-secret-route`,
          status: 200,
          ms: 5,
          caller: "finch_key_label",
        });
        await op(f.t, "setTags", { service, tags: ["tag-" + service] });
      }
      return f;
    }

    const logsOf = async (t: string, viewer?: string) =>
      (await op<any>(t, "getState", viewer ? { viewer } : {})).logs;

    it("hides every entry about a service the member cannot see", async () => {
      const { t, member } = await busyFleet();
      const logs = await logsOf(t, member.id);
      // The denied service leaks through NOTHING -- not its id, not its route.
      expect(JSON.stringify(logs)).not.toContain("kestrel");
      // ...while the granted and public ones still have their feed.
      const targets = logs.map((e: any) => e.target);
      expect(targets).toContain("scraper /scraper-secret-route");
      expect(targets).toContain("status /status-secret-route");
      // Tenant-wide rows (roster/settings prose, e.g. the bootstrap entry) are
      // denied too -- see getState: the boundary rides the ACL, not the web's
      // category list.
      expect(JSON.stringify(logs)).not.toContain("member@example.com");
    });

    it("leaves an admin's log byte-for-byte unchanged, with no svc field", async () => {
      const { t, owner } = await busyFleet();
      const unscoped = await logsOf(t);
      expect(await logsOf(t, owner.id)).toEqual(unscoped);
      // `svc` is ACL metadata, stripped on the way out for every caller.
      for (const entry of unscoped) expect(entry).not.toHaveProperty("svc");
      expect(JSON.stringify(unscoped)).toContain("kestrel");
    });

    it("fails closed on legacy rows written before the svc field existed", async () => {
      const { t, member } = await busyFleet();
      const stub = env.TENANT.get(env.TENANT.idFromName(t));
      const runInDO = runInDurableObject as unknown as (
        target: typeof stub,
        callback: (instance: any) => unknown,
      ) => Promise<any>;
      await runInDO(stub, async (instance: any) => {
        const s: any = await instance.ctx.storage.get("state");
        // Exactly what a pre-upgrade DO holds: the prose, no subject field.
        s.logs.unshift({
          ts: Date.now(),
          ago: "",
          cat: "request",
          actor: "finch_key_label",
          action: "called",
          target: "kestrel /legacy-route",
          ip: "",
          result: 200,
        });
        await instance.ctx.storage.put("state", s);
      });
      expect(JSON.stringify(await logsOf(t, member.id))).not.toContain("legacy-route");
      // The admin still sees it -- the legacy row is hidden, not dropped.
      expect(JSON.stringify(await logsOf(t))).toContain("legacy-route");
    });

    it("hides a row once its service leaves the member's ACL", async () => {
      const { t, member } = await busyFleet();
      expect(JSON.stringify(await logsOf(t, member.id))).toContain("scraper");
      await op(t, "removeUserGrant", { email: "member@example.com", service: "scraper" });
      expect(JSON.stringify(await logsOf(t, member.id))).not.toContain("scraper");
    });
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

// REGRESSION (P1, Codex round 3): two ways a principal kept access after the
// dashboard reported it taken away. Both are privilege RETENTION -- the UI says
// success, the ACL disagrees -- so both assert through the door gate
// (checkUserAccess), never through the response shape alone.
describe("TenantDO — revocation actually revokes", () => {
  async function teamWithOwner(t: string, extra: any[] = []) {
    const boot = await op<any>(t, "bootstrapMembers", {
      kind: "team",
      displayName: "Fleet",
      bootstrappedFrom: "fresh",
      claimantClerkUserId: "u_owner",
      members: [
        { clerkUserId: "u_owner", email: "owner@example.com", role: "owner", state: "active" },
        ...extra,
      ],
    });
    return boot.members;
  }

  const reaches = async (t: string, user: string, service = "scraper") =>
    (await op<any>(t, "checkUserAccess", { user, service })).allowed;

  it("revokes an alias-bound grant under the member's canonical identity", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const [owner] = await teamWithOwner(t);
    const actor = { memberId: owner.id, clerkUserId: "u_owner", label: "owner@example.com" };

    // 1. The person is ALREADY bound under their canonical address.
    await op(t, "inviteMember", { email: "canonical@example.com", role: "member", actor });
    await op(t, "bindIdentity", {
      clerkUserId: "u_alias",
      emails: ["canonical@example.com"],
      source: "sync",
    });

    // 2. A request arrives naming an ALIAS of that same person. Approval cannot
    //    know they are the same yet, so it parks an invitation on the alias.
    const req = await op<any>(t, "requestAccess", {
      email: "alias@example.com",
      service: "scraper",
      requestedBy: "self",
    });
    await op(t, "approveAccess", { id: req.request.id, actor });

    // 3. The alias is verified on the identity. Binding folds the duplicate
    //    invitation in and grants the service under the CANONICAL email --
    //    which is the principal the door evaluates.
    await op(t, "bindIdentity", {
      clerkUserId: "u_alias",
      emails: ["canonical@example.com", "alias@example.com"],
      source: "sync",
    });
    expect(await reaches(t, "canonical@example.com")).toBe(true);

    // Revoking by request id used to strip the ALIAS: it removed nothing, and
    // the "still granted by a broader rule" guard evaluated that same wrong
    // email so it did not fire either. The caller saw ok:true, the row flipped
    // to denied, and the member kept the service.
    const rev = await op<any>(t, "revokeAccess", { id: req.request.id, actor });
    expect(rev.ok).toBe(true);
    expect(rev.removed).toBe(true); // an ACL rule was actually found
    expect(rev.denied).toBe(1); // and the request row was resolved

    expect(await reaches(t, "canonical@example.com")).toBe(false);
    expect(await reaches(t, "alias@example.com")).toBe(false);
  });

  // bootstrap rewrites the locked `r_owner` rule (user -> all) onto the
  // bootstrapping owner's email, and nothing moved it again. stripGrants skips
  // locked rules by design, so losing ownership left a LOCKED grant to EVERY
  // service sitting on that address -- which gateBrowser, gateOauth and the
  // dashboard's viewer filter all honour. The role badge changed; the access
  // did not.
  for (const how of ["demote", "disable", "remove"] as const) {
    it(`moves the locked owner grant off an owner on ${how}`, async () => {
      const t = freshTenant();
      await op(t, "enroll", { name: "Scraper" });
      const [first, second] = await teamWithOwner(t, [
        { clerkUserId: "u_second", email: "second@example.com", role: "owner", state: "active" },
      ]);
      const actor = { memberId: second.id, clerkUserId: "u_second" };
      expect(await reaches(t, "owner@example.com")).toBe(true);

      const call =
        how === "demote"
          ? op<any>(t, "setMemberRole", { memberId: first.id, role: "member", actor })
          : how === "disable"
            ? op<any>(t, "setMemberState", { memberId: first.id, state: "disabled", actor })
            : op<any>(t, "removeMember", { memberId: first.id, actor });
      expect((await call).ok).toBe(true);

      expect(await reaches(t, "owner@example.com")).toBe(false);
      // REASSIGNED, not deleted: the remaining owner must not be locked out of
      // their own tenant.
      expect(await reaches(t, "second@example.com")).toBe(true);
      const locked = (await op<any>(t, "getState")).acl.find((r: any) => r.id === "r_owner");
      expect(locked.locked).toBe(true);
      expect(locked.src.name).toBe("second@example.com");
    });
  }
});

// REGRESSION (P1, Codex round 4): the two fixes above were FORWARD-ONLY. They
// corrected new transitions and newly granted rows, but every tenant already
// carrying the broken state -- which is the entire installed base, since both
// bugs shipped long ago -- would have kept it. A fix that repairs nothing that
// is already wrong does not close a live privilege-retention hole.
describe("TenantDO — repairing state that predates the fix", () => {
  const stubFor = (t: string) => env.TENANT.get(env.TENANT.idFromName(t));
  const runInDO = runInDurableObject as unknown as (
    target: ReturnType<typeof stubFor>,
    callback: (instance: any) => unknown,
  ) => Promise<any>;

  const reaches = async (t: string, user: string, service = "scraper") =>
    (await op<any>(t, "checkUserAccess", { user, service })).allowed;

  it("moves a locked owner grant already stranded on a non-owner", async () => {
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    await op<any>(t, "bootstrapMembers", {
      kind: "team",
      displayName: "Fleet",
      bootstrappedFrom: "fresh",
      claimantClerkUserId: "u_owner",
      members: [
        { clerkUserId: "u_owner", email: "owner@example.com", role: "owner", state: "active" },
        { clerkUserId: "u_second", email: "second@example.com", role: "owner", state: "active" },
      ],
    });

    // Exactly what a pre-upgrade DO holds: the demotion already happened under
    // the old code, so the locked rule still names the demoted member and no
    // future transition will ever revisit it.
    await runInDO(stubFor(t), async (instance: any) => {
      const s: any = await instance.ctx.storage.get("state");
      s.members.find((m: any) => m.email === "owner@example.com").role = "member";
      await instance.ctx.storage.put("state", s);
    });

    // load() normalizes in memory, so the very first read after deploy is
    // already correct -- no migration, and the gates see it immediately.
    expect(await reaches(t, "owner@example.com")).toBe(false);
    expect(await reaches(t, "second@example.com")).toBe(true);
    const locked = (await op<any>(t, "getState")).acl.find((r: any) => r.id === "r_owner");
    expect(locked.src.name).toBe("second@example.com");
  });

  it("refuses to revoke a legacy row whose principal cannot be identified", async () => {
    // The linkage is simply not in the state: an alias-bound grant sits on the
    // member's canonical email, and the alias's own member row was folded away
    // at bind time. No heuristic recovers it -- a verified email or a matching
    // rule each show that some principal COULD be the one, never that it IS --
    // and a wrong guess strips a bystander while the real grant survives,
    // which is the silent failure this whole change removes. So refuse.
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const boot = await op<any>(t, "bootstrapMembers", {
      kind: "team",
      displayName: "Fleet",
      bootstrappedFrom: "fresh",
      claimantClerkUserId: "u_owner",
      members: [
        { clerkUserId: "u_owner", email: "owner@example.com", role: "owner", state: "active" },
      ],
    });
    const owner = boot.members[0];
    const actor = { memberId: owner.id, clerkUserId: "u_owner", label: "owner@example.com" };

    await op(t, "inviteMember", { email: "canonical@example.com", role: "member", actor });
    await op(t, "bindIdentity", {
      clerkUserId: "u_alias",
      emails: ["canonical@example.com"],
      source: "sync",
    });
    const req = await op<any>(t, "requestAccess", {
      email: "alias@example.com",
      service: "scraper",
      requestedBy: "self",
    });
    await op(t, "approveAccess", { id: req.request.id, actor });
    await op(t, "bindIdentity", {
      clerkUserId: "u_alias",
      emails: ["canonical@example.com", "alias@example.com"],
      source: "sync",
    });

    // Rewind to a pre-upgrade row: granted, no principal recorded.
    await runInDO(stubFor(t), async (instance: any) => {
      const s: any = await instance.ctx.storage.get("state");
      delete s.accessRequests.find((r: any) => r.id === req.request.id).grantedTo;
      await instance.ctx.storage.put("state", s);
    });

    const rev = await op<any>(t, "revokeAccess", { id: req.request.id, actor });
    expect(rev.error).toContain("Rules tab");
    expect(rev.ok).toBeUndefined();
    // Critically: it must NOT have half-applied. The row is untouched and the
    // access is intact, so the admin sees a true state to act on.
    const row = (await op<any>(t, "listAccess")).requests.find(
      (r: any) => r.id === req.request.id,
    );
    expect(row.status).toBe("granted");
    expect(
      (await op<any>(t, "checkUserAccess", { user: "canonical@example.com", service: "scraper" }))
        .allowed,
    ).toBe(true);

    // The documented alternative works and is unambiguous: revoke the RULE.
    const rule = (await op<any>(t, "getState")).acl.find(
      (r: any) =>
        !r.locked &&
        r.src?.name === "canonical@example.com" &&
        r.dst?.some((d: any) => d.name === "scraper"),
    );
    const byRule = await op<any>(t, "revokeAccess", { ruleId: rule.id, actor });
    expect(byRule.ok).toBe(true);
    expect(
      (await op<any>(t, "checkUserAccess", { user: "canonical@example.com", service: "scraper" }))
        .allowed,
    ).toBe(false);
  });

  it("refuses uniformly — a member row for the email is not proof either", async () => {
    // The alias may have been invited as its OWN member AFTER the grant went
    // to someone else, which from stored state is indistinguishable from that
    // member having been the grantee. So the existence of a member row is not
    // a discriminator, and no legacy row gets a fallback.
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const boot = await op<any>(t, "bootstrapMembers", {
      kind: "team",
      displayName: "Fleet",
      bootstrappedFrom: "fresh",
      claimantClerkUserId: "u_owner",
      members: [
        { clerkUserId: "u_owner", email: "owner@example.com", role: "owner", state: "active" },
        { clerkUserId: "u_plain", email: "plain@example.com", role: "member", state: "active" },
      ],
    });
    const owner = boot.members[0];
    const actor = { memberId: owner.id, clerkUserId: "u_owner", label: "owner@example.com" };
    const req = await op<any>(t, "requestAccess", {
      email: "plain@example.com",
      service: "scraper",
      requestedBy: "self",
    });
    await op(t, "approveAccess", { id: req.request.id, actor });
    await runInDO(stubFor(t), async (instance: any) => {
      const s: any = await instance.ctx.storage.get("state");
      delete s.accessRequests.find((r: any) => r.id === req.request.id).grantedTo;
      await instance.ctx.storage.put("state", s);
    });

    const rev = await op<any>(t, "revokeAccess", { id: req.request.id, actor });
    expect(rev.error).toContain("Rules tab");
    expect(
      (await op<any>(t, "checkUserAccess", { user: "plain@example.com", service: "scraper" }))
        .allowed,
    ).toBe(true);
  });

  it("revokes a row granted by the current code by request id, as before", async () => {
    // The refusal must not become the normal path: a row carrying grantedTo
    // is unambiguous and keeps working exactly as it did.
    const t = freshTenant();
    await op(t, "enroll", { name: "Scraper" });
    const boot = await op<any>(t, "bootstrapMembers", {
      kind: "team",
      displayName: "Fleet",
      bootstrappedFrom: "fresh",
      claimantClerkUserId: "u_owner",
      members: [
        { clerkUserId: "u_owner", email: "owner@example.com", role: "owner", state: "active" },
        { clerkUserId: "u_plain", email: "plain@example.com", role: "member", state: "active" },
      ],
    });
    const owner = boot.members[0];
    const actor = { memberId: owner.id, clerkUserId: "u_owner", label: "owner@example.com" };
    const req = await op<any>(t, "requestAccess", {
      email: "plain@example.com",
      service: "scraper",
      requestedBy: "self",
    });
    await op(t, "approveAccess", { id: req.request.id, actor });

    const rev = await op<any>(t, "revokeAccess", { id: req.request.id, actor });
    expect(rev.ok).toBe(true);
    expect(rev.removed).toBe(true);
    expect(
      (await op<any>(t, "checkUserAccess", { user: "plain@example.com", service: "scraper" }))
        .allowed,
    ).toBe(false);
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
