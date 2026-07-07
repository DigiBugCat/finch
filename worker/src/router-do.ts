/// <reference types="@cloudflare/workers-types" />
//
// RouterDO — the single global slug→tenantId index for the relay plane.
//
// The control plane keys TenantDO/BoxDO by the REAL tenant id (a Clerk org
// id, or a user id). But the public relay URL is a vanity subdomain
// (<slug>.finchmcp.com) and the slug is NOT the tenant id. This DO is the one
// authoritative map from a request's host slug to the tenant id it belongs to.
//
// It is a SINGLETON: index.ts and TenantDO both reach the same instance via
// env.ROUTER.idFromName("global"). TenantDO registers a mapping when a tenant's
// subdomain is set (and the default subdomain at first enroll); the relay path in
// index.ts looks the slug up and FAILS CLOSED (404) on an unknown slug.
//
// Collisions are rejected: a slug already owned by a DIFFERENT tenant cannot be
// re-registered (returns { ok: false, reason: "collision" }). Re-registering the
// SAME (slug, tenant) pair is idempotent. A tenant may own multiple slugs; the
// map is slug→tenant (many slugs can point at one tenant, but a slug points at
// exactly one tenant).
//
// RPC shape: POST { op, ...args } to fetch(); returns JSON. SQLite-backed (the
// modern DO API) so the table survives eviction.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

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

/** Canonical name of the singleton instance. */
export const ROUTER_SINGLETON = "global";

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Validate a RouterDO key. Bare labels are legacy finchmcp slugs; dotted keys
 *  are custom hostnames. Reject alternate spellings for finchmcp.com hosts so
 *  `<slug>.finchmcp.com` always maps through the bare slug only. */
export function isValidHostKey(key: string): boolean {
  const s = key.trim().toLowerCase();
  if (!s) return false;
  if (!s.includes(".")) return DNS_LABEL_RE.test(s);
  if (s.length > 253) return false;
  if (
    s === "finchmcp.com" ||
    s.endsWith(".finchmcp.com") ||
    s === "workers.dev" ||
    s.endsWith(".workers.dev")
  ) {
    return false;
  }
  const labels = s.split(".");
  if (labels.length < 2 || labels.some((label) => !label)) return false;
  return labels.every((label) => DNS_LABEL_RE.test(label));
}

export class RouterDO extends DurableObject<Env> {
  /** Create the slug→tenant table if absent (idempotent; cheap no-op once it
   *  exists). Called at the top of fetch so the table is always present. */
  private init(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS slugs (
         slug   TEXT PRIMARY KEY,
         tenant TEXT NOT NULL
       )`,
    );
    // CLI device-authorization codes (the `finch login` flow). Short-lived: the
    // CLI starts one, the browser approves it (stamping tenant+token), the CLI
    // polls it once, then it's consumed. device_code is the CLI's secret; the
    // short user_code is what the human confirms in the browser.
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS device_codes (
         device_code TEXT PRIMARY KEY,
         user_code   TEXT NOT NULL,
         tenant      TEXT,
         token       TEXT,
         email       TEXT,
         created     INTEGER NOT NULL,
         approved    INTEGER NOT NULL DEFAULT 0,
         req_ip      TEXT,
         req_ua      TEXT
       )`,
    );
    // Add the email column to a table created before it existed (idempotent —
    // ALTER throws "duplicate column" once it's there, which we swallow).
    try {
      this.ctx.storage.sql.exec("ALTER TABLE device_codes ADD COLUMN email TEXT");
    } catch {
      /* column already present */
    }
  }

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

    this.init();
    const a = msg as any;
    try {
      switch (op) {
        case "register":
          return ok(this.register(a.slug, a.tenant));
        case "lookup":
          return ok({ tenant: this.lookup(a.slug) });
        case "unregister":
          return ok(this.unregister(a.slug, a.tenant));
        case "listForTenant":
          return ok({ keys: this.listForTenant(a.tenant) });
        case "deviceStart":
          return ok(this.deviceStart(a.deviceCode, a.userCode, a.now, a.reqIp, a.reqUa));
        case "deviceDescribe":
          return ok(this.deviceDescribe(a.userCode, a.now));
        case "deviceApprove":
          return ok(this.deviceApprove(a.userCode, a.tenant, a.token, a.email, a.now));
        case "devicePoll":
          return ok(this.devicePoll(a.deviceCode, a.now));
        default:
          return bad(400, `unknown op: ${op}`);
      }
    } catch (e) {
      return bad(500, `op ${op} failed: ${e}`);
    }
  }

  /** Normalize a slug/host key to canonical lowercase form. */
  private norm(slug: unknown): string {
    return typeof slug === "string" ? slug.trim().toLowerCase() : "";
  }

  /**
   * Register slug→tenant. Idempotent for the same pair; rejects a slug that is
   * already owned by a different tenant (collision). Returns:
   *   { ok: true }                       — registered or already owned by tenant
   *   { ok: false, reason: "collision", owner } — slug taken by another tenant
   *   { ok: false, reason: "bad-input" } — empty slug/tenant
   */
  register(
    slug: unknown,
    tenant: unknown,
  ): { ok: boolean; reason?: string; owner?: string } {
    const s = this.norm(slug);
    const t = typeof tenant === "string" ? tenant : "";
    if (!s || !t || !isValidHostKey(s)) return { ok: false, reason: "bad-input" };

    const cur = this.lookup(s);
    if (cur) {
      if (cur === t) return { ok: true }; // idempotent re-register
      return { ok: false, reason: "collision", owner: cur };
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO slugs (slug, tenant) VALUES (?, ?)",
      s,
      t,
    );
    return { ok: true };
  }

  /** Delete slug/host-key ownership only for the owning tenant. Missing rows are
   *  idempotent success; a row owned by another tenant fails closed. */
  unregister(
    slug: unknown,
    tenant: unknown,
  ): { ok: boolean; reason?: string; owner?: string } {
    const s = this.norm(slug);
    const t = typeof tenant === "string" ? tenant : "";
    if (!s || !t || !isValidHostKey(s)) return { ok: false, reason: "bad-input" };
    const cur = this.lookup(s);
    if (!cur) return { ok: true };
    if (cur !== t) return { ok: false, reason: "not-owner", owner: cur };
    this.ctx.storage.sql.exec("DELETE FROM slugs WHERE slug = ?", s);
    return { ok: true };
  }

  /** Resolve a slug to its tenant id, or "" if unknown. */
  lookup(slug: unknown): string {
    const s = this.norm(slug);
    if (!s) return "";
    const rows = this.ctx.storage.sql
      .exec<{ tenant: string }>("SELECT tenant FROM slugs WHERE slug = ?", s)
      .toArray();
    return rows.length ? rows[0].tenant : "";
  }

  /** All host keys currently mapped to a tenant. */
  listForTenant(tenant: unknown): string[] {
    const t = typeof tenant === "string" ? tenant : "";
    if (!t) return [];
    return this.ctx.storage.sql
      .exec<{ slug: string }>(
        "SELECT slug FROM slugs WHERE tenant = ? ORDER BY slug",
        t,
      )
      .toArray()
      .map((row) => row.slug);
  }

  // ---- CLI device-authorization codes -----------------------------------

  private static DEVICE_TTL_MS = 10 * 60 * 1000; // codes live 10 minutes

  /** Record a freshly-started device code, with the initiator's context (shown
   *  at approval so the approver can tell it's their own box). Caps the table to
   *  bound flood. Device codes live on a SEPARATE DO instance from the slug index
   *  (see deviceStub) so this write path never contends slug→tenant resolution. */
  deviceStart(
    deviceCode: unknown,
    userCode: unknown,
    now: number,
    reqIp: unknown,
    reqUa: unknown,
  ): { ok: boolean } {
    const d = typeof deviceCode === "string" ? deviceCode : "";
    const u = typeof userCode === "string" ? userCode.toUpperCase() : "";
    if (!d || !u) return { ok: false };
    // Cheap count FIRST; only prune (a scan) when we're near the cap, so a
    // capped flood doesn't turn every rejected call into a full-table scan.
    const live = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM device_codes")
      .toArray();
    let n = live.length ? live[0].n : 0;
    if (n >= 800) {
      this.ctx.storage.sql.exec(
        "DELETE FROM device_codes WHERE created < ?",
        now - RouterDO.DEVICE_TTL_MS,
      );
      n = this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM device_codes")
        .toArray()[0].n;
    }
    if (n >= 1000) return { ok: false };
    this.ctx.storage.sql.exec(
      "INSERT INTO device_codes (device_code, user_code, created, approved, req_ip, req_ua) VALUES (?, ?, ?, 0, ?, ?)",
      d,
      u,
      now,
      typeof reqIp === "string" ? reqIp : "",
      typeof reqUa === "string" ? reqUa : "",
    );
    return { ok: true };
  }

  /** Describe a pending code's INITIATOR so the approver can confirm it's theirs.
   *  Returns only coarse, non-secret context (never the device_code/token). */
  deviceDescribe(
    userCode: unknown,
    now: number,
  ): { found: boolean; reqIp?: string; reqUa?: string; ageSeconds?: number; approved?: boolean } {
    const u = typeof userCode === "string" ? userCode.trim().toUpperCase().replace(/\s+/g, "") : "";
    if (!u) return { found: false };
    const rows = this.ctx.storage.sql
      .exec<{ created: number; approved: number; req_ip: string; req_ua: string }>(
        "SELECT created, approved, req_ip, req_ua FROM device_codes WHERE replace(user_code,'-','') = replace(?,'-','')",
        u,
      )
      .toArray();
    if (!rows.length) return { found: false };
    const r = rows[0];
    if (now - r.created > RouterDO.DEVICE_TTL_MS) return { found: false };
    return {
      found: true,
      reqIp: r.req_ip || "",
      reqUa: r.req_ua || "",
      ageSeconds: Math.max(0, Math.round((now - r.created) / 1000)),
      approved: !!r.approved,
    };
  }

  /** Browser-side approval: stamp the tenant + minted token onto a pending code. */
  deviceApprove(
    userCode: unknown,
    tenant: unknown,
    token: unknown,
    email: unknown,
    now: number,
  ): { ok: boolean; reason?: string } {
    const u = typeof userCode === "string" ? userCode.trim().toUpperCase().replace(/\s+/g, "") : "";
    const t = typeof tenant === "string" ? tenant : "";
    const tok = typeof token === "string" ? token : "";
    const em = typeof email === "string" ? email.slice(0, 200) : "";
    if (!u || !t || !tok) return { ok: false, reason: "bad-input" };
    const rows = this.ctx.storage.sql
      .exec<{ device_code: string; created: number; approved: number }>(
        "SELECT device_code, created, approved FROM device_codes WHERE replace(user_code,'-','') = replace(?,'-','')",
        u,
      )
      .toArray();
    if (!rows.length) return { ok: false, reason: "not-found" };
    const row = rows[0];
    if (now - row.created > RouterDO.DEVICE_TTL_MS) return { ok: false, reason: "expired" };
    if (row.approved) return { ok: false, reason: "already-used" };
    this.ctx.storage.sql.exec(
      "UPDATE device_codes SET tenant = ?, token = ?, email = ?, approved = 1 WHERE device_code = ?",
      t,
      tok,
      em,
      row.device_code,
    );
    return { ok: true };
  }

  /** CLI poll: returns the token once approved, then consumes the code. */
  devicePoll(
    deviceCode: unknown,
    now: number,
  ): { status: string; token?: string; tenant?: string; email?: string } {
    const d = typeof deviceCode === "string" ? deviceCode : "";
    if (!d) return { status: "not_found" };
    const rows = this.ctx.storage.sql
      .exec<{ created: number; approved: number; token: string; tenant: string; email: string | null }>(
        "SELECT created, approved, token, tenant, email FROM device_codes WHERE device_code = ?",
        d,
      )
      .toArray();
    if (!rows.length) return { status: "not_found" };
    const row = rows[0];
    if (now - row.created > RouterDO.DEVICE_TTL_MS) {
      this.ctx.storage.sql.exec("DELETE FROM device_codes WHERE device_code = ?", d);
      return { status: "expired" };
    }
    if (!row.approved) return { status: "pending" };
    // Approved — hand over the token once, then consume the code.
    this.ctx.storage.sql.exec("DELETE FROM device_codes WHERE device_code = ?", d);
    return { status: "approved", token: row.token, tenant: row.tenant, email: row.email ?? "" };
  }
}

// ---- helpers used by index.ts + TenantDO --------------------------------

/** The singleton RouterDO stub. */
export function routerStub(env: Env): DurableObjectStub {
  return env.ROUTER.get(env.ROUTER.idFromName(ROUTER_SINGLETON));
}

/** A SEPARATE RouterDO instance dedicated to CLI device codes — so the
 *  device-login write path never contends the slug→tenant singleton that the
 *  whole relay plane reads on its hot path. */
function deviceStub(env: Env): DurableObjectStub {
  return env.ROUTER.get(env.ROUTER.idFromName("finch-device-codes"));
}

async function deviceOp(env: Env, body: object): Promise<any> {
  const res = await deviceStub(env).fetch("https://router/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Record a device-authorization code (the `finch login` flow) + initiator ctx. */
export function routerDeviceStart(
  env: Env,
  deviceCode: string,
  userCode: string,
  reqIp: string,
  reqUa: string,
): Promise<{ ok: boolean }> {
  return deviceOp(env, { op: "deviceStart", deviceCode, userCode, reqIp, reqUa, now: Date.now() });
}

/** Describe a pending code's initiator (coarse, non-secret) for the approver. */
export function routerDeviceDescribe(
  env: Env,
  userCode: string,
): Promise<{ found: boolean; reqIp?: string; reqUa?: string; ageSeconds?: number; approved?: boolean }> {
  return deviceOp(env, { op: "deviceDescribe", userCode, now: Date.now() });
}

/** Browser-approve a device code: stamp its tenant + minted token. */
export function routerDeviceApprove(
  env: Env,
  userCode: string,
  tenant: string,
  token: string,
  email: string,
): Promise<{ ok: boolean; reason?: string }> {
  return deviceOp(env, { op: "deviceApprove", userCode, tenant, token, email, now: Date.now() });
}

/** CLI-poll a device code; returns the token once approved (then consumes it). */
export function routerDevicePoll(
  env: Env,
  deviceCode: string,
): Promise<{ status: string; token?: string; tenant?: string; email?: string }> {
  return deviceOp(env, { op: "devicePoll", deviceCode, now: Date.now() });
}

/** Look up a slug→tenant via the singleton RouterDO. Returns "" if unknown. */
export async function routerLookup(env: Env, slug: string): Promise<string> {
  const res = await routerStub(env).fetch("https://router/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "lookup", slug }),
  });
  const out = (await res.json()) as { tenant?: string };
  return out.tenant || "";
}

/** Register a slug→tenant mapping via the singleton RouterDO. */
export async function routerRegister(
  env: Env,
  slug: string,
  tenant: string,
): Promise<{ ok: boolean; reason?: string; owner?: string }> {
  const res = await routerStub(env).fetch("https://router/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "register", slug, tenant }),
  });
  return (await res.json()) as {
    ok: boolean;
    reason?: string;
    owner?: string;
  };
}

/** Unregister a slug/host-key mapping, but only for its owning tenant. */
export async function routerUnregister(
  env: Env,
  slug: string,
  tenant: string,
): Promise<{ ok: boolean; reason?: string; owner?: string }> {
  const res = await routerStub(env).fetch("https://router/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "unregister", slug, tenant }),
  });
  return (await res.json()) as {
    ok: boolean;
    reason?: string;
    owner?: string;
  };
}

/** List every slug/host-key owned by a tenant. */
export async function routerListForTenant(
  env: Env,
  tenant: string,
): Promise<string[]> {
  const res = await routerStub(env).fetch("https://router/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "listForTenant", tenant }),
  });
  const out = (await res.json()) as { keys?: string[] };
  return Array.isArray(out.keys) ? out.keys : [];
}
