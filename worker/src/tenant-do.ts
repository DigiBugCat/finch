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
  type KeyScope,
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
  // Spent join-ticket ids (M1): jti -> the ticket's exp (epoch SECONDS). A jti
  // is recorded on first successful /join and rejected thereafter; entries are
  // evicted once expired (a replay past exp is already rejected by verifyToken).
  usedTickets?: Record<string, number>;
  // Monotonic counter embedded in CLI tokens at mint. Bumped by "revoke all CLI
  // tokens"; a token whose epoch != this is rejected. Absent == 0 (legacy state).
  cliTokenEpoch?: number;
  // Monotonic counter stamped into the browser login-wall session cookie at mint
  // (/__finch/cb). Bumped by "bumpSessionEpoch" ("sign everyone out"); browserGate
  // rejects a cookie whose epoch != this. Absent == 0 (legacy state). Mirrors
  // cliTokenEpoch exactly.
  sessionEpoch?: number;
}

const MAX_LOGS = 500;
const MAX_RECENT_CALLS = 20;
const ROLL_WINDOW = 50; // calls kept for the rolling p50/p95/err estimate

// Growth caps (M5 / M1): bound state so a flood of joins can't grow a DO
// unbounded.
const MAX_APPLIANCES_PER_TENANT = 200;
const MAX_MACHINES_PER_APPLIANCE = 100;

// Machine-name validation (M1): the box picks its own name, so clamp it to a
// sane length + charset before it pollutes the registry / squats a slot.
const MAX_MACHINE_NAME = 64;
const MACHINE_NAME_RE = /^[A-Za-z0-9 ._\-]+$/;

/** Validate + normalize an agent-supplied machine name. Returns the trimmed
 *  name, or null if it's empty, too long, or carries disallowed characters. */
function cleanMachineName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > MAX_MACHINE_NAME) return null;
  if (!MACHINE_NAME_RE.test(name)) return null;
  return name;
}

const MS_PER_HOUR = 3_600_000;

/** Absolute epoch-hour for a ms timestamp (used to anchor the 24h buckets). */
function epochHour(ms: number): number {
  return Math.floor(ms / MS_PER_HOUR);
}

/** Format an epoch-ms timestamp as a short relative string. 0/undefined →
 *  "never". This is the single place "lastSeen"/"handshake"/"ago" strings are
 *  produced — a DO can't run a clock between requests, so we always derive these
 *  on READ from a stored timestamp rather than freezing a literal "now". */
function timeAgo(ts?: number, now = Date.now()): string {
  if (!ts || ts <= 0) return "never";
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** UNIFIED liveness for a machine: online iff it holds a live relay socket AND
 *  has been approved (state !== "pending"). The two former read paths
 *  (getState's isOnline(state) and pickHealthyMachine's connected||chirping)
 *  now share this one rule, so the dashboard and the LB picker can't disagree
 *  about which machines are reachable. */
function machineOnline(m: { connected?: boolean; state: ApplianceState }): boolean {
  return !!m.connected && m.state !== "pending";
}

/** Rotate a 24-slot bucket array (anchored at absolute epoch-hour
 *  `lastBucketHour`) into a TRAILING-24h window where index 23 = the current
 *  hour. Buckets older than 24h drop off; gaps between the last write and now are
 *  zeroed. With no anchor (legacy state) we treat the array as already current.
 *  Pure — used on READ; recordCall ages buckets in place on WRITE. */
function rollBuckets(
  raw: number[] | undefined,
  lastBucketHour: number | undefined,
  now: number,
): number[] {
  const out = Array<number>(24).fill(0);
  if (!Array.isArray(raw) || raw.length !== 24) return out;
  if (typeof lastBucketHour !== "number") {
    // Legacy/un-anchored: best-effort passthrough (caller's old hour-of-day
    // layout). Copy as-is so we don't lose the only history we have.
    for (let i = 0; i < 24; i++) out[i] = raw[i] || 0;
    return out;
  }
  const nowHour = epochHour(now);
  for (let i = 0; i < 24; i++) {
    // raw[i] holds the count for absolute hour (lastBucketHour - 23 + i).
    const absHour = lastBucketHour - 23 + i;
    const age = nowHour - absHour; // 0 = current hour, 23 = oldest still in window
    if (age < 0 || age > 23) continue; // future (clock skew) or aged out
    out[23 - age] += raw[i] || 0;
  }
  return out;
}

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
        case "cliEpoch":
          return ok(await this.cliEpoch());
        case "revokeCliTokens":
          return ok(await this.revokeCliTokens());
        case "sessionEpoch":
          return ok(await this.sessionEpoch());
        case "bumpSessionEpoch":
          return ok(await this.bumpSessionEpoch());
        case "decline":
          return ok(await this.decline(a.id));
        case "setTags":
          return ok(await this.setTags(a.id, a.tags));
        case "setGroup":
          return ok(await this.setGroup(a.id, a.group));
        case "setAuth":
          return ok(await this.setAuth(a.appliance ?? a.id, a.mode));
        case "mintKey": {
          const r = await this.mintKey(a.label, a.scope, a.owner);
          if ("error" in r) return bad(400, r.error);
          return ok(r);
        }
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
        case "registerMachine": {
          const r = await this.registerMachine(
            a.appliance,
            a.machine,
            a.os,
            a.version,
          );
          if (r.error) return bad(409, r.error);
          return ok(r);
        }
        case "markMachine":
          return ok(
            await this.markMachine(a.appliance, a.machine, a.connected),
          );
        case "claimTicket":
          return ok(await this.claimTicket(a.jti, a.exp));
        case "machineExists":
          return ok(await this.machineExists(a.appliance, a.machine));
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
      usedTickets: {},
      cliTokenEpoch: 0,
      sessionEpoch: 0,
      settings: {
        org: id,
        subdomain: "",
        requireApproval: true,
        defaultGroup: "default",
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
    // `ago` is derived from `ts` on read (getState); store an empty placeholder
    // so a stale literal is never persisted.
    s.logs.unshift({ ...ev, ts, ago: "" });
    if (s.logs.length > MAX_LOGS) s.logs.length = MAX_LOGS;
  }

  // ---- derivation (read-side) --------------------------------------------

  /** Build the public TenantState: flatten machines, derive appliance.state
   *  from machines, recompute `outdated`, compute the overview, strip key
   *  hashes. Never persisted — always recomputed from the stored record. */
  private async getState(): Promise<TenantState> {
    const s = await this.load();
    const now = Date.now();

    const appliances: Appliance[] = s.appliances.map((a) => {
      const machines = (a.machines ?? []).map((m) => ({
        ...m,
        appliance: a.id,
        applianceLabel: a.label,
        outdated: m.version !== LATEST_AGENT,
        // Derive the relative-time display strings on read from stored epoch-ms.
        lastSeen: timeAgo(m.lastSeenAt, now),
        handshake: timeAgo(m.handshakeAt, now),
      }));
      // appliance.state derives from its machines: online if any machine is
      // online. Liveness is UNIFIED across read paths: a machine is online iff
      // it holds a live relay socket AND has been approved (state !== pending) —
      // the same rule pickHealthyMachine uses. With no machines we keep the
      // appliance's own lifecycle state (invited/pending/resting) untouched.
      let state: ApplianceState = a.state;
      if (machines.length) {
        const anyOnline = machines.some((m) => machineOnline(m));
        const anyPending = machines.some((m) => m.state === "pending");
        state = anyOnline ? "chirping" : anyPending ? "pending" : "resting";
      }
      const version = machines.length ? machines[0].version : a.version;
      const outdated =
        state !== "invited" &&
        (machines.length
          ? machines.some((m) => m.outdated)
          : version !== LATEST_AGENT);
      // Roll the 24h buckets to a trailing window with index 23 = current hour.
      const traffic24h = rollBuckets(a.traffic24h, a.lastBucketHour, now);
      const latency24h = rollBuckets(a.lat24h, a.lastBucketHour, now);
      return {
        ...a,
        auth: a.auth ?? "key", // legacy appliances predate this field → key-gated
        state,
        machines,
        machineCount: machines.length,
        version,
        outdated,
        lastSeen: timeAgo(a.lastSeenAt, now),
        traffic24h,
        lat24h: latency24h,
        recentCalls: (a.recentCalls ?? []).map((c) => ({
          ...c,
          ago: timeAgo(c.ts, now),
        })),
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

    const logs: LogEvent[] = (s.logs ?? []).map((ev) => ({
      ...ev,
      ago: timeAgo(ev.ts, now),
    }));

    return {
      host: s.host,
      appliances,
      machines,
      keys: publicKeys,
      groups: s.groups,
      acl: s.acl,
      logs,
      settings: s.settings,
      overview: this.overview(
        appliances,
        s.keys,
        now,
        !!s.settings.enforceExpiry,
      ),
      latestAgent: LATEST_AGENT,
    };
  }

  private overview(
    appliances: Appliance[],
    keys: Key[],
    now: number,
    enforceExpiry: boolean,
  ): Overview {
    // The fleet's 24h HISTORY is built over ALL appliances (the buckets here are
    // already rolled to a trailing window, index 23 = now). Building it only over
    // currently-online appliances made a resting box's stored history vanish the
    // moment it idled — the chart must still show the traffic it served.
    const traffic24h = Array.from({ length: 24 }, (_, h) =>
      appliances.reduce((sum, a) => sum + (a.traffic24h[h] || 0), 0),
    );
    const latency24h = Array.from({ length: 24 }, (_, h) => {
      const vals = appliances
        .map((a) => a.lat24h[h])
        .filter((v): v is number => typeof v === "number" && v > 0);
      return vals.length
        ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length)
        : 0;
    });
    const callsToday = traffic24h.reduce((s, v) => s + v, 0);

    // activeNow / total reflect the LIVE fleet; p50/p95/err are quality-of-
    // service numbers for the boxes currently serving (an idle box's stale
    // rolling window shouldn't drag the live SLO).
    const on = appliances.filter((a) => isOnline(a.state));

    // Active keys = not-yet-expired keys (expiry only enforced if the tenant
    // turned it on; here we just don't count an over-expiry key as active).
    const keysActive = enforceExpiry
      ? keys.filter((k) => !(k.expiresAt && now > k.expiresAt)).length
      : keys.length;

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
      keysActive,
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

  /** Lowercase a string into a host-safe slug; `fallback` if it reduces empty.
   *  Used for both appliance ids (from name) and the default subdomain (from id). */
  private slugify(raw: string, fallback: string): string {
    return (
      raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || fallback
    );
  }

  /** This DO is keyed by the REAL tenant id (Clerk org/user id). */
  private tenantId(): string {
    return this.ctx.id.name ?? "";
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
      handshake: "never", // display-only; machine.handshake is timestamp-derived
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
      lastSeen: "never", // derived from lastSeenAt on read
      lastSeenAt: 0,
      uptime: "—",
      blurb: "Ticket minted — waiting for the box to phone home.",
      group,
      version: LATEST_AGENT,
      tags: [],
      outdated: false,
      auth: "key", // key-gated by default; flip to "public" for a public webpage
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
      lastBucketHour: epochHour(Date.now()),
      recentCalls: [],
      conn: this.emptyConn(),
    };
  }

  // ---- CLI token epoch (revocation without rotating the global secret) ----

  private async cliEpoch(): Promise<{ epoch: number }> {
    const s = await this.load();
    return { epoch: s.cliTokenEpoch ?? 0 };
  }

  private async revokeCliTokens(): Promise<{ ok: boolean; epoch: number }> {
    const s = await this.load();
    s.cliTokenEpoch = (s.cliTokenEpoch ?? 0) + 1;
    this.log(s, { cat: "key", actor: "you", action: "revoked all CLI tokens", target: "cli access", ip: "" });
    await this.save(s);
    return { ok: true, epoch: s.cliTokenEpoch };
  }

  // ---- session epoch (browser login-wall "sign everyone out") -------------
  // Exact mirror of the cliTokenEpoch pair: /__finch/cb stamps the CURRENT
  // sessionEpoch into the cookie at mint; browserGate rejects a cookie whose
  // epoch != this. bumpSessionEpoch increments it, invalidating every live
  // session cookie at once — without rotating the global SESSION_SECRET.

  private async sessionEpoch(): Promise<{ epoch: number }> {
    const s = await this.load();
    return { epoch: s.sessionEpoch ?? 0 };
  }

  private async bumpSessionEpoch(): Promise<{ ok: boolean; epoch: number }> {
    const s = await this.load();
    s.sessionEpoch = (s.sessionEpoch ?? 0) + 1;
    this.log(s, { cat: "access", actor: "you", action: "signed out all sessions", target: "web access", ip: "" });
    await this.save(s);
    return { ok: true, epoch: s.sessionEpoch };
  }

  // ---- mutations: appliances ---------------------------------------------

  /** Move an appliance to a group (creating it if new; pruning a now-empty old
   *  group). Empty string clears the group. */
  private async setGroup(id: string, group: string): Promise<{ ok: boolean }> {
    const s = await this.load();
    const ap = this.findAppliance(s, id);
    if (!ap) return { ok: false };
    const old = ap.group;
    ap.group = group || "";
    if (group && !s.groups.some((g) => g.name === group)) {
      s.groups.push({ name: group, members: ["you"] });
    }
    if (old && old !== group && !s.appliances.some((a) => a.group === old)) {
      s.groups = s.groups.filter((g) => g.name !== old);
    }
    this.log(s, { cat: "admin", actor: "you", action: "moved to group", target: `${id} → ${group || "—"}`, ip: "" });
    await this.save(s);
    return { ok: true };
  }

  private async enroll(
    name: string,
    group?: string,
  ): Promise<{ id: string }> {
    const s = await this.load();
    let id = this.slugify(name, "appliance");
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
    // public relay URL resolves. If the base slug collides (two tenant ids that
    // slugify identically — e.g. differing only in punctuation/case), retry with
    // a numeric suffix so every tenant still gets a working default host rather
    // than being silently left with no public URL. Bounded so a pathological
    // collision run can't loop forever; if even that fails the tenant picks one.
    if (!s.settings.subdomain) {
      const base = this.slugify(this.tenantId(), "tenant");
      for (let n = 0; n < 20; n++) {
        const slug = n === 0 ? base : `${base}-${n + 1}`;
        if (await this.registerSlug(slug)) {
          s.settings.subdomain = slug;
          s.host = `${slug}.finchmcp.com`;
          break;
        }
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
    // Approve = clear the pending gate. Liveness is then owned by markMachine: an
    // approved-but-disconnected machine must read "resting", not "chirping". So
    // derive from m.connected rather than flipping straight to chirping.
    for (const m of ap.machines) {
      if (m.state === "pending") m.state = m.connected ? "chirping" : "resting";
    }
    if (ap.state === "pending") {
      const anyConnected = ap.machines.some((mm) => mm.connected);
      ap.state = anyConnected ? "chirping" : "resting";
    }
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

  /** Flip an appliance's public-relay access mode between "key" (require a
   *  finch_ bearer) and "public" (open webpage). The control-plane half of the
   *  generic-HTTP-hosting feature; the relay reads it via checkKey. */
  private async setAuth(
    id: string,
    mode: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    if (mode !== "key" && mode !== "public") {
      return { ok: false, error: 'mode must be "key" or "public"' };
    }
    const s = await this.load();
    const ap = this.findAppliance(s, id);
    if (!ap) return { ok: false, error: "unknown service" };
    ap.auth = mode;
    this.log(s, {
      cat: "device",
      actor: "you",
      action: "set-auth",
      target: `${id} → ${mode}`,
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
    scope?: KeyScope,
    owner?: string,
  ): Promise<
    { plaintext: string; key: PublicKey } | { error: string }
  > {
    const s = await this.load();

    // Validate + normalize the structured scope. Default is LEAST-PRIVILEGE:
    // no scope (or an empty appliance list) mints a key that reaches nothing
    // until the operator scopes it — never a fleet-wide key by accident. Every
    // listed appliance id MUST exist (400 on an unknown id) so a key can't carry
    // dangling free-text that silently grants or denies.
    const normScope = this.normalizeScope(s, scope);
    if ("error" in normScope) return { error: normScope.error };

    const plaintext = genFinchKey();
    const hash = await hashKey(plaintext);
    const now = Date.now();
    const key: Key = {
      id: "k_" + crypto.randomUUID().slice(0, 8),
      label,
      owner: owner || "you",
      created: new Date(now).toISOString().slice(0, 10),
      scope: normScope.scope,
      hash,
      last4: last4(plaintext),
      // Stamp the absolute expiry from the tenant's keyExpiry policy. Enforcement
      // is gated by settings.enforceExpiry at checkKey time; we always stamp so
      // flipping the toggle on takes effect immediately for new keys.
      expiresAt: this.expiryFromSettings(s, now),
    };
    s.keys.push(key);

    // Populate the display lists (#10): attach the key's ID to every appliance
    // it can reach (and that appliance's machines), so the per-machine /
    // per-appliance key chips actually render — and revokeMachineKey (which now
    // works by id) has lists to prune. {all:true} reaches every appliance.
    const reach: StoredAppliance[] =
      "all" in normScope.scope && normScope.scope.all === true
        ? s.appliances
        : s.appliances.filter((a) =>
            (normScope.scope as { appliances: string[] }).appliances.includes(
              a.id,
            ),
          );
    for (const a of reach) {
      if (!a.keys.includes(key.id)) a.keys.push(key.id);
      for (const m of a.machines) {
        if (!m.keys.includes(key.id)) m.keys.push(key.id);
      }
    }

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

  /** Validate + normalize an incoming KeyScope. {all:true} passes through; an
   *  appliance list is filtered to existing ids (unknown id → 400). A missing or
   *  empty scope defaults to an explicit empty allow-list (least privilege). */
  private normalizeScope(
    s: StoredState,
    scope?: KeyScope,
  ): { scope: KeyScope } | { error: string } {
    if (scope && "all" in scope && scope.all === true) {
      return { scope: { all: true } };
    }
    const ids = Array.isArray((scope as any)?.appliances)
      ? ((scope as any).appliances as unknown[]).map(String)
      : [];
    const unknown = ids.filter((id) => !this.findAppliance(s, id));
    if (unknown.length) {
      return { error: `unknown service id(s): ${unknown.join(", ")}` };
    }
    // De-dupe; least-privilege default is the explicit empty list.
    return { scope: { appliances: Array.from(new Set(ids)) } };
  }

  /** Absolute expiry (epoch ms) for a key, from settings.keyExpiry. "never" (or
   *  an unparseable value) → undefined (no expiry stamped). */
  private expiryFromSettings(s: StoredState, now: number): number | undefined {
    const raw = (s.settings.keyExpiry || "").trim().toLowerCase();
    if (!raw || raw === "never") return undefined;
    const m = raw.match(/^(\d+)\s*day/);
    if (!m) return undefined;
    const days = parseInt(m[1], 10);
    if (!Number.isFinite(days) || days <= 0) return undefined;
    return now + days * 24 * MS_PER_HOUR;
  }

  private async revokeMachineKey(
    appliance: string,
    machine: string,
    key: string,
  ): Promise<{ ok: boolean }> {
    const s = await this.load();
    // `key` is the Key.id (the dashboard sends the id). REVOKE BY ID so the
    // change actually takes effect: checkKey authorizes by sha-256(plaintext)
    // hash, so dropping the Key whose id matches removes the only record the
    // hash lookup can hit. (The old label-match could over-revoke on duplicate
    // labels and, worse, leave the authorizing Key in place if labels drifted.)
    const before = s.keys.length;
    const target = s.keys.find((k) => k.id === key);
    s.keys = s.keys.filter((k) => k.id !== key);
    let touched = s.keys.length !== before;

    // Drop the id from the display lists everywhere it appears so the per-machine
    // / per-appliance key chips stop rendering a now-dead key.
    for (const a of s.appliances) {
      if (a.keys.includes(key)) {
        a.keys = a.keys.filter((k) => k !== key);
        touched = true;
      }
      for (const m of a.machines) {
        if (m.keys.includes(key)) {
          m.keys = m.keys.filter((k) => k !== key);
          touched = true;
        }
      }
    }

    this.log(s, {
      cat: "key",
      actor: "you",
      action: "revoked key",
      target: `${target?.label ?? key} @ ${appliance}/${machine}`,
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

  /** Atomically claim a one-time join-ticket id (M1 replay protection). A DO
   *  runs one request at a time, so the read-check-write here is atomic: the
   *  first /join with a given jti records it and returns {ok:true}; any replay
   *  (until the ticket's own exp, after which verifyToken already rejects it)
   *  returns {ok:false}. Expired jtis are evicted on each claim so the used-set
   *  can't grow without bound. A ticket WITHOUT a jti (legacy) is allowed through
   *  — its exp still bounds replayability. */
  private async claimTicket(
    jti: unknown,
    exp: unknown,
  ): Promise<{ ok: boolean }> {
    if (typeof jti !== "string" || !jti) return { ok: true }; // legacy ticket
    const s = await this.load();
    const used = s.usedTickets ?? (s.usedTickets = {});
    const nowSec = Math.floor(Date.now() / 1000);
    // Evict expired entries so the map stays bounded.
    for (const [k, e] of Object.entries(used)) {
      if (typeof e !== "number" || e <= nowSec) delete used[k];
    }
    if (used[jti]) {
      await this.save(s); // persist the eviction even on a rejected replay
      return { ok: false };
    }
    used[jti] = typeof exp === "number" && exp > nowSec ? exp : nowSec + 3600;
    await this.save(s);
    return { ok: true };
  }

  /** True iff `machine` is currently registered under `appliance`. Used by the
   *  /refresh endpoint so a machine removed from the dashboard can no longer mint
   *  fresh connect-tokens — revocation takes effect within one connect-token TTL. */
  private async machineExists(
    appliance: unknown,
    machine: unknown,
  ): Promise<{ exists: boolean }> {
    if (typeof appliance !== "string" || typeof machine !== "string") {
      return { exists: false };
    }
    const s = await this.load();
    const ap = this.findAppliance(s, appliance);
    if (!ap) return { exists: false };
    return { exists: ap.machines.some((m) => m.name === machine) };
  }

  /** Agent join: register (or refresh) a machine under an appliance. Sets the
   *  appliance pending|chirping per settings.requireApproval. */
  private async registerMachine(
    appliance: string,
    machine: string,
    os: string,
    version: string,
  ): Promise<{ ok: boolean; state?: ApplianceState; error?: string }> {
    // Validate/clamp the machine name at the DATA layer too (defense-in-depth;
    // api.ts also clamps at the /join door). (security M1)
    const cleaned = cleanMachineName(machine);
    if (!cleaned) return { ok: false, error: "invalid box name" };
    machine = cleaned;

    const s = await this.load();
    let ap = this.findAppliance(s, appliance);
    if (!ap) {
      // Join for an appliance we don't know (e.g. enrolled then evicted) —
      // create it on the fly so the machine has a home. Cap appliances-per-tenant
      // so a flood of joins to unknown ids can't grow the DO unbounded (M5).
      if (s.appliances.length >= MAX_APPLIANCES_PER_TENANT) {
        return { ok: false, error: "service limit reached for tenant" };
      }
      ap = this.newAppliance(appliance, appliance, s.settings.defaultGroup);
      s.appliances.push(ap);
    }
    const requireApproval = s.settings.requireApproval;
    // The state a GENUINELY NEW machine starts in.
    const newState: ApplianceState = requireApproval ? "pending" : "chirping";
    const now = Date.now();

    let m = ap.machines.find((mm) => mm.name === machine);
    if (m) {
      // RE-JOIN of a known machine (agent restart): refresh os/version/lastSeen
      // but DO NOT clobber its lifecycle state. Re-stamping pending|chirping here
      // would demote an already-approved, live box back to pending on every agent
      // restart. The only legitimate demotion is leaving "invited"; markMachine
      // owns connected↔chirping/resting transitions from here on. A still-pending
      // machine stays pending (re-approval not retriggered).
      m.os = os;
      m.version = version;
      m.lastSeenAt = now;
      m.outdated = version !== LATEST_AGENT;
      if (m.state === "invited") m.state = newState;
    } else {
      // Genuinely new machine. Cap machines-per-appliance (M1/M5): bound name
      // squatting + unbounded DO creation behind a single ticket.
      if (ap.machines.length >= MAX_MACHINES_PER_APPLIANCE) {
        return { ok: false, error: "box limit reached for service" };
      }
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
        lastSeenAt: now,
        relay: "—",
        handshake: "never",
        handshakeAt: 0,
        connected: false,
      };
      ap.machines.push(m);
    }
    ap.machineCount = ap.machines.length;
    ap.box = ap.box === "—" ? machine : ap.box;
    ap.lastSeenAt = now;
    // Promote the appliance out of "invited" on first real join; never demote an
    // approved appliance back to pending on a re-join.
    if (ap.state === "invited") ap.state = newState;

    this.log(s, {
      cat: "device",
      actor: appliance,
      action: requireApproval ? "requested approval" : "joined",
      target: machine,
      ip: "",
    });
    await this.save(s);
    return { ok: true, state: m.state };
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
    const now = Date.now();
    m.connected = connected;
    // markMachine is the SOLE authority for connected↔chirping/resting. Don't
    // override a pending (unapproved) machine's lifecycle state.
    if (m.state !== "pending") {
      m.state = connected ? "chirping" : "resting";
    }
    if (connected) {
      m.lastSeenAt = now;
      m.handshakeAt = now;
    }

    const anyConnected = ap.machines.some((mm) => mm.connected);
    if (ap.state !== "pending" && ap.state !== "invited") {
      ap.state = anyConnected ? "chirping" : "resting";
    }
    if (anyConnected) ap.lastSeenAt = now;

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

    const now = Date.now();

    // Per-route metric also reflected on the machine, if present.
    const m = ap.machines.find((mm) => mm.name === machine);
    if (m) m.lastSeenAt = now;

    const call: RecentCall = {
      ts: now,
      ago: "", // derived from ts on read
      route,
      caller,
      status,
      ms,
    };
    ap.recentCalls.unshift(call);
    if (ap.recentCalls.length > MAX_RECENT_CALLS)
      ap.recentCalls.length = MAX_RECENT_CALLS;

    // 24h buckets keyed by ABSOLUTE epoch-hour, not hour-of-day. Age the stored
    // window forward to `now` first (zeroing every hour elapsed since the last
    // write) so a slot can't accumulate every day's hour-h traffic forever; then
    // write into the current (now) slot. Stamp lastBucketHour so the next write
    // (and getState's read-side rotation) knows the anchor.
    const nowHour = epochHour(now);
    if (!Array.isArray(ap.traffic24h) || ap.traffic24h.length !== 24)
      ap.traffic24h = Array(24).fill(0);
    if (!Array.isArray(ap.lat24h) || ap.lat24h.length !== 24)
      ap.lat24h = Array(24).fill(0);
    ap.traffic24h = rollBuckets(ap.traffic24h, ap.lastBucketHour, now);
    ap.lat24h = rollBuckets(ap.lat24h, ap.lastBucketHour, now);
    ap.lastBucketHour = nowHour;
    // Index 23 is always the current hour after rolling.
    ap.traffic24h[23] = (ap.traffic24h[23] || 0) + 1;
    // Exponential-ish blend so the latency sparkline tracks recent calls.
    ap.lat24h[23] = ap.lat24h[23]
      ? Math.round(ap.lat24h[23] * 0.7 + ms * 0.3)
      : ms;

    ap.lastSeenAt = now;

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
    public?: boolean;
    reason?: "no-key" | "scope" | "acl" | "expired";
  }> {
    const s = await this.load();

    // Gate −1: PUBLIC appliance. A public appliance (an ngrok-style open webpage)
    // needs no finch_ key — allow regardless of what (if anything) was presented,
    // BEFORE the key lookup so a missing/empty hash still passes. `public:true`
    // tells the relay to label the caller "public" and skip the bearer 401.
    // (auth defaults to "key" when the field is absent → fail-closed.)
    const ap = this.findAppliance(s, appliance);
    if (ap && ap.auth === "public") {
      return { allowed: true, keyLabel: "public", public: true };
    }

    const key = s.keys.find((k) => k.hash === hash);
    if (!key) return { allowed: false, keyLabel: "", reason: "no-key" };

    // Gate 0: expiry. Only enforced when the tenant flips settings.enforceExpiry
    // on — the toggle is no longer cosmetic. A key with no stamped expiry never
    // expires (e.g. minted under keyExpiry="never").
    if (
      s.settings.enforceExpiry &&
      key.expiresAt &&
      Date.now() > key.expiresAt
    ) {
      return { allowed: false, keyLabel: key.label, reason: "expired" };
    }

    // Gate 1: key scope (structured — {all:true} or an explicit appliance list).
    const scope = key.scope;
    const scopeOk =
      !!scope &&
      ("all" in scope && scope.all === true
        ? true
        : Array.isArray((scope as any).appliances) &&
          (scope as any).appliances.includes(appliance));
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
  if (e.type === "all") return "all services";
  return e.name ? `${e.type}:${e.name}` : e.type;
}
