/// <reference types="@cloudflare/workers-types" />
//
// RouterDO — the single global slug→tenantId index for the relay plane.
//
// The control plane keys TenantDO/ApplianceDO by the REAL tenant id (a Clerk org
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

export class RouterDO extends DurableObject<Env> {
  private inited = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /** Lazily create the slug→tenant table. */
  private init(): void {
    if (this.inited) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS slugs (
         slug   TEXT PRIMARY KEY,
         tenant TEXT NOT NULL
       )`,
    );
    this.inited = true;
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
        default:
          return bad(400, `unknown op: ${op}`);
      }
    } catch (e) {
      return bad(500, `op ${op} failed: ${e}`);
    }
  }

  /** Normalize a slug to the canonical host-label form (lowercase). */
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
    if (!s || !t) return { ok: false, reason: "bad-input" };

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

  /** Resolve a slug to its tenant id, or "" if unknown. */
  lookup(slug: unknown): string {
    const s = this.norm(slug);
    if (!s) return "";
    const rows = this.ctx.storage.sql
      .exec<{ tenant: string }>("SELECT tenant FROM slugs WHERE slug = ?", s)
      .toArray();
    return rows.length ? rows[0].tenant : "";
  }
}

// ---- helpers used by index.ts + TenantDO --------------------------------

/** The singleton RouterDO stub. */
export function routerStub(env: Env): DurableObjectStub {
  return env.ROUTER.get(env.ROUTER.idFromName(ROUTER_SINGLETON));
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
