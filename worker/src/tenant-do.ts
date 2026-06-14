/// <reference types="@cloudflare/workers-types" />
//
// TenantDO — one Durable Object per tenant (a Clerk org id, or a user id).
// It owns the tenant's entire control-plane state: appliances, the machines
// that run them, finch_ keys, ACL rules, groups, settings, and the activity
// log. The dashboard's GET /api/state returns exactly the projection this DO
// computes; the agent join flow, the relay (ApplianceDO), and the MCP router
// all reach in here via internal RPC.
//
// RPC shape: POST a JSON body { op, ...args } to this DO's fetch(); it returns
// JSON. index.ts/api.ts marshal HTTP <-> these ops; this module is pure state.
//
// Storage model: we keep a single STORED record in this.ctx.storage under the
// key "state". That record is the source of truth and holds the full Key
// objects (hash + last4). getState() derives the public TenantState from it —
// flattening machines, deriving each appliance.state from its machines,
// recomputing `outdated`, building the overview, and stripping key hashes — so
// derived fields are never persisted stale. Every mutation persists the stored
// record and appends a LogEvent.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { genFinchKey, hashKey, last4 } from "./auth";
import { routerRegister } from "./router-do";
import {
  type TenantState,
  type Appliance,
  type Machine,
  type Key,
  type PublicKey,
  type AclRule,
  type AclEntity,
  type LogEvent,
  type Settings,
  type Overview,
  type Group,
  type RecentCall,
  type ApplianceState,
  isOnline,
  LATEST_AGENT,
} from "./types";

// ---- stored shape ---------------------------------------------------------
// What actually lives in this.ctx.storage. It mirrors TenantState but holds
// full Key objects (with hash), and stores appliances WITHOUT the derived
// fields that getState() recomputes (state/machines/outdated/metrics live on
// the appliance, but `machines` flatten + overview are computed on read).

interface StoredAppliance extends Appliance {}

interface StoredState {
  host: string;
  appliances: StoredAppliance[];
  keys: Key[]; // full keys incl. hash — never leaves the DO as-is
  groups: Group[];
  acl: AclRule[];
  logs: LogEvent[];
  settings: Settings;
}

const MAX_LOGS = 500;
const MAX_RECENT_CALLS = 20;
const ROLL_WINDOW = 50; // calls kept for the rolling p50/p95/err estimate

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const bad = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });

export class TenantDO extends DurableObject<Env> {
  // In-memory rolling latency samples per "appliance:machine", used to recompute
  // p50/p95/err on recordCall. Lost on eviction — that only blurs the rolling
  // window briefly, the durable counters (calls, recentCalls) survive.
  private samples = new Map<string, { ms: number; ok: boolean }[]>();

  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return bad(405, "POST only");
    let msg: { op?: string; [k: string]: unknown };
    try {
      msg = await req.json();
    } catch {
      return bad(400, "invalid JSON");
    }
    const op = msg.op;
    if (!op || typeof op !== "string") return bad(400, "missing op");

    const a = msg as any;
    try {
      switch (op) {
        case "getState":
          return ok(await this.getState());
        case "enroll":
          return ok(await this.enroll(a.name, a.group));
        case "release":
          return ok(await this.release(a.id));
        case "approve":
          return ok(await this.approve(a.id));
        case "decline":
          return ok(await this.decline(a.id));
        case "setTags":
          return ok(await this.setTags(a.id, a.tags));
        case "mintKey":
          return ok(await this.mintKey(a.label, a.scope, a.owner));
        case "revokeMachineKey":
          return ok(
            await this.revokeMachineKey(a.appliance, a.machine, a.key),
          );
        case "addAcl":
          return ok(await this.addAcl(a.src, a.dst));
        case "removeAcl":
          return ok(await this.removeAcl(a.id));
        case "updateSetting":
          return ok(await this.updateSetting(a.key, a.val));
        case "registerMachine":
          return ok(
            await this.registerMachine(a.appliance, a.machine, a.os, a.version),
          );
        case "markMachine":
          return ok(
            await this.markMachine(a.appliance, a.machine, a.connected),
          );
        case "recordCall":
          return ok(
            await this.recordCall(
              a.appliance,
              a.machine,
              a.status,
              a.ms,
              a.caller,
              a.route,
            ),
          );
        case "checkKey":
          return ok(await this.checkKey(a.hash, a.appliance));
        default:
          return bad(400, `unknown op: ${op}`);
      }
    } catch (e) {
      return bad(500, `op ${op} failed: ${e}`);
    }
  }

  // ---- stored-state lifecycle --------------------------------------------

  private async load(): Promise<StoredState> {
    const stored = await this.ctx.storage.get<StoredState>("state");
    if (stored) return stored;
    return this.fresh();
  }

  /** A brand-new tenant: empty roost, default settings, no mock seed data.
   *  Seeds ONE locked owner rule (`user:you` may reach `all`) so the tenant
   *  owner's keys pass the default-deny ACL gate out of the box; everyone else
   *  is denied until an explicit allow rule is added. The rule is `locked` so it
   *  can't be removed via removeAcl (the owner can never lock themselves out). */
  private fresh(): StoredState {
    const id = this.ctx.id.name ?? "";
    return {
      host: "", // set on first enroll/getState if we learn the subdomain
      appliances: [],
      keys: [],
      groups: [],
      acl: [
        {
          id: "r_owner",
          src: { type: "user", name: "you" },
          dst: [{ type: "all" }],
          action: "allow",
          locked: true,
        },
      ],
      logs: [],
      settings: {
        org: id,
        subdomain: "",
        region: "sfo · us-west",
        requireApproval: true,
        defaultGroup: "Home lab",
        keyExpiry: "90 days",
        enforceExpiry: false,
        require2fa: false,
      },
    };
  }

  private async save(s: StoredState): Promise<void> {
    await this.ctx.storage.put("state", s);
  }

  private log(s: StoredState, ev: Omit<LogEvent, "ago" | "ts">): void {
    const ts = Date.now();
    s.logs.unshift({ ...ev, ts, ago: "now" });
    if (s.logs.length > MAX_LOGS) s.logs.length = MAX_LOGS;
  }

  // ---- derivation (read-side) --------------------------------------------

  /** Build the public TenantState: flatten machines, derive appliance.state
   *  from machines, recompute `outdated`, compute the overview, strip key
   *  hashes. Never persisted — always recomputed from the stored record. */
  private async getState(): Promise<TenantState> {
    const s = await this.load();

    const appliances: Appliance[] = s.appliances.map((a) => {
      const machines = (a.machines ?? []).map((m) => ({
        ...m,
        appliance: a.id,
        applianceLabel: a.label,
        outdated: m.version !== LATEST_AGENT,
      }));
      // appliance.state derives from its machines: online if any machine is
      // online. With no machines we keep the appliance's own lifecycle state
      // (invited/pending/resting) untouched.
      let state: ApplianceState = a.state;
      if (machines.length) {
        const anyOnline = machines.some((m) => isOnline(m.state));
        const anyPending = machines.some((m) => m.state === "pending");
        state = anyOnline ? "chirping" : anyPending ? "pending" : "resting";
      }
      const version = machines.length ? machines[0].version : a.version;
      const outdated =
        state !== "invited" &&
        (machines.length
          ? machines.some((m) => m.outdated)
          : version !== LATEST_AGENT);
      return {
        ...a,
        state,
        machines,
        machineCount: machines.length,
        version,
        outdated,
      };
    });

    // Flattened machines lens, annotated with the appliance's group/tags/owner
    // (the dashboard's Machines view consumes this exact shape).
    const machines: Machine[] = [];
    for (const a of appliances) {
      for (const m of a.machines) {
        machines.push({
          ...m,
          group: a.group,
          tags: a.tags,
          owner: a.owner,
        } as Machine & { group: string; tags: string[]; owner: string });
      }
    }

    const publicKeys: PublicKey[] = s.keys.map(({ hash, ...rest }) => rest);

    return {
      host: s.host,
      appliances,
      machines,
      keys: publicKeys,
      groups: s.groups,
      acl: s.acl,
      logs: s.logs,
      settings: s.settings,
      overview: this.overview(appliances, s.keys),
      latestAgent: LATEST_AGENT,
    };
  }

  private overview(appliances: Appliance[], keys: Key[]): Overview {
    const on = appliances.filter((a) => isOnline(a.state));
    const traffic24h = Array.from({ length: 24 }, (_, h) =>
      on.reduce((sum, a) => sum + (a.traffic24h[h] || 0), 0),
    );
    const latency24h = Array.from({ length: 24 }, (_, h) => {
      const vals = on
        .map((a) => a.lat24h[h])
        .filter((v): v is number => typeof v === "number" && v > 0);
      return vals.length
        ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length)
        : 0;
    });
    const callsToday = traffic24h.reduce((s, v) => s + v, 0);
    return {
      callsToday,
      callsDelta: 0,
      activeNow: on.length,
      total: appliances.length,
      p50: on.length
        ? Math.round(on.reduce((s, a) => s + a.p50, 0) / on.length)
        : 0,
      p95: on.length ? Math.max(...on.map((a) => a.p95)) : 0,
      errRate: on.length
        ? +(on.reduce((s, a) => s + a.err, 0) / on.length).toFixed(2)
        : 0,
      keysActive: keys.length,
      traffic24h,
      latency24h,
      latest: LATEST_AGENT,
    };
  }

  // ---- helpers ------------------------------------------------------------

  private findAppliance(
    s: StoredState,
    id: string,
  ): StoredAppliance | undefined {
    return s.appliances.find((a) => a.id === id);
  }

  private slug(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return base || "appliance";
  }

  /** This DO is keyed by the REAL tenant id (Clerk org/user id). */
  private tenantId(): string {
    return this.ctx.id.name ?? "";
  }

  /** A host-safe default subdomain slug for this tenant, derived from its id.
   *  Used at first enroll when the tenant hasn't picked a custom subdomain. */
  private defaultSubdomain(): string {
    const id = this.tenantId();
    const base = id
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return base || "tenant";
  }

  /** Register slug→tenantId in the singleton RouterDO so the relay plane can
   *  resolve <slug>.finchmcp.com to this tenant. Idempotent for the same pair;
   *  a slug already owned by another tenant is left untouched (collision). The
   *  DO reaches the router via env.ROUTER. Best-effort: never throws into a
   *  mutation. Returns whether the mapping is (now) owned by this tenant. */
  private async registerSlug(slug: string): Promise<boolean> {
    const s = (slug || "").trim().toLowerCase();
    const tenant = this.tenantId();
    if (!s || !tenant) return false;
    try {
      const res = await routerRegister(this.env, s, tenant);
      return res.ok;
    } catch {
      return false;
    }
  }

  private emptyConn() {
    return {
      relay: "—",
      version: "",
      address: "",
      handshake: "never",
      protocol: "offline",
    };
  }

  /** A skeleton appliance — no machines yet (invited, ticket just minted). */
  private newAppliance(
    id: string,
    label: string,
    group: string,
  ): StoredAppliance {
    const now = new Date().toISOString().slice(0, 10);
    return {
      id,
      label,
      state: "invited",
      owner: "you",
      box: "—",
      created: now,
      lastSeen: "never",
      uptime: "—",
      blurb: "Ticket minted — waiting for the box to phone home.",
      group,
      version: LATEST_AGENT,
      tags: [],
      outdated: false,
      routes: [],
      keys: [],
      components: [],
      machines: [],
      machineCount: 0,
      calls: 0,
      p50: 0,
      p95: 0,
      err: 0,
      traffic24h: Array(24).fill(0),
      lat24h: Array(24).fill(0),
      recentCalls: [],
      conn: this.emptyConn(),
    };
  }

  // ---- mutations: appliances ---------------------------------------------

  private async enroll(
    name: string,
    group?: string,
  ): Promise<{ id: string }> {
    const s = await this.load();
    let id = this.slug(name);
    // de-dupe id within the tenant
    if (this.findAppliance(s, id)) {
      let n = 2;
      while (this.findAppliance(s, `${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    const g = group || s.settings.defaultGroup;
    s.appliances.push(this.newAppliance(id, name, g));
    if (g && !s.groups.some((gr) => gr.name === g)) {
      s.groups.push({ name: g, members: ["you"] });
    }
    // First enroll for a tenant that hasn't chosen a subdomain: claim a default
    // slug (derived from the tenant id) and register it in the RouterDO so the
    // public relay URL resolves. Best-effort; if the default slug collides with
    // another tenant we leave the subdomain blank (the tenant can pick one).
    if (!s.settings.subdomain) {
      const slug = this.defaultSubdomain();
      const claimed = await this.registerSlug(slug);
      if (claimed) {
        s.settings.subdomain = slug;
        s.host = `${slug}.finchmcp.com`;
      }
    }
    this.log(s, {
      cat: "device",
      actor: "you",
      action: "enrolled",
      target: id,
      ip: "",
    });
    await this.save(s);
    return { id };
  }

  private async release(id: string): Promise<{ ok: boolean }> {
    const s = await this.load();
    const before = s.appliances.length;
    s.appliances = s.appliances.filter((a) => a.id !== id);
    if (s.appliances.length === before) return { ok: false };
    this.log(s, {
      cat: "device",
      actor: "you",
      action: "released",
      target: id,
      ip: "",
    });
    await this.save(s);
    return { ok: true };
  }

  private async approve(id: string): Promise<{ ok: boolean }> {
    const s = await this.load();
    const ap = this.findAppliance(s, id);
    if (!ap) return { ok: false };
    // Promote any pending machines to chirping; appliance.state re-derives.
    for (const m of ap.machines) {
      if (m.state === "pending") m.state = "chirping";
    }
    if (ap.state === "pending") ap.state = "chirping";
    this.log(s, {
      cat: "device",
      actor: "you",
      action: "approved",
      target: id,
      ip: "",
    });
    await this.save(s);
    return { ok: true };
  }

  private async decline(id: string): Promise<{ ok: boolean }> {
    const s = await this.load();
    const ap = this.findAppliance(s, id);
    if (!ap) return { ok: false };
    // Declining a pending appliance removes it (it never became real).
    s.appliances = s.appliances.filter((a) => a.id !== id);
    this.log(s, {
      cat: "device",
      actor: "you",
      action: "declined",
      target: id,
      ip: "",
    });
    await this.save(s);
    return { ok: true };
  }

  private async setTags(
    id: string,
    tags: string[],
  ): Promise<{ ok: boolean }> {
    const s = await this.load();
    const ap = this.findAppliance(s, id);
    if (!ap) return { ok: false };
    ap.tags = Array.isArray(tags) ? tags.map(String) : [];
    this.log(s, {
      cat: "admin",
      actor: "you",
      action: "set tags",
      target: `${id} → ${ap.tags.join(", ") || "(none)"}`,
      ip: "",
    });
    await this.save(s);
    return { ok: true };
  }

  // ---- mutations: keys ----------------------------------------------------

  private async mintKey(
    label: string,
    scope?: string,
    owner?: string,
  ): Promise<{ plaintext: string; key: PublicKey }> {
    const s = await this.load();
    const plaintext = genFinchKey();
    const hash = await hashKey(plaintext);
    const key: Key = {
      id: "k_" + crypto.randomUUID().slice(0, 8),
      label,
      owner: owner || "you",
      created: new Date().toISOString().slice(0, 10),
      scope: scope || "all appliances",
      hash,
      last4: last4(plaintext),
    };
    s.keys.push(key);
    this.log(s, {
      cat: "key",
      actor: key.owner,
      action: "minted key",
      target: label,
      ip: "",
    });
    await this.save(s);
    const { hash: _h, ...pub } = key;
    return { plaintext, key: pub };
  }

  private async revokeMachineKey(
    appliance: string,
    machine: string,
    key: string,
  ): Promise<{ ok: boolean }> {
    const s = await this.load();
    // Remove the key label from the machine (and the appliance's display list).
    let touched = false;
    const ap = this.findAppliance(s, appliance);
    if (ap) {
      const m = ap.machines.find((mm) => mm.name === machine);
      if (m && m.keys.includes(key)) {
        m.keys = m.keys.filter((k) => k !== key);
        touched = true;
      }
      if (ap.keys.includes(key)) ap.keys = ap.keys.filter((k) => k !== key);
    }
    // If no machine anywhere still references the label, drop the Key entirely.
    const stillUsed = s.appliances.some((a) =>
      a.machines.some((m) => m.keys.includes(key)),
    );
    if (!stillUsed) {
      const before = s.keys.length;
      s.keys = s.keys.filter((k) => k.label !== key);
      if (s.keys.length !== before) touched = true;
    }
    this.log(s, {
      cat: "key",
      actor: "you",
      action: "revoked key",
      target: `${key} @ ${appliance}/${machine}`,
      ip: "",
    });
    await this.save(s);
    return { ok: touched };
  }

  // ---- mutations: ACL -----------------------------------------------------

  private async addAcl(
    src: AclEntity,
    dst: AclEntity[],
  ): Promise<{ id: string }> {
    const s = await this.load();
    const rule: AclRule = {
      id: "r_" + crypto.randomUUID().slice(0, 8),
      src,
      dst: Array.isArray(dst) ? dst : [dst],
      action: "allow",
    };
    s.acl.push(rule);
    this.log(s, {
      cat: "access",
      actor: "you",
      action: "granted",
      target: `${aclLabel(src)} → ${rule.dst.map(aclLabel).join(", ")}`,
      ip: "",
    });
    await this.save(s);
    return { id: rule.id };
  }

  private async removeAcl(id: string): Promise<{ ok: boolean }> {
    const s = await this.load();
    const rule = s.acl.find((r) => r.id === id);
    if (!rule) return { ok: false };
    if (rule.locked) return { ok: false };
    s.acl = s.acl.filter((r) => r.id !== id);
    this.log(s, {
      cat: "access",
      actor: "you",
      action: "removed policy",
      target: id,
      ip: "",
    });
    await this.save(s);
    return { ok: true };
  }

  // ---- mutations: settings ------------------------------------------------

  private async updateSetting(
    key: string,
    val: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    const s = await this.load();
    if (!(key in s.settings)) return { ok: false };

    // Subdomain drives the public host AND the relay-plane slug→tenant mapping.
    // Register the slug in the RouterDO first and REJECT collisions (a slug
    // already owned by another tenant) before persisting — otherwise the host
    // would advertise a subdomain that resolves to someone else's tenant.
    if (key === "subdomain") {
      const slug =
        typeof val === "string" ? val.trim().toLowerCase() : "";
      if (slug) {
        let res: { ok: boolean; reason?: string; owner?: string };
        try {
          res = await routerRegister(this.env, slug, this.tenantId());
        } catch {
          res = { ok: false, reason: "router-unavailable" };
        }
        if (!res.ok) {
          return {
            ok: false,
            error:
              res.reason === "collision"
                ? "subdomain already taken"
                : "could not register subdomain",
          };
        }
        s.settings.subdomain = slug;
        s.host = `${slug}.finchmcp.com`;
      } else {
        // Clearing the subdomain: leave any prior RouterDO mapping in place
        // (slugs are not recycled) but drop the public host.
        s.settings.subdomain = "";
        s.host = "";
      }
    } else {
      (s.settings as any)[key] = val;
    }

    this.log(s, {
      cat: "admin",
      actor: "you",
      action: "changed setting",
      target: `${key} → ${String(val)}`,
      ip: "",
    });
    await this.save(s);
    return { ok: true };
  }

  // ---- agent / relay callbacks -------------------------------------------

  /** Agent join: register (or refresh) a machine under an appliance. Sets the
   *  appliance pending|chirping per settings.requireApproval. */
  private async registerMachine(
    appliance: string,
    machine: string,
    os: string,
    version: string,
  ): Promise<{ ok: boolean; state: ApplianceState }> {
    const s = await this.load();
    let ap = this.findAppliance(s, appliance);
    if (!ap) {
      // Join for an appliance we don't know (e.g. enrolled then evicted) —
      // create it on the fly so the machine has a home.
      ap = this.newAppliance(appliance, appliance, s.settings.defaultGroup);
      s.appliances.push(ap);
    }
    const requireApproval = s.settings.requireApproval;
    const newState: ApplianceState = requireApproval ? "pending" : "chirping";

    let m = ap.machines.find((mm) => mm.name === machine);
    if (m) {
      m.os = os;
      m.version = version;
      m.state = newState;
      m.lastSeen = "now";
      m.outdated = version !== LATEST_AGENT;
    } else {
      m = {
        name: machine,
        os,
        version,
        state: newState,
        appliance: ap.id,
        applianceLabel: ap.label,
        keys: [],
        address: "",
        outdated: version !== LATEST_AGENT,
        lastSeen: "now",
        relay: "—",
        handshake: "now",
        connected: false,
      };
      ap.machines.push(m);
    }
    ap.machineCount = ap.machines.length;
    ap.box = ap.box === "—" ? machine : ap.box;
    ap.lastSeen = "now";
    if (ap.state === "invited") ap.state = newState;

    this.log(s, {
      cat: "device",
      actor: appliance,
      action: requireApproval ? "requested approval" : "joined",
      target: machine,
      ip: "",
    });
    await this.save(s);
    return { ok: true, state: newState };
  }

  /** Relay callback on WS open/close: mark a machine connected/disconnected and
   *  recompute the appliance.state (online if any machine is connected). */
  private async markMachine(
    appliance: string,
    machine: string,
    connected: boolean,
  ): Promise<{ ok: boolean }> {
    const s = await this.load();
    const ap = this.findAppliance(s, appliance);
    if (!ap) return { ok: false };
    const m = ap.machines.find((mm) => mm.name === machine);
    if (!m) return { ok: false };
    m.connected = connected;
    // Don't override a pending (unapproved) machine's lifecycle state.
    if (m.state !== "pending") {
      m.state = connected ? "chirping" : "resting";
    }
    m.lastSeen = connected ? "now" : m.lastSeen;
    m.handshake = connected ? "now" : m.handshake;

    const anyConnected = ap.machines.some((mm) => mm.connected);
    if (ap.state !== "pending" && ap.state !== "invited") {
      ap.state = anyConnected ? "chirping" : "resting";
    }
    ap.lastSeen = anyConnected ? "now" : ap.lastSeen;

    this.log(s, {
      cat: "device",
      actor: appliance,
      action: connected ? "started chirping" : "went resting",
      target: machine,
      ip: "",
    });
    await this.save(s);
    return { ok: true };
  }

  /** Relay callback per proxied request: bump counters, roll p50/p95/err, push
   *  a capped recentCall, bump the current traffic24h bucket, append a log. */
  private async recordCall(
    appliance: string,
    machine: string,
    status: number,
    ms: number,
    caller: string,
    route: string,
  ): Promise<{ ok: boolean }> {
    const s = await this.load();
    const ap = this.findAppliance(s, appliance);
    if (!ap) return { ok: false };

    ap.calls += 1;

    // Rolling latency/error window (in-memory samples, durable counters).
    const skey = `${appliance}:${machine}`;
    const arr = this.samples.get(skey) ?? [];
    arr.push({ ms, ok: status < 400 });
    if (arr.length > ROLL_WINDOW) arr.shift();
    this.samples.set(skey, arr);

    const sorted = arr.map((x) => x.ms).sort((x, y) => x - y);
    const pct = (p: number) =>
      sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
        : 0;
    ap.p50 = pct(50);
    ap.p95 = pct(95);
    ap.err =
      +(
        (arr.filter((x) => !x.ok).length / Math.max(1, arr.length)) *
        100
      ).toFixed(2);

    // Per-route metric also reflected on the machine, if present.
    const m = ap.machines.find((mm) => mm.name === machine);
    if (m) m.lastSeen = "now";

    const call: RecentCall = {
      ago: "now",
      route,
      caller,
      status,
      ms,
    };
    ap.recentCalls.unshift(call);
    if (ap.recentCalls.length > MAX_RECENT_CALLS)
      ap.recentCalls.length = MAX_RECENT_CALLS;

    // Current hour bucket of the rolling 24h window.
    const hour = new Date().getUTCHours();
    if (!Array.isArray(ap.traffic24h) || ap.traffic24h.length !== 24)
      ap.traffic24h = Array(24).fill(0);
    ap.traffic24h[hour] = (ap.traffic24h[hour] || 0) + 1;
    if (!Array.isArray(ap.lat24h) || ap.lat24h.length !== 24)
      ap.lat24h = Array(24).fill(0);
    // Exponential-ish blend so the latency sparkline tracks recent calls.
    ap.lat24h[hour] = ap.lat24h[hour]
      ? Math.round(ap.lat24h[hour] * 0.7 + ms * 0.3)
      : ms;

    ap.lastSeen = "now";

    this.log(s, {
      cat: "request",
      actor: caller,
      action: "called",
      target: `${appliance} ${route}`,
      ip: "",
      result: status,
    });
    await this.save(s);
    return { ok: true };
  }

  // ---- key check + ACL evaluation (MCP router) ---------------------------

  /** Given the sha-256 hash of a presented finch_ key and the target appliance,
   *  decide if the call is allowed. TWO gates, BOTH must pass (default-deny):
   *
   *   1. KEY SCOPE — the key's scope must be "all appliances"/"*" or list the
   *      appliance id (the existing per-key coarse gate, kept as a floor).
   *   2. ACL — the tenant's acl rules must contain at least one `allow` rule
   *      whose src matches this key's identity (key label/id, the key owner as a
   *      user, or a group the owner/key belongs to) AND whose dst matches the
   *      target appliance (by appliance id, one of its tags, its group, or
   *      `all`). An owner/admin "allow all" rule is honored. No matching allow
   *      rule → denied. This is the "enforced at the door" promise made real.
   *
   *  Returns the key's label for logging / attribution and a `reason` for the
   *  denial (so the relay can return a precise 403). */
  private async checkKey(
    hash: string,
    appliance: string,
  ): Promise<{
    allowed: boolean;
    keyLabel: string;
    reason?: "no-key" | "scope" | "acl";
  }> {
    const s = await this.load();
    const key = s.keys.find((k) => k.hash === hash);
    if (!key) return { allowed: false, keyLabel: "", reason: "no-key" };

    // Gate 1: key scope (coarse floor).
    const scope = (key.scope || "").trim().toLowerCase();
    const scopeOk =
      scope === "all appliances" ||
      scope === "all" ||
      scope === "*" ||
      scope
        .split(",")
        .map((x) => x.trim())
        .includes(appliance.toLowerCase());
    if (!scopeOk) {
      return { allowed: false, keyLabel: key.label, reason: "scope" };
    }

    // Gate 2: ACL evaluation (default-deny).
    const aclOk = this.evalAccess(s, key, appliance);
    if (!aclOk) {
      return { allowed: false, keyLabel: key.label, reason: "acl" };
    }

    return { allowed: true, keyLabel: key.label };
  }

  /** Evaluate the tenant's ACL rules for a key reaching an appliance.
   *  Default-deny: returns true iff at least one `allow` rule's src matches the
   *  key's identity AND its dst matches the target appliance. */
  private evalAccess(s: StoredState, key: Key, appliance: string): boolean {
    const ap = this.findAppliance(s, appliance);
    if (!ap) return false;

    // The identities this key presents as a rule SOURCE.
    const ident = this.keyIdentities(s, key);

    // The descriptors this appliance matches as a rule DESTINATION.
    const apTags = new Set((ap.tags || []).map((t) => t.toLowerCase()));
    const apGroup = (ap.group || "").toLowerCase();
    const apId = (ap.id || "").toLowerCase();

    for (const rule of s.acl) {
      if (rule.action !== "allow") continue;
      if (!this.srcMatches(rule.src, ident)) continue;
      const dsts = Array.isArray(rule.dst) ? rule.dst : [rule.dst];
      for (const d of dsts) {
        if (d.type === "all") return true;
        const dn = (d.name || "").toLowerCase();
        if (d.type === "appliance" && dn === apId) return true;
        if (d.type === "tag" && apTags.has(dn)) return true;
        if (d.type === "group" && dn === apGroup) return true;
      }
    }
    return false;
  }

  /** The set of ACL src identities a key presents: itself (as a key, by label
   *  AND id), its owner (as a user), and any groups the owner/key-label belong
   *  to. Lowercased for case-insensitive matching. */
  private keyIdentities(
    s: StoredState,
    key: Key,
  ): { keys: Set<string>; users: Set<string>; groups: Set<string> } {
    const keys = new Set<string>();
    if (key.label) keys.add(key.label.toLowerCase());
    if (key.id) keys.add(key.id.toLowerCase());

    const users = new Set<string>();
    if (key.owner) users.add(key.owner.toLowerCase());

    const groups = new Set<string>();
    for (const g of s.groups || []) {
      const members = (g.members || []).map((m) => m.toLowerCase());
      if (
        (key.owner && members.includes(key.owner.toLowerCase())) ||
        (key.label && members.includes(key.label.toLowerCase()))
      ) {
        groups.add((g.name || "").toLowerCase());
      }
    }
    return { keys, users, groups };
  }

  /** Does a rule's src entity match one of the key's identities? */
  private srcMatches(
    src: AclEntity,
    ident: { keys: Set<string>; users: Set<string>; groups: Set<string> },
  ): boolean {
    const n = (src.name || "").toLowerCase();
    switch (src.type) {
      case "all":
        return true;
      case "key":
        return ident.keys.has(n);
      case "user":
        return ident.users.has(n);
      case "group":
        return ident.groups.has(n);
      default:
        return false;
    }
  }
}

// ---- ACL label helper (for log targets) -----------------------------------
function aclLabel(e: AclEntity): string {
  if (e.type === "all") return "all appliances";
  return e.name ? `${e.type}:${e.name}` : e.type;
}
