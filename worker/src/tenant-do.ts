/// <reference types="@cloudflare/workers-types" />
//
// TenantDO — one Durable Object per tenant. A tenant is one Clerk user: its id
// is that user's Clerk user id, and that user is its only member (the owner).
// It owns the tenant's entire control-plane state: services, the boxes that
// run them, finch_ keys, settings, and the activity log.
//
// Data written by the retired team, sharing and Aviary features is deleted
// once per tenant by purgeLegacyTenancy, on the first request after the
// single-user migration deploys. GET /api/state returns exactly the projection
// this DO computes; the agent join flow, the relay (BoxDO), and the MCP router
// all reach in here via internal RPC.
//
// RPC shape: POST a JSON body { op, ...args } to this DO's fetch(); it returns
// JSON. index.ts/api.ts marshal HTTP <-> these ops; this module is pure state.
//
// Storage model: we keep a single STORED record in this.ctx.storage under the
// key "state". That record is the source of truth and holds the full Key
// objects (hash + last4). getState() derives the public TenantState from it —
// flattening boxes, deriving each service.state from its boxes,
// recomputing `outdated`, building the overview, and stripping key hashes — so
// derived fields are never persisted stale. Every mutation persists the stored
// record and appends a LogEvent.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { genFinchKey, hashKey, last4 } from "./auth";
import { routerRegister, routerRegisterWakingHolder, routerStub, routerTransfer } from "./router-do";
import {
  type TenantState,
  type Service,
  type Box,
  type Key,
  type KeyScope,
  type PublicKey,
  type LogEvent,
  type StoredLogEvent,
  type Settings,
  type Overview,
  type RecentCall,
  type ServiceState,
  type TenantMember,
  type TenantMeta,
  normalizeEmail,
  isOnline,
  normalizeState,
  LATEST_AGENT,
} from "./types";

// ---- stored shape ---------------------------------------------------------
// What actually lives in this.ctx.storage. It mirrors TenantState but holds
// full Key objects (with hash), and stores services WITHOUT the derived
// fields that getState() recomputes (state/boxes/outdated/metrics live on
// the service, but `boxes` flatten + overview are computed on read).

type StoredService = Service;

interface StoredState {
  host: string;
  services: StoredService[];
  keys: Key[]; // full keys incl. hash — never leaves the DO as-is
  // StoredLogEvent, not LogEvent: rows carry the `svc` subject metadata that
  // getState strips on the way out.
  logs: StoredLogEvent[];
  settings: Settings;
  // Spent join-ticket ids (M1): jti -> the ticket's exp (epoch SECONDS). A jti
  // is recorded on first successful /join and rejected thereafter; entries are
  // evicted once expired (a replay past exp is already rejected by verifyToken).
  usedTickets?: Record<string, number>;
  // Monotonic counter embedded in CLI tokens at mint. Bumped by "revoke all CLI
  // tokens"; a token whose epoch != this is rejected. Absent == 0 (legacy state).
  cliTokenEpoch?: number;
  // The version of the single-user purge this record has been through (see
  // purgeLegacyTenancy). Born current on a tenant created after it shipped.
  singleUserPurge?: number;
  // Set by the purge on an ownerless (team/org) tenant that had exactly one
  // active owner: that user's Clerk id. handOffRoutes moves this tenant's
  // RouterDO hosts to their tenant, then deletes the field.
  routeHeir?: string;
  // Services whose boxes the purge removed: the next `finch add` of each
  // re-enrolls it in place instead of de-duping to "<id>-2" (see enroll).
  reenroll?: string[];
  tenantMeta?: TenantMeta;
  // At most one row: the owner, whose clerkUserId is the tenant id.
  members: TenantMember[];
}

// Bump to run purgeLegacyTenancy again over every tenant (and extend it to
// cover whatever the new version removes). Never lower it.
export const SINGLE_USER_PURGE_VERSION = 1;

// Stored fields the retired features wrote, deleted by the purge.
const LEGACY_STATE_FIELDS = [
  "groups", // named member/key groups (ACL sources)
  "acl", // ACL rules, including the locked r_owner rule
  "accessRequests", // the app-level access-sharing queue
  "sessionEpoch", // the browser login wall's sign-out epoch
  "cliSingleUserCut", // the flag of the earlier CLI-token-only cut
] as const;
const LEGACY_SERVICE_FIELDS = [
  "aviaryManaged",
  "aviaryManifestSha256",
  "aviaryApprovalNonce",
] as const;
const LEGACY_BOX_FIELDS = [
  "aviaryCredentialEpoch",
  "aviaryPendingCredentialEpoch",
  "aviaryPendingApprovalNonce",
] as const;

const MAX_LOGS = 500;
const MAX_RECENT_CALLS = 20;
const ROLL_WINDOW = 50; // calls kept for the rolling p50/p95/err estimate

// Growth caps (M5 / M1): bound state so a flood of joins can't grow a DO
// unbounded.
const MAX_SERVICES_PER_TENANT = 200;
const MAX_BOXES_PER_SERVICE = 100;
const MAX_SERVICE_ID = 63;
// Shared contract with the Go agent and web service routes: one ASCII URL
// segment, with punctuation allowed only between alphanumeric endpoints.
const SERVICE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
// A tenant subdomain is a single DNS label — no dots. Deliberately stricter
// than router-do's isValidHostKey, which also accepts dotted host keys for the
// BYO-hostname flow; that flow has its own authorization (vanity gate + CF DV
// provisioning) which the settings path does not perform.
const SUBDOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Box-name validation (M1): the box picks its own name, so clamp it to a
// sane length + charset before it pollutes the registry / squats a slot.
const MAX_BOX_NAME = 64;
const BOX_NAME_RE = /^[A-Za-z0-9 ._\-]+$/;

/** Validate + normalize an agent-supplied box name. Returns the trimmed
 *  name, or null if it's empty, too long, or carries disallowed characters. */
function cleanBoxName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > MAX_BOX_NAME) return null;
  if (!BOX_NAME_RE.test(name)) return null;
  return name;
}

function isValidServiceId(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.length <= MAX_SERVICE_ID &&
    SERVICE_ID_RE.test(raw)
  );
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

/** UNIFIED liveness for a box: online iff it holds a live relay socket AND
 *  has been approved (state !== "pending"). The two former read paths
 *  (getState's isOnline(state) and pickHealthyBox's connected||online)
 *  now share this one rule, so the dashboard and the LB picker can't disagree
 *  about which boxes are reachable. */
function boxOnline(m: { connected?: boolean; state: ServiceState }): boolean {
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
  // In-memory rolling latency samples per "service:box", used to recompute
  // p50/p95/err on recordCall. Lost on eviction — that only blurs the rolling
  // window briefly, the durable counters (calls, recentCalls) survive.
  private samples = new Map<string, { ms: number; ok: boolean }[]>();
  // Whether this instance has run purgeLegacyTenancy (the result is persisted,
  // so this only saves the storage read on later requests).
  private purgeChecked = false;

  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return bad(405, "POST only");
    if (!this.purgeChecked) {
      await this.purgeLegacyTenancy();
      await this.handOffRoutes();
      this.purgeChecked = true;
    }
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
        case "memberContext":
          return this.opResponse(await this.memberContext(a.clerkUserId, a.email));
        case "gateOauth":
          return ok(await this.gateOauth(a.clerkUserId, a.service));
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
        case "decline":
          return ok(await this.decline(a.id));
        case "setTags":
          return ok(await this.setTags(a.id, a.tags));
        case "setAuth":
          return ok(await this.setAuth(a.service ?? a.id, a.mode));
        case "mintKey": {
          const r = await this.mintKey(a.label, a.scope);
          if ("error" in r) return bad(400, r.error);
          return ok(r);
        }
        case "revokeBoxKey":
          return ok(
            await this.revokeBoxKey(a.service, a.box, a.key),
          );
        case "updateSetting":
          return ok(await this.updateSetting(a.key, a.val));
        case "registerBox": {
          const r = await this.registerBox(
            a.service,
            a.box,
            a.os,
            a.version,
          );
          if (r.error) return bad(409, r.error);
          return ok(r);
        }
        case "markBox":
          return ok(
            await this.markBox(a.service, a.box, a.connected),
          );
        case "claimTicket":
          return ok(await this.claimTicket(a.jti, a.exp));
        case "boxExists":
          return ok(await this.boxExists(a.service, a.box));
        case "boxVersion":
          return ok(await this.boxVersion(a.service, a.box, a.version));
        case "recordCall":
          return ok(
            await this.recordCall(
              a.service,
              a.box,
              a.status,
              a.ms,
              a.caller,
              a.route,
            ),
          );
        case "checkKey":
          return ok(await this.checkKey(a.hash, a.service));
        default:
          return bad(400, `unknown op: ${op}`);
      }
    } catch (e) {
      return bad(500, `op ${op} failed: ${e}`);
    }
  }

  // ---- stored-state lifecycle --------------------------------------------

  private async load(): Promise<StoredState> {
    const stored = await this.ctx.storage.get<any>("state");
    const base = this.fresh();
    if (!stored || typeof stored !== "object") return base;
    const s: StoredState = {
      ...base,
      ...stored,
      // normalize legacy state names ("chirping"/"resting") stored before the
      // online/offline rename — one-way, idempotent.
      services: (Array.isArray(stored.services) ? stored.services : []).map(
        (sv: any) => ({
          ...sv,
          state: normalizeState(sv.state),
          boxes: Array.isArray(sv.boxes)
            ? sv.boxes.map((b: any) => ({ ...b, state: normalizeState(b.state) }))
            : [],
        }),
      ),
      keys: Array.isArray(stored.keys) ? stored.keys : [],
      logs: Array.isArray(stored.logs) ? stored.logs : [],
      settings:
        stored.settings && typeof stored.settings === "object"
          ? { ...base.settings, ...stored.settings }
          : base.settings,
      usedTickets:
        stored.usedTickets && typeof stored.usedTickets === "object"
          ? stored.usedTickets
          : {},
      cliTokenEpoch:
        typeof stored.cliTokenEpoch === "number" ? stored.cliTokenEpoch : 0,
      // Explicit, so fresh()'s current version never leaks into stored state
      // the purge has not processed.
      singleUserPurge:
        typeof stored.singleUserPurge === "number" ? stored.singleUserPurge : 0,
      members: Array.isArray(stored.members) ? stored.members : [],
      tenantMeta: stored.tenantMeta && typeof stored.tenantMeta === "object" ? stored.tenantMeta : undefined,
    };
    return s;
  }

  /** A brand-new tenant: empty roost, default settings, no mock seed data. */
  private fresh(): StoredState {
    const id = this.ctx.id.name ?? "";
    return {
      host: "", // set on first enroll/getState if we learn the subdomain
      services: [],
      keys: [],
      logs: [],
      usedTickets: {},
      cliTokenEpoch: 0,
      singleUserPurge: SINGLE_USER_PURGE_VERSION, // nothing legacy to purge
      members: [],
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

  private opResponse(r: any): Response { return r?.error ? bad(r.status ?? 400, r.error) : ok(r); }

  private async save(s: StoredState): Promise<void> {
    await this.ctx.storage.put("state", s);
  }

  /** Append an audit row. `svc` is REQUIRED (see StoredLogEvent in types.ts):
   *  every call site states which service the entry is about ("" for a
   *  tenant-wide row), so the log stays filterable by service. */
  private log(
    s: StoredState,
    ev: Omit<StoredLogEvent, "ago" | "ts" | "svc"> & { svc: string },
  ): void {
    const ts = Date.now();
    // `ago` is derived from `ts` on read (getState); store an empty placeholder
    // so a stale literal is never persisted.
    s.logs.unshift({ ...ev, ts, ago: "" });
    if (s.logs.length > MAX_LOGS) s.logs.length = MAX_LOGS;
  }

  // ---- derivation (read-side) --------------------------------------------

  /** Build the public TenantState: flatten boxes, derive service.state
   *  from boxes, recompute `outdated`, compute the overview, strip key
   *  hashes. Never persisted — always recomputed from the stored record. */
  private async getState(): Promise<TenantState> {
    const s = await this.load();
    // First dashboard load for a fresh tenant: hand out a default hub domain
    // so people start with a working <slug>.finchmcp.com instead of a claim
    // flow. Persist only when something was actually claimed — getState stays
    // a pure read otherwise.
    if (await this.ensureDefaultSlug(s)) {
      this.log(s, {
        cat: "admin",
        actor: "you",
        action: "claimed default hub domain",
        target: s.settings.subdomain,
        ip: "",
        svc: "",
      });
      await this.save(s);
    }
    const now = Date.now();

    const services: Service[] = s.services.map((a) => {
      const boxes = (a.boxes ?? []).map((m) => ({
        ...m,
        service: a.id,
        serviceLabel: a.label,
        outdated: m.version !== LATEST_AGENT,
        // The unified liveness rule, stated here so readers (the web's /fleet
        // page) never re-derive it from connected + state.
        online: boxOnline(m),
        // Derive the relative-time display strings on read from stored epoch-ms.
        lastSeen: timeAgo(m.lastSeenAt, now),
        handshake: timeAgo(m.handshakeAt, now),
      }));
      // service.state derives from its boxes: online if any box is
      // online. Liveness is UNIFIED across read paths: a box is online iff
      // it holds a live relay socket AND has been approved (state !== pending) —
      // the same rule pickHealthyBox uses. With no boxes we keep the
      // service's own lifecycle state (invited/pending/offline) untouched.
      let state: ServiceState = a.state;
      if (boxes.length) {
        const anyOnline = boxes.some((m) => boxOnline(m));
        const anyPending = boxes.some((m) => m.state === "pending");
        state = anyOnline ? "online" : anyPending ? "pending" : "offline";
      }
      const version = boxes.length ? boxes[0].version : a.version;
      const outdated =
        state !== "invited" &&
        (boxes.length
          ? boxes.some((m) => m.outdated)
          : version !== LATEST_AGENT);
      // Roll the 24h buckets to a trailing window with index 23 = current hour.
      const traffic24h = rollBuckets(a.traffic24h, a.lastBucketHour, now);
      const latency24h = rollBuckets(a.lat24h, a.lastBucketHour, now);
      return {
        ...a,
        auth: a.auth ?? "key", // legacy services predate this field → key-gated
        state,
        boxes,
        boxCount: boxes.length,
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

    // Flattened boxes lens, annotated with the service's group/tags/owner
    // (the dashboard's Boxes view consumes this exact shape).
    const boxes: Box[] = [];
    for (const a of services) {
      for (const m of a.boxes) {
        boxes.push({
          ...m,
          group: a.group,
          tags: a.tags,
          owner: a.owner,
        } as Box & { group: string; tags: string[]; owner: string });
      }
    }

    const publicKeys: PublicKey[] = s.keys.map(({ hash, ...rest }) => rest);

    // `svc` (the row's service subject) is storage metadata; strip it so the
    // wire shape of `logs` stays exactly LogEvent.
    const logs: LogEvent[] = (s.logs ?? []).map(({ svc: _svc, ...ev }) => ({
      ...ev,
      ago: timeAgo(ev.ts, now),
    }));

    return {
      host: s.host,
      tenant: s.tenantMeta,
      members: s.members,
      services,
      boxes,
      keys: publicKeys,
      logs,
      settings: s.settings,
      overview: this.overview(
        services,
        s.keys,
        now,
        !!s.settings.enforceExpiry,
      ),
      latestAgent: LATEST_AGENT,
    };
  }

  private overview(
    services: Service[],
    keys: Key[],
    now: number,
    enforceExpiry: boolean,
  ): Overview {
    // The fleet's 24h HISTORY is built over ALL services (the buckets here are
    // already rolled to a trailing window, index 23 = now). Building it only over
    // currently-online services made an offline box's stored history vanish the
    // moment it idled — the chart must still show the traffic it served.
    const traffic24h = Array.from({ length: 24 }, (_, h) =>
      services.reduce((sum, a) => sum + (a.traffic24h[h] || 0), 0),
    );
    const latency24h = Array.from({ length: 24 }, (_, h) => {
      const vals = services
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
    const on = services.filter((a) => isOnline(a.state));

    // Active keys = not-yet-expired keys (expiry only enforced if the tenant
    // turned it on; here we just don't count an over-expiry key as active).
    const keysActive = enforceExpiry
      ? keys.filter((k) => !(k.expiresAt && now > k.expiresAt)).length
      : keys.length;

    return {
      callsToday,
      callsDelta: 0,
      activeNow: on.length,
      total: services.length,
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

  private findService(
    s: StoredState,
    id: string,
  ): StoredService | undefined {
    return s.services.find((a) => a.id === id);
  }

  /** Lowercase a string into a host-safe slug; `fallback` if it reduces empty.
   *  Used for both service ids (from name) and the default subdomain (from id). */
  private slugify(raw: string, fallback: string): string {
    const slug = (
      raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || fallback
    );
    return slug.slice(0, MAX_SERVICE_ID).replace(/-+$/g, "") || fallback;
  }

  /** Every tenant gets a hub domain BY DEFAULT — no claim step. Called from
   *  getState (first dashboard load) and enroll (first box join), whichever
   *  comes first. Tries friendly pet-name slugs (adjective-bird-NN, mirroring
   *  the web picker's suggestions), then falls back to a tenant-id-derived
   *  slug so even a pathological collision run leaves the tenant with a
   *  working public host. Mutates `s` but does NOT save — callers save.
   *  Returns whether a slug was newly claimed. */
  private slugClaimAttempted = false;
  private async ensureDefaultSlug(s: StoredState): Promise<boolean> {
    if (s.settings.subdomain) return false;
    // Once per DO instance: if the router is down we must NOT re-run this
    // retry loop on every dashboard poll — the next instance retries.
    if (this.slugClaimAttempted) return false;
    this.slugClaimAttempted = true;

    const tenant = this.tenantId();
    if (!tenant) return false;
    const ADJ = ["sunny", "amber", "dusk", "quiet", "brave", "lucky", "misty", "cozy", "swift", "fern", "maple", "ember", "cedar", "pebble", "noble", "tidal"];
    const BIRD = ["finch", "wren", "robin", "sparrow", "lark", "swift", "martin", "thrush", "siskin", "tanager", "plover", "kestrel"];
    const candidates: string[] = [];
    for (let n = 0; n < 8; n++) {
      candidates.push(
        `${ADJ[Math.floor(Math.random() * ADJ.length)]}-` +
          `${BIRD[Math.floor(Math.random() * BIRD.length)]}-` +
          `${Math.floor(Math.random() * 90) + 10}`,
      );
    }
    const base = this.slugify(tenant, "tenant");
    for (let n = 0; n < 20; n++) {
      candidates.push(n === 0 ? base : `${base}-${n + 1}`);
    }
    for (const slug of candidates) {
      let res: { ok: boolean; reason?: string };
      try {
        res = await routerRegister(this.env, slug, tenant);
      } catch {
        return false; // router unavailable — don't hammer it 28×
      }
      if (res.ok) {
        s.settings.subdomain = slug;
        s.host = `${slug}.finchmcp.com`;
        return true;
      }
      if (res.reason !== "collision") return false; // only collisions are retryable
    }
    return false;
  }

  /** This DO is keyed by the REAL tenant id: its owner's Clerk user id. */
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
      handshake: "never", // display-only; box.handshake is timestamp-derived
      protocol: "offline",
    };
  }

  /** A skeleton service — no boxes yet (invited, ticket just minted). */
  private newService(
    id: string,
    label: string,
    group: string,
  ): StoredService {
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
      boxes: [],
      boxCount: 0,
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

  /** One-time, idempotent purge of everything the retired team, sharing and
   *  Aviary features left in this tenant's stored state. It runs on the first
   *  request an instance serves and is recorded by a versioned flag
   *  (`singleUserPurge`), so a later access is a single flag read. A tenant
   *  with no stored state is skipped without writing; one created after the
   *  purge shipped is born flagged.
   *
   *  The owner is the member row whose clerkUserId is this tenant's id — the
   *  Clerk user whose tenant this is. A team workspace or a Clerk-org tenant
   *  (kind "team", or an `org_` id) is nobody's tenant any more, so it has no
   *  owner.
   *
   *  The tenant was EXPOSED if anyone besides the owner could have signed in
   *  to it: it is a team/org tenant, or another member row is not a
   *  never-accepted invitation (state "invited" with no Clerk binding). A
   *  removed member who had signed in was kept as a "disabled" row, so the
   *  rows are a complete record of who could have. Nothing records who minted
   *  a key or enrolled a box — a key's `owner` is who it was labelled for
   *  (the Keys view defaulted it to the tenant owner, and a CLI mint always
   *  used the owner's email), and a box records no enroller — so in an exposed
   *  tenant every key and every box is treated as possibly someone else's.
   *
   *  The purge:
   *    - deletes every other member row (co-owners, admins, members,
   *      invitations) and normalizes the owner's row to an active owner. With
   *      no owner row it also deletes `tenantMeta`, so the tenant's own user
   *      bootstraps it afresh on their next sign-in;
   *    - deletes groups, ACL rules, access requests, the login wall's
   *      session epoch, and the earlier CLI-cut flag;
   *    - deletes the Aviary manifest, route and credential-epoch fields from
   *      services and boxes (a formerly Aviary-managed service's route list is
   *      cleared with them);
   *    - deletes the audit rows of the retired sharing features (category
   *      "access"), and every other row that names a non-owner member;
   *    - exposed: revokes every finch_ key, removes every box (so /refresh
   *      refuses its long-lived credential and the relay stops routing to it;
   *      the owner re-adds their own with `finch add`, which reuses the
   *      now-empty service), and bumps cliTokenEpoch once, since a CLI token
   *      names a tenant, not a person. An ownerless tenant's services are also
   *      set back to key-gated, so nothing on it answers without a key, and
   *      if exactly one active owner row existed its hosts are handed to that
   *      user (routeHeir, see handOffRoutes);
   *    - otherwise: revokes only keys labelled for someone other than the
   *      owner (an email other than theirs); the owner's keys, boxes and CLI
   *      logins are untouched. */
  private async purgeLegacyTenancy(): Promise<void> {
    const raw = await this.ctx.storage.get<any>("state");
    if (!raw || typeof raw !== "object") return;
    if (typeof raw.singleUserPurge === "number" && raw.singleUserPurge >= SINGLE_USER_PURGE_VERSION) {
      return;
    }
    const tenant = this.tenantId();
    const members: any[] = Array.isArray(raw.members)
      ? raw.members.filter((m: unknown) => !!m && typeof m === "object")
      : [];
    const shared = tenant.startsWith("org_") || raw.tenantMeta?.kind === "team";
    const owner = shared ? undefined : members.find((m) => m.clerkUserId === tenant);
    const others = members.filter((m) => m !== owner);
    const couldHaveSignedIn = (m: any): boolean =>
      m.state !== "invited" ||
      (typeof m.clerkUserId === "string" && m.clerkUserId !== "") ||
      typeof m.boundAt === "number";
    const exposed = shared || others.some(couldHaveSignedIn);
    // An ownerless tenant's hosts go to its one former owner, if it had
    // exactly one active owner who had signed in; otherwise they stay with the
    // (now inert) tenant — slugs are never recycled to whoever asks first.
    const formerOwners = shared
      ? members.filter(
          (m) =>
            m.role === "owner" &&
            m.state === "active" &&
            typeof m.clerkUserId === "string" &&
            m.clerkUserId !== "" &&
            m.clerkUserId !== tenant,
        )
      : [];
    const heir: string | undefined = formerOwners.length === 1 ? formerOwners[0].clerkUserId : undefined;
    const now = Date.now();

    // Members: the owner alone, as an active owner.
    if (owner) {
      const restored = owner.role !== "owner" || owner.state !== "active";
      raw.members = [
        {
          id: typeof owner.id === "string" && owner.id ? owner.id : "m_" + crypto.randomUUID().slice(0, 8),
          tenantId: tenant,
          clerkUserId: tenant,
          email: normalizeEmail(String(owner.email ?? "")),
          role: "owner",
          state: "active",
          createdAt: typeof owner.createdAt === "number" ? owner.createdAt : now,
          updatedAt: !restored && typeof owner.updatedAt === "number" ? owner.updatedAt : now,
          ...(typeof owner.boundAt === "number" ? { boundAt: owner.boundAt } : {}),
        },
      ];
      if (raw.tenantMeta && typeof raw.tenantMeta === "object") {
        raw.tenantMeta = {
          id: tenant,
          kind: "personal",
          displayName: String(raw.tenantMeta.displayName ?? tenant),
          createdAt: typeof raw.tenantMeta.createdAt === "number" ? raw.tenantMeta.createdAt : now,
          bootstrappedFrom: raw.tenantMeta.bootstrappedFrom === "fresh" ? "fresh" : "legacy-personal",
          membershipVersion: 1,
        };
      }
    } else {
      raw.members = [];
      delete raw.tenantMeta;
    }

    // Keys: in an exposed tenant, all of them (no key records its minter).
    // Otherwise only the owner could have minted, so keep every key labelled
    // for the owner — their email, or the "you" placeholder a key got before
    // the tenant had an identity — and revoke the ones labelled for someone
    // else. Revoked ids are detached from services and boxes below.
    const keys: any[] = Array.isArray(raw.keys) ? raw.keys : [];
    const ownerEmail = owner ? normalizeEmail(String(owner.email ?? "")) : "";
    const keep = (k: any): boolean => {
      if (exposed) return false;
      const keyOwner = typeof k?.owner === "string" ? normalizeEmail(k.owner) : "";
      if (!keyOwner || keyOwner === "you") return true;
      return !!ownerEmail && keyOwner === ownerEmail;
    };
    raw.keys = keys.filter(keep);
    const revokedCount = keys.length - raw.keys.length;
    const keptIds = new Set<unknown>(raw.keys.map((k: any) => k?.id));
    const keepKeyIds = (ids: unknown) =>
      Array.isArray(ids) ? ids.filter((id: unknown) => keptIds.has(id)) : ids;

    // Services and boxes: drop the Aviary fields and the ids of keys that no
    // longer exist. In an exposed tenant, remove every box: none records who
    // enrolled it, and its /join refresh token carries no epoch, so removal is
    // the only thing that stops a box someone else runs from refreshing and
    // from receiving this tenant's traffic (a "pending" box would still be
    // reachable by a box-pinned path, and `finch approve` clears a whole
    // service at once).
    const services: any[] = Array.isArray(raw.services) ? raw.services : [];
    let removedBoxes = 0;
    const reenroll: string[] = [];
    for (const svc of services) {
      if (!svc || typeof svc !== "object") continue;
      if (svc.aviaryManaged) svc.routes = [];
      for (const f of LEGACY_SERVICE_FIELDS) delete svc[f];
      svc.keys = keepKeyIds(svc.keys);
      const boxes: any[] = Array.isArray(svc.boxes) ? svc.boxes : [];
      if (exposed) {
        removedBoxes += boxes.length;
        svc.boxes = [];
        svc.boxCount = 0;
        svc.box = "—";
        // Boxless, like a freshly enrolled service: the next box to join
        // promotes it (registerBox), and getState reports this state as is.
        svc.state = "invited";
        if (shared) svc.auth = "key";
        else if (typeof svc.id === "string") reenroll.push(svc.id);
        continue;
      }
      for (const box of boxes) {
        if (!box || typeof box !== "object") continue;
        for (const f of LEGACY_BOX_FIELDS) delete box[f];
        box.keys = keepKeyIds(box.keys);
      }
    }

    // Audit rows: drop the sharing features' own rows, and any row that names
    // someone other than the owner (by email, member id or Clerk user id) —
    // e.g. "minted key" rows whose actor was an admin.
    const otherNames = new Set<string>(); // matched anywhere in the text
    const otherMemberIds = new Set<string>(); // short ids: matched exactly
    for (const m of others) {
      for (const v of [m.email, m.clerkUserId]) {
        if (typeof v === "string" && v.trim()) otherNames.add(normalizeEmail(v));
      }
      if (typeof m.id === "string" && m.id) otherMemberIds.add(m.id);
    }
    const namesOther = (l: any): boolean =>
      [l?.actor, l?.target].some((v) => {
        if (typeof v !== "string") return false;
        if (otherMemberIds.has(v)) return true;
        const text = v.toLowerCase();
        for (const name of otherNames) if (text.includes(name)) return true;
        return false;
      });
    for (const f of LEGACY_STATE_FIELDS) delete raw[f];
    const logs: any[] = Array.isArray(raw.logs) ? raw.logs : [];
    raw.logs = logs.filter((l) => l?.cat !== "access" && !namesOther(l));

    if (exposed) {
      raw.cliTokenEpoch = (typeof raw.cliTokenEpoch === "number" ? raw.cliTokenEpoch : 0) + 1;
    }
    if (heir) raw.routeHeir = heir;
    if (reenroll.length) raw.reenroll = reenroll;
    if (exposed || revokedCount > 0) {
      const ev: StoredLogEvent = {
        cat: "key",
        actor: "finch",
        action: exposed
          ? `single-user migration: others could sign in (${shared ? "shared tenant" : "other members"}), ` +
            `so no key or box has a known owner; revoked all ${revokedCount} key(s), ` +
            `removed ${removedBoxes} box(es) and revoked every CLI token`
          : `single-user migration: revoked ${revokedCount} key(s) labelled for someone other than the owner`,
        target: "legacy sharing data",
        ip: "",
        svc: "",
        ts: now,
        ago: "",
      };
      raw.logs.unshift(ev);
      if (raw.logs.length > MAX_LOGS) raw.logs.length = MAX_LOGS;
    }
    raw.singleUserPurge = SINGLE_USER_PURGE_VERSION;
    await this.ctx.storage.put("state", raw);
  }

  /** Hand an ownerless tenant's RouterDO hosts (its finchmcp.com slugs and
   *  custom hostnames) to its one former owner, recorded by the purge as
   *  `routeHeir`. Before single-user tenancy that user's commands resolved to
   *  this tenant; now they act on their own, so without this the hosts would
   *  stay registered to a tenant no one can manage and could never be
   *  re-pointed. Each host moves atomically (RouterDO.transfer), so it is
   *  never claimable in between, and a Cloudflare custom hostname needs no
   *  change (it is keyed by hostname, not tenant). The marker is deleted only
   *  once every host moved; any failure leaves it for the next instance. */
  private async handOffRoutes(): Promise<void> {
    const raw = await this.ctx.storage.get<any>("state");
    const heir = raw && typeof raw === "object" ? raw.routeHeir : undefined;
    if (typeof heir !== "string" || !heir) return;
    const tenant = this.tenantId();
    let hosts: string[];
    try {
      const res = await routerStub(this.env).fetch("https://router/op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "listForTenant", tenant }),
      });
      if (!res.ok) return;
      const out = (await res.json()) as { keys?: unknown };
      if (!Array.isArray(out.keys)) return;
      hosts = out.keys.filter((k): k is string => typeof k === "string");
      for (const host of hosts) {
        const moved = await routerTransfer(this.env, host, tenant, heir);
        // "not-owner": someone else holds it now, so it is not ours to move.
        if (!moved.ok && moved.reason !== "not-owner") return;
      }
    } catch {
      return; // router unavailable: retry on the next instance
    }
    delete raw.routeHeir;
    const ev: StoredLogEvent = {
      cat: "admin",
      actor: "finch",
      action: `single-user migration: moved ${hosts.length} host(s) to the tenant's former owner`,
      target: hosts.join(", ").slice(0, 200) || "none",
      ip: "",
      svc: "",
      ts: Date.now(),
      ago: "",
    };
    raw.logs = Array.isArray(raw.logs) ? raw.logs : [];
    raw.logs.unshift(ev);
    if (raw.logs.length > MAX_LOGS) raw.logs.length = MAX_LOGS;
    await this.ctx.storage.put("state", raw);
  }

  private async revokeCliTokens(): Promise<{ ok: boolean; epoch: number }> {
    const s = await this.load();
    s.cliTokenEpoch = (s.cliTokenEpoch ?? 0) + 1;
    this.log(s, { cat: "key", actor: "you", action: "revoked all CLI tokens", target: "cli access", ip: "", svc: "" });
    await this.save(s);
    return { ok: true, epoch: s.cliTokenEpoch };
  }

  // ---- mutations: services ---------------------------------------------

  private async enroll(
    name: string,
    group?: string,
  ): Promise<{ id: string }> {
    const s = await this.load();
    let id = this.slugify(name, "service");
    const existing = this.findService(s, id);
    const reenroll = Array.isArray(s.reenroll) ? s.reenroll : [];
    if (existing && existing.boxes.length === 0 && reenroll.includes(id)) {
      // A service whose boxes the single-user purge removed is re-enrolled in
      // place, once: the new ticket joins THIS service, so `finch add <name>`
      // (the command a revoked box's agent prints) restores it at the same URL
      // with its auth mode, instead of minting "<name>-2" beside a dead one.
      s.reenroll = reenroll.filter((x) => x !== id);
      if (!s.reenroll.length) delete s.reenroll;
      await this.ensureDefaultSlug(s);
      this.log(s, { cat: "device", actor: "you", action: "re-enrolled", target: id, ip: "", svc: id });
      await this.save(s);
      return { id };
    }
    // de-dupe id within the tenant
    if (existing) {
      let n = 2;
      let candidate = id;
      do {
        const suffix = `-${n++}`;
        const base = id
          .slice(0, MAX_SERVICE_ID - suffix.length)
          .replace(/-+$/g, "") || "service";
        candidate = `${base}${suffix}`;
      } while (this.findService(s, candidate));
      id = candidate;
    }
    s.services.push(this.newService(id, name, group || s.settings.defaultGroup));
    // First enroll for a tenant whose dashboard never loaded (getState also
    // does this): make sure a default hub domain exists so the public relay
    // URL resolves.
    await this.ensureDefaultSlug(s);
    this.log(s, {
      cat: "device",
      actor: "you",
      action: "enrolled",
      target: id,
      ip: "",
      svc: id,
    });
    await this.save(s);
    return { id };
  }

  private async release(id: string): Promise<{ ok: boolean }> {
    const s = await this.load();
    const before = s.services.length;
    s.services = s.services.filter((a) => a.id !== id);
    if (s.services.length === before) return { ok: false };
    this.log(s, {
      cat: "device",
      actor: "you",
      action: "released",
      target: id,
      ip: "",
      svc: id,
    });
    await this.save(s);
    return { ok: true };
  }

  private async approve(id: string): Promise<{ ok: boolean }> {
    const s = await this.load();
    const ap = this.findService(s, id);
    if (!ap) return { ok: false };
    // Approve = clear the pending gate. Liveness is then owned by markBox: an
    // approved-but-disconnected box must read "offline", not "online". So
    // derive from m.connected rather than flipping straight to online.
    for (const m of ap.boxes) {
      if (m.state === "pending") m.state = m.connected ? "online" : "offline";
    }
    if (ap.state === "pending") {
      const anyConnected = ap.boxes.some((mm) => mm.connected);
      ap.state = anyConnected ? "online" : "offline";
    }
    this.log(s, {
      cat: "device",
      actor: "you",
      action: "approved",
      target: id,
      ip: "",
      svc: id,
    });
    await this.save(s);
    return { ok: true };
  }

  private async decline(id: string): Promise<{ ok: boolean }> {
    const s = await this.load();
    const ap = this.findService(s, id);
    if (!ap) return { ok: false };
    // Declining a pending service removes it (it never became real).
    s.services = s.services.filter((a) => a.id !== id);
    this.log(s, {
      cat: "device",
      actor: "you",
      action: "declined",
      target: id,
      ip: "",
      svc: id,
    });
    await this.save(s);
    return { ok: true };
  }

  /** Flip a service's public-relay access mode between "key" (require a
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
    const ap = this.findService(s, id);
    if (!ap) return { ok: false, error: "unknown service" };
    ap.auth = mode;
    this.log(s, {
      cat: "device",
      actor: "you",
      action: "set-auth",
      target: `${id} → ${mode}`,
      ip: "",
      svc: id,
    });
    await this.save(s);
    return { ok: true };
  }

  private async setTags(
    id: string,
    tags: string[],
  ): Promise<{ ok: boolean }> {
    const s = await this.load();
    const ap = this.findService(s, id);
    if (!ap) return { ok: false };
    ap.tags = Array.isArray(tags) ? tags.map(String) : [];
    this.log(s, {
      cat: "admin",
      actor: "you",
      action: "set tags",
      target: `${id} → ${ap.tags.join(", ") || "(none)"}`,
      ip: "",
      svc: id,
    });
    await this.save(s);
    return { ok: true };
  }

  // ---- mutations: keys ----------------------------------------------------

  private async mintKey(
    label: string,
    scope?: KeyScope,
  ): Promise<
    { plaintext: string; key: PublicKey } | { error: string }
  > {
    const s = await this.load();

    // Validate + normalize the structured scope. Default is LEAST-PRIVILEGE:
    // no scope (or an empty service list) mints a key that reaches nothing
    // until the operator scopes it — never a fleet-wide key by accident. Every
    // listed service id MUST exist (400 on an unknown id) so a key can't carry
    // dangling free-text that silently grants or denies.
    const normScope = this.normalizeScope(s, scope);
    if ("error" in normScope) return { error: normScope.error };

    // Every key is the owner's: labelled with their email once the tenant has
    // an identity, else with the "you" placeholder (rewritten on bootstrap).
    const owner = this.owner(s)?.email || "you";
    const plaintext = genFinchKey();
    const hash = await hashKey(plaintext);
    const now = Date.now();
    const key: Key = {
      id: "k_" + crypto.randomUUID().slice(0, 8),
      label,
      owner,
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

    // Populate the display lists (#10): attach the key's ID to every service
    // it can reach (and that service's boxes), so the per-box /
    // per-service key chips actually render — and revokeBoxKey (which now
    // works by id) has lists to prune. {all:true} reaches every service.
    const reach: StoredService[] =
      "all" in normScope.scope && normScope.scope.all === true
        ? s.services
        : s.services.filter((a) =>
            (normScope.scope as { services: string[] }).services.includes(
              a.id,
            ),
          );
    for (const a of reach) {
      if (!a.keys.includes(key.id)) a.keys.push(key.id);
      for (const m of a.boxes) {
        if (!m.keys.includes(key.id)) m.keys.push(key.id);
      }
    }

    this.log(s, {
      cat: "key",
      actor: key.owner,
      action: "minted key",
      target: label,
      ip: "",
      // A key is a tenant credential; `scope` may list services, so no
      // single subject.
      svc: "",
    });
    await this.save(s);
    const { hash: _h, ...pub } = key;
    return { plaintext, key: pub };
  }

  /** Validate + normalize an incoming KeyScope. {all:true} passes through; an
   *  service list is filtered to existing ids (unknown id → 400). A missing or
   *  empty scope defaults to an explicit empty allow-list (least privilege). */
  private normalizeScope(
    s: StoredState,
    scope?: KeyScope,
  ): { scope: KeyScope } | { error: string } {
    if (scope && "all" in scope && scope.all === true) {
      return { scope: { all: true } };
    }
    const ids = Array.isArray((scope as any)?.services)
      ? ((scope as any).services as unknown[]).map(String)
      : [];
    const unknown = ids.filter((id) => !this.findService(s, id));
    if (unknown.length) {
      return { error: `unknown service id(s): ${unknown.join(", ")}` };
    }
    // De-dupe; least-privilege default is the explicit empty list.
    return { scope: { services: Array.from(new Set(ids)) } };
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

  private async revokeBoxKey(
    service: string,
    box: string,
    key: string,
  ): Promise<{ ok: boolean }> {
    const s = await this.load();
    const target = s.keys.find((k) => k.id === key);
    if (!target) return { ok: false };
    let touched = false;
    const scopeAbsent =
      (service === undefined || service === "") &&
      (box === undefined || box === "");

    if (typeof service === "string" && service && typeof box === "string" && box) {
      // A box row is only a presentation/assignment edge. Removing it must not
      // destroy the tenant key or revoke the same credential from sibling boxes.
      const stored = this.findService(s, service)?.boxes.find((m) => m.name === box);
      if (stored?.keys.includes(key)) {
        stored.keys = stored.keys.filter((id) => id !== key);
        touched = true;
      }
    } else if (scopeAbsent) {
      // Only a wholly absent scope is an explicit tenant-global revoke. A
      // partially specified scope must never broaden into global deletion.
      s.keys = s.keys.filter((k) => k.id !== key);
      touched = true;
      for (const a of s.services) {
        if (a.keys.includes(key)) a.keys = a.keys.filter((id) => id !== key);
        for (const m of a.boxes) {
          if (m.keys.includes(key)) m.keys = m.keys.filter((id) => id !== key);
        }
      }
    }

    if (touched) {
      this.log(s, {
        cat: "key",
        actor: "you",
        action: service && box ? "detached key" : "revoked key",
        target: `${target.label} @ ${service}/${box}`,
        ip: "",
        // A detach names one service; a tenant-global revoke names none (and
        // touches every service, so it has no single subject).
        svc: service && box ? service : "",
      });
      await this.save(s);
    }
    return { ok: touched };
  }

  // ---- tenant owner ---------------------------------------------------------

  /** The tenant's owner: the active owner row of the Clerk user whose tenant
   *  this is. After the single-user purge it is the only member row. */
  private owner(s: StoredState): TenantMember | undefined {
    const tenant = this.tenantId();
    return s.members.find(
      (m) => m.clerkUserId === tenant && m.role === "owner" && m.state === "active",
    );
  }

  /** Replace the pre-identity placeholder key owner ("you") with the real
   *  owner's email, once the tenant gains its identity. */
  private rewriteYou(s: StoredState, email: string): void {
    for (const k of s.keys) {
      if (!k.owner || k.owner === "you") k.owner = email;
    }
  }

  /** First sign-in to a tenant (id === the caller's Clerk user id): record
   *  them as its owner. Idempotent once bootstrapped. */
  private async ensureOwner(clerkUserId: string, email: unknown): Promise<any> {
    const em = typeof email === "string" ? normalizeEmail(email) : "";
    const s = await this.load();
    if (this.owner(s)) return this.memberContext(clerkUserId);
    if (!clerkUserId || !em || clerkUserId !== this.tenantId()) {
      return { error: "tenant owner mismatch", status: 403 };
    }
    const now = Date.now();
    const member: TenantMember = {
      id: "m_" + crypto.randomUUID().slice(0, 8),
      tenantId: this.tenantId(),
      clerkUserId,
      email: em,
      role: "owner",
      state: "active",
      createdAt: now,
      updatedAt: now,
      boundAt: now,
    };
    s.tenantMeta = {
      id: this.tenantId(),
      kind: "personal",
      displayName: this.tenantId(),
      createdAt: now,
      bootstrappedFrom: "legacy-personal",
      membershipVersion: 1,
    };
    s.members = [member];
    this.rewriteYou(s, em);
    this.log(s, { cat: "admin", actor: member.id, action: "bootstrapped account", target: em, ip: "", svc: "" });
    await this.save(s);
    return this.memberContext(clerkUserId);
  }

  /** Resolve a Clerk user against this tenant. Only the Clerk user whose
   *  tenant this is (its id is their user id) is a member, as its owner;
   *  anyone else gets `member: null`. Until an email arrives to bootstrap the
   *  owner row, the owner gets `needsBootstrap`. */
  private async memberContext(clerkUserId: unknown, email?: unknown): Promise<any> {
    const uid = typeof clerkUserId === "string" ? clerkUserId : "";
    if (!uid || uid !== this.tenantId()) return { member: null, tenantMeta: null };
    const s = await this.load();
    const m = this.owner(s);
    if (!m) {
      if (typeof email === "string" && email) return this.ensureOwner(uid, email);
      return { member: null, tenantMeta: null, needsBootstrap: true };
    }
    return {
      member: { id: m.id, role: m.role, state: m.state, email: m.email },
      tenantMeta: s.tenantMeta ?? null,
    };
  }

  /** The OAuth door: a Clerk-verified caller may reach a key-gated service
   *  only if this is their own tenant (its id is their Clerk user id). A
   *  public service needs no identity. */
  private async gateOauth(
    clerkUserId: unknown,
    service: unknown,
  ): Promise<{ allowed: boolean; public?: boolean }> {
    const uid = typeof clerkUserId === "string" ? clerkUserId : "";
    const s = await this.load();
    if (this.findService(s, String(service || ""))?.auth === "public") {
      return { allowed: true, public: true };
    }
    return { allowed: !!uid && uid === this.tenantId() };
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
      // A subdomain is a BARE DNS LABEL — `${slug}.finchmcp.com` below only
      // makes sense for one. isValidHostKey (router-do) accepts any dotted name
      // outside the finchmcp.com/workers.dev families, so without this check a
      // dotted value registered an arbitrary HOST KEY in the shared RouterDO,
      // routing around everything /api/hostnames enforces: the vanity-tier gate
      // (VANITY_TENANT), the Cloudflare-for-SaaS provisioning that ties a BYO
      // name to a validated owner, and the JOIN_LIMIT throttle. Registrations
      // are first-come and non-owners cannot unregister, so a squat was durable.
      // Mirrors SLUG_RE in web/app/api/finch/slug-check.
      if (slug && !SUBDOMAIN_LABEL_RE.test(slug)) {
        return { ok: false, error: "invalid subdomain" };
      }
      if (slug) {
        let res: { ok: boolean; reason?: string; owner?: string };
        try {
          // Waking the holder lets a user reclaim a slug their former team
          // tenant held before its purge has run (routerRegisterWakingHolder).
          res = await routerRegisterWakingHolder(this.env, slug, this.tenantId());
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
      svc: "",
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

  /** True iff `box` is currently registered under `service`. Used by the
   *  /refresh endpoint so a box removed from the dashboard can no longer mint
   *  fresh connect-tokens — revocation takes effect within one connect-token TTL. */
  private async boxExists(
    service: unknown,
    box: unknown,
  ): Promise<{ exists: boolean }> {
    if (typeof service !== "string" || typeof box !== "string") {
      return { exists: false };
    }
    const s = await this.load();
    const ap = this.findService(s, service);
    if (!ap) return { exists: false };
    return { exists: ap.boxes.some((m) => m.name === box) };
  }

  /** Re-stamp a box's agent version from /refresh. After a hub-pushed update
   *  the agent re-execs and resumes via /refresh (never /join), so this is the
   *  only channel the NEW version reaches the registry — without it the
   *  dashboard shows the pre-update version (and its ⬆ badge) forever.
   *  `outdated` needs no write: getState recomputes it from version on read. */
  private async boxVersion(
    service: unknown,
    box: unknown,
    version: unknown,
  ): Promise<{ ok: boolean }> {
    if (
      typeof service !== "string" ||
      typeof box !== "string" ||
      typeof version !== "string" ||
      !version
    ) {
      return { ok: false };
    }
    const s = await this.load();
    const m = this.findService(s, service)?.boxes.find((x) => x.name === box);
    if (!m) return { ok: false };
    if (m.version !== version) {
      m.version = version.slice(0, 32);
      m.outdated = m.version !== LATEST_AGENT;
      await this.save(s);
    }
    return { ok: true };
  }

  /** Agent join: register (or refresh) a box under a service. Sets the
   *  service pending|online per settings.requireApproval. */
  private async registerBox(
    service: string,
    box: string,
    os: string,
    version: string,
  ): Promise<{ ok: boolean; state?: ServiceState; error?: string }> {
    if (!isValidServiceId(service)) {
      return { ok: false, error: "invalid service id" };
    }
    // Validate/clamp the box name at the DATA layer too (defense-in-depth;
    // api.ts also clamps at the /join door). (security M1)
    const cleaned = cleanBoxName(box);
    if (!cleaned) return { ok: false, error: "invalid box name" };
    box = cleaned;

    const s = await this.load();
    let ap = this.findService(s, service);
    if (!ap) {
      // Join for a service we don't know (e.g. enrolled then evicted) —
      // create it on the fly so the box has a home. Cap services-per-tenant
      // so a flood of joins to unknown ids can't grow the DO unbounded (M5).
      if (s.services.length >= MAX_SERVICES_PER_TENANT) {
        return { ok: false, error: "service limit reached for tenant" };
      }
      ap = this.newService(service, service, s.settings.defaultGroup);
      s.services.push(ap);
    }
    const requireApproval = s.settings.requireApproval;
    // The state a GENUINELY NEW box starts in.
    const newState: ServiceState = requireApproval ? "pending" : "online";
    const now = Date.now();

    let m = ap.boxes.find((mm) => mm.name === box);
    if (m) {
      // RE-JOIN of a known box (agent restart): refresh os/version/lastSeen
      // but DO NOT clobber its lifecycle state. Re-stamping pending|online here
      // would demote an already-approved, live box back to pending on every agent
      // restart. The only legitimate demotion is leaving "invited"; markBox
      // owns connected↔online/offline transitions from here on. A still-pending
      // box stays pending (re-approval not retriggered).
      m.os = os;
      m.version = version;
      m.lastSeenAt = now;
      m.outdated = version !== LATEST_AGENT;
      if (m.state === "invited") m.state = newState;
    } else {
      // Genuinely new box. Cap boxes-per-service (M1/M5): bound name
      // squatting + unbounded DO creation behind a single ticket.
      if (ap.boxes.length >= MAX_BOXES_PER_SERVICE) {
        return { ok: false, error: "box limit reached for service" };
      }
      m = {
        name: box,
        os,
        version,
        state: newState,
        service: ap.id,
        serviceLabel: ap.label,
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
      ap.boxes.push(m);
    }
    ap.boxCount = ap.boxes.length;
    ap.box = ap.box === "—" ? box : ap.box;
    ap.lastSeenAt = now;
    // Promote the service out of "invited" on first real join; never demote an
    // approved service back to pending on a re-join.
    if (ap.state === "invited") ap.state = newState;

    this.log(s, {
      cat: "device",
      actor: service,
      action: requireApproval ? "requested approval" : "joined",
      target: box,
      ip: "",
      svc: service,
    });
    await this.save(s);
    return { ok: true, state: m.state };
  }

  /** Relay callback on WS open/close: mark a box connected/disconnected and
   *  recompute the service.state (online if any box is connected). */
  private async markBox(
    service: string,
    box: string,
    connected: boolean,
  ): Promise<{ ok: boolean }> {
    const s = await this.load();
    const ap = this.findService(s, service);
    if (!ap) return { ok: false };
    const m = ap.boxes.find((mm) => mm.name === box);
    if (!m) return { ok: false };
    const now = Date.now();
    m.connected = connected;
    // markBox is the SOLE authority for connected↔online/offline. Don't
    // override a pending (unapproved) box's lifecycle state.
    if (m.state !== "pending") {
      m.state = connected ? "online" : "offline";
    }
    if (connected) {
      m.lastSeenAt = now;
      m.handshakeAt = now;
    }

    const anyConnected = ap.boxes.some((mm) => mm.connected);
    if (ap.state !== "pending" && ap.state !== "invited") {
      ap.state = anyConnected ? "online" : "offline";
    }
    if (anyConnected) ap.lastSeenAt = now;

    this.log(s, {
      cat: "device",
      actor: service,
      action: connected ? "came online" : "went offline",
      target: box,
      ip: "",
      svc: service,
    });
    await this.save(s);
    return { ok: true };
  }

  /** Relay callback per proxied request: bump counters, roll p50/p95/err, push
   *  a capped recentCall, bump the current traffic24h bucket, append a log. */
  private async recordCall(
    service: string,
    box: string,
    status: number,
    ms: number,
    caller: string,
    route: string,
  ): Promise<{ ok: boolean }> {
    const s = await this.load();
    const ap = this.findService(s, service);
    if (!ap) return { ok: false };

    ap.calls += 1;

    // Rolling latency/error window (in-memory samples, durable counters).
    const skey = `${service}:${box}`;
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

    // Per-route metric also reflected on the box, if present.
    const m = ap.boxes.find((mm) => mm.name === box);
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
      target: `${service} ${route}`,
      ip: "",
      svc: service,
      result: status,
    });
    await this.save(s);
    return { ok: true };
  }

  // ---- key check (MCP router) --------------------------------------------

  /** Given the sha-256 hash of a presented finch_ key and the target service,
   *  decide if the call is allowed. A public service admits anyone. Otherwise
   *  a key is allowed iff it exists (revocation deletes it), has not expired
   *  (only when the tenant enforces expiry), the service exists, and the key's
   *  scope is {all:true} or lists the service. There are no ACL rules, groups
   *  or per-user grants any more.
   *
   *  Returns the key's label for logging / attribution and a `reason` for the
   *  denial (so the relay can return a precise 403). */
  private async checkKey(
    hash: string,
    service: string,
  ): Promise<{
    allowed: boolean;
    keyLabel: string;
    keyId?: string;
    keyOwner?: string;
    public?: boolean;
    reason?: "no-key" | "expired" | "no-service" | "scope";
  }> {
    const s = await this.load();

    // A PUBLIC service (an ngrok-style open webpage) needs no finch_ key —
    // allow regardless of what (if anything) was presented, BEFORE the key
    // lookup so a missing/empty hash still passes. `public:true` tells the
    // relay to label the caller "public" and skip the bearer 401. (auth
    // defaults to "key" when the field is absent → fail-closed.)
    const ap = this.findService(s, service);
    if (ap && ap.auth === "public") {
      return { allowed: true, keyLabel: "public", public: true };
    }

    const key = hash ? s.keys.find((k) => k.hash === hash) : undefined;
    if (!key) return { allowed: false, keyLabel: "", reason: "no-key" };

    // Expiry is only enforced when the tenant turns settings.enforceExpiry on.
    // A key with no stamped expiry never expires (keyExpiry="never").
    if (
      s.settings.enforceExpiry &&
      key.expiresAt &&
      Date.now() > key.expiresAt
    ) {
      return { allowed: false, keyLabel: key.label, reason: "expired" };
    }

    if (!ap) return { allowed: false, keyLabel: key.label, reason: "no-service" };

    // Scope (structured — {all:true} or an explicit service list).
    const scope = key.scope;
    const scopeOk =
      !!scope &&
      ("all" in scope && scope.all === true
        ? true
        : Array.isArray((scope as any).services) &&
          (scope as any).services.includes(service));
    if (!scopeOk) {
      return { allowed: false, keyLabel: key.label, reason: "scope" };
    }

    return {
      allowed: true,
      keyLabel: key.label,
      keyId: key.id,
      keyOwner: key.owner,
    };
  }
}
