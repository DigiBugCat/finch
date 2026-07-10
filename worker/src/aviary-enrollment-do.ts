/// <reference types="@cloudflare/workers-types" />
//
// AviaryEnrollmentDO owns the service-device authorization state machine.
// It is deliberately separate from the tenant-admin CLI device flow: an
// Aviary grant is bound to one canonical manifest, one proof key, one tenant,
// one service app path, and one box. It can never mint a kind:"cli" token.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { signToken } from "./auth";

export const AVIARY_PROTOCOL = "finch-aviary-service-enrollment-v1";
export const AVIARY_TTL_MS = 10 * 60 * 1000;
export const AVIARY_POLL_INTERVAL_SECONDS = 3;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_PENDING = 1000;
const MAX_ROWS = 2000;
const MAX_AUDIT = 4000;
const MAX_STARTS_PER_IP_MINUTE = 10;
const APPROVAL_GRACE_MS = 30 * 1000;
const DELIVERY_RETRY_MS = 60 * 1000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface AviaryManifest {
  service: string;
  app_path: string;
  routes: string[];
  edge_auth: "key" | "public";
  machine: string;
  machine_fingerprint: string;
  expected_tenant?: string;
}

interface EnrollmentRow {
  [key: string]: string | number | null;
  device_code: string;
  user_code: string;
  manifest_json: string;
  manifest_sha256: string;
  public_key: string;
  req_ip: string;
  req_ua: string;
  created: number;
  expires: number;
  state: string;
  tenant: string | null;
  approver: string | null;
  public_approved: number;
  grant_json: string | null;
  detail: string | null;
  approval_started: number | null;
  approval_nonce: string | null;
  consumed_by: string | null;
  delivery_id: string | null;
  delivery_deadline: number | null;
  service_created: number | null;
  credential_epoch: number | null;
}

type InternalResult = {
  ok: boolean;
  code?: string;
  status?: string;
  message?: string;
  [key: string]: unknown;
};

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function normalizeUserCode(raw: unknown): string {
  return typeof raw === "string"
    ? raw.trim().toUpperCase().replace(/[\s-]+/g, "")
    : "";
}

function randomHex(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(raw, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Resolve the canonical relay origin for a newly-approved Aviary service.
 *
 * An explicit deployment override wins over a tenant vanity host. Every input
 * is treated as a complete origin rather than a URL prefix so a deployment
 * typo can never mint a grant containing credentials, a path, query, or
 * fragment. `undefined` means the deployment did not configure an override;
 * an explicitly configured empty/invalid value fails closed.
 */
export function resolveAviaryPublicOrigin(
  configuredOrigin: string | undefined,
  tenantHost: string | undefined,
  requestOrigin: string,
): string | null {
  const exactOrigin = (raw: string): string | null => {
    try {
      const parsed = new URL(raw);
      if (
        (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash ||
        raw !== parsed.origin
      ) {
        return null;
      }
      return parsed.origin;
    } catch {
      return null;
    }
  };

  if (configuredOrigin !== undefined) return exactOrigin(configuredOrigin);
  if (tenantHost) return exactOrigin(`https://${tenantHost}`);
  return exactOrigin(requestOrigin);
}

function randomUserCode(): string {
  const raw = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (const b of raw) out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function b64urlToBytes(raw: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((raw.length + 3) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function proofStatement(deviceCode: string, manifestSha256: string): Uint8Array {
  return new TextEncoder().encode(
    `${AVIARY_PROTOCOL}\npoll\n${deviceCode}\n${manifestSha256}`,
  );
}

async function tenantOp<T>(
  env: Env,
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
  const out = (await res.json()) as T & { error?: string };
  if (!res.ok && !(out && typeof out === "object" && "error" in out)) {
    throw new Error(`tenant operation ${op} failed`);
  }
  return out;
}

export class AviaryEnrollmentDO extends DurableObject<Env> {
  private init(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS aviary_enrollments (
         device_code       TEXT PRIMARY KEY,
         user_code         TEXT NOT NULL UNIQUE,
         manifest_json     TEXT NOT NULL,
         manifest_sha256   TEXT NOT NULL,
         public_key        TEXT NOT NULL,
         req_ip            TEXT NOT NULL,
         req_ua            TEXT NOT NULL,
         created           INTEGER NOT NULL,
         expires           INTEGER NOT NULL,
         state             TEXT NOT NULL,
         tenant            TEXT,
         approver          TEXT,
         public_approved   INTEGER NOT NULL DEFAULT 0,
         grant_json        TEXT,
         detail            TEXT,
         approval_started  INTEGER,
         approval_nonce    TEXT,
         consumed_by       TEXT,
         delivery_id       TEXT,
         delivery_deadline INTEGER,
         service_created   INTEGER NOT NULL DEFAULT 0,
         credential_epoch  INTEGER
       )`,
    );
    try {
      this.ctx.storage.sql.exec(
        "ALTER TABLE aviary_enrollments ADD COLUMN approval_started INTEGER",
      );
    } catch {
      /* present on new databases and after the first migration-on-read */
    }
    for (const statement of [
      "ALTER TABLE aviary_enrollments ADD COLUMN approval_nonce TEXT",
      "ALTER TABLE aviary_enrollments ADD COLUMN consumed_by TEXT",
      "ALTER TABLE aviary_enrollments ADD COLUMN delivery_id TEXT",
      "ALTER TABLE aviary_enrollments ADD COLUMN delivery_deadline INTEGER",
      "ALTER TABLE aviary_enrollments ADD COLUMN service_created INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE aviary_enrollments ADD COLUMN credential_epoch INTEGER",
    ]) {
      try {
        this.ctx.storage.sql.exec(statement);
      } catch {
        /* column already present */
      }
    }
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_aviary_user_code ON aviary_enrollments(user_code)",
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_aviary_pending ON aviary_enrollments(state, expires)",
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS aviary_start_rate (
         ip TEXT NOT NULL,
         minute INTEGER NOT NULL,
         count INTEGER NOT NULL,
         PRIMARY KEY (ip, minute)
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS aviary_audit (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         created INTEGER NOT NULL,
         event TEXT NOT NULL,
         user_code TEXT NOT NULL,
         manifest_sha256 TEXT NOT NULL,
         tenant TEXT,
         actor TEXT,
         detail TEXT
       )`,
    );
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return response({ error: "POST only" }, 405);
    let msg: Record<string, unknown>;
    try {
      msg = await req.json();
    } catch {
      return response({ error: "invalid JSON" }, 400);
    }
    const op = typeof msg.op === "string" ? msg.op : "";
    if (!op) return response({ error: "missing op" }, 400);
    this.init();
    this.cleanup(Date.now());
    try {
      switch (op) {
        case "start":
          return response(this.start(msg));
        case "describe":
          return response(this.describe(msg.userCode, Number(msg.now) || Date.now()));
        case "approve":
          return response(await this.approve(msg));
        case "deny":
          return response(this.deny(msg));
        case "poll":
          return response(await this.poll(msg));
        default:
          return response({ error: `unknown op: ${op}` }, 400);
      }
    } catch {
      // Never echo exception strings: a future storage/signing implementation
      // could put credential material in them.
      return response({ ok: false, code: "internal_error", message: "enrollment operation failed" });
    }
  }

  async alarm(): Promise<void> {
    this.init();
    this.cleanup(Date.now());
    const active = this.ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM aviary_enrollments WHERE state IN ('pending','approving','approved','delivered','acknowledging')",
      )
      .toArray()[0]?.n ?? 0;
    if (active > 0) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  private cleanup(now: number): void {
    const staleAcks = this.ctx.storage.sql
      .exec<EnrollmentRow>(
        "SELECT * FROM aviary_enrollments WHERE state='acknowledging' AND COALESCE(delivery_deadline,0) < ?",
        now,
      )
      .toArray();
    for (const row of staleAcks) this.ctx.waitUntil(this.resolveStaleAck(row, now));
    const staleDeliveries = this.ctx.storage.sql
      .exec<EnrollmentRow>(
        `SELECT * FROM aviary_enrollments
         WHERE state='delivered'
           AND (expires < ? OR COALESCE(delivery_deadline,0) < ?)`,
        now,
        now,
      )
      .toArray();
    for (const row of staleDeliveries) {
      this.audit("consume", row, row.tenant ?? "", "", "delivery window elapsed", now);
      this.scheduleRollback(row);
    }
    this.ctx.storage.sql.exec(
      `UPDATE aviary_enrollments
       SET state='consumed',grant_json=NULL,detail='delivery window elapsed'
       WHERE state='delivered'
         AND (expires < ? OR COALESCE(delivery_deadline,0) < ?)`,
      now,
      now,
    );
    const expiring = this.ctx.storage.sql
      .exec<EnrollmentRow>(
        `SELECT * FROM aviary_enrollments
         WHERE expires < ?
           AND (state IN ('pending','approved')
             OR (state='approving' AND COALESCE(approval_started,0) < ?))`,
        now,
        now - APPROVAL_GRACE_MS,
      )
      .toArray();
    for (const row of expiring) {
      this.audit("expire", row, row.tenant ?? "", "", "expired", now);
      this.scheduleRollback(row);
    }
    this.ctx.storage.sql.exec(
      `UPDATE aviary_enrollments
       SET state='expired',grant_json=NULL,detail='expired'
       WHERE expires < ?
         AND (state IN ('pending','approved')
           OR (state='approving' AND COALESCE(approval_started,0) < ?))`,
      now,
      now - APPROVAL_GRACE_MS,
    );
    // Terminal rows remain briefly for a useful denied/expired/replay status,
    // then disappear. In particular, plaintext refresh grants never survive
    // expiration, even if the agent abandons polling after browser approval.
    this.ctx.storage.sql.exec(
      "DELETE FROM aviary_enrollments WHERE expires < ? AND state IN ('expired','denied','consumed')",
      now - AVIARY_TTL_MS,
    );
  }

  private async resolveStaleAck(row: EnrollmentRow, now: number): Promise<void> {
    if (!row.tenant || typeof row.credential_epoch !== "number") return;
    let manifest: AviaryManifest;
    try {
      manifest = JSON.parse(row.manifest_json) as AviaryManifest;
    } catch {
      return;
    }
    const epoch: { exists: boolean; epoch?: number } = await tenantOp<{
      exists: boolean;
      epoch?: number;
    }>(
      this.env,
      row.tenant,
      "boxCredentialEpoch",
      { service: manifest.app_path, box: manifest.machine },
    ).catch(() => ({ exists: false }));
    const current = this.rowByDevice(row.device_code);
    if (!current || current.state !== "acknowledging" || current.delivery_id !== row.delivery_id) return;
    if (epoch.exists && epoch.epoch === row.credential_epoch) {
      this.ctx.storage.sql.exec(
        "UPDATE aviary_enrollments SET state='consumed',grant_json=NULL,detail='consumed' WHERE device_code=? AND state='acknowledging'",
        row.device_code,
      );
      this.audit("consume", row, row.tenant, "", "recovered committed acknowledgement", now);
      return;
    }
    this.scheduleRollback(row);
    this.ctx.storage.sql.exec(
      "UPDATE aviary_enrollments SET state='consumed',grant_json=NULL,detail='acknowledgement expired' WHERE device_code=? AND state='acknowledging'",
      row.device_code,
    );
  }

  private scheduleRollback(row: EnrollmentRow): void {
    if (
      !row.tenant ||
      !row.approval_nonce ||
      (row.state !== "approving" &&
        row.state !== "approved" &&
        row.state !== "delivered" &&
        row.state !== "acknowledging")
    ) {
      return;
    }
    let manifest: AviaryManifest;
    try {
      manifest = JSON.parse(row.manifest_json) as AviaryManifest;
    } catch {
      return;
    }
    this.ctx.waitUntil(
      tenantOp(this.env, row.tenant, "releaseAviaryService", {
        appPath: manifest.app_path,
        manifestSha256: row.manifest_sha256,
        approvalNonce: row.approval_nonce,
      }).catch(() => undefined),
    );
  }

  private audit(
    event: string,
    row: Pick<EnrollmentRow, "user_code" | "manifest_sha256">,
    tenant = "",
    actor = "",
    detail = "",
    now = Date.now(),
  ): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO aviary_audit(created,event,user_code,manifest_sha256,tenant,actor,detail) VALUES(?,?,?,?,?,?,?)",
      now,
      event,
      row.user_code,
      row.manifest_sha256,
      tenant.slice(0, 200),
      actor.slice(0, 200),
      detail.slice(0, 300),
    );
    const count = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM aviary_audit")
      .toArray()[0]?.n ?? 0;
    if (count > MAX_AUDIT) {
      this.ctx.storage.sql.exec(
        "DELETE FROM aviary_audit WHERE id IN (SELECT id FROM aviary_audit ORDER BY id ASC LIMIT ?)",
        count - MAX_AUDIT,
      );
    }
  }

  private rowByDevice(deviceCode: unknown): EnrollmentRow | null {
    if (typeof deviceCode !== "string" || !/^[a-f0-9]{64}$/.test(deviceCode)) return null;
    return (
      this.ctx.storage.sql
        .exec<EnrollmentRow>("SELECT * FROM aviary_enrollments WHERE device_code = ?", deviceCode)
        .toArray()[0] ?? null
    );
  }

  private rowByUser(userCode: unknown): EnrollmentRow | null {
    const normalized = normalizeUserCode(userCode);
    if (!/^[A-Z2-9]{8}$/.test(normalized)) return null;
    return (
      this.ctx.storage.sql
        .exec<EnrollmentRow>(
          "SELECT * FROM aviary_enrollments WHERE replace(user_code,'-','') = ?",
          normalized,
        )
        .toArray()[0] ?? null
    );
  }

  private expire(row: EnrollmentRow, now: number): boolean {
    if (row.expires >= now || row.state === "consumed" || row.state === "denied") return false;
    if (row.state === "delivered") {
      this.scheduleRollback(row);
      this.ctx.storage.sql.exec(
        "UPDATE aviary_enrollments SET state='consumed',grant_json=NULL,detail='delivery window elapsed' WHERE device_code=? AND state='delivered'",
        row.device_code,
      );
      row.state = "consumed";
      row.grant_json = null;
      this.audit("consume", row, row.tenant ?? "", "", "delivery window elapsed", now);
      return true;
    }
    if (
      row.state === "approving" &&
      typeof row.approval_started === "number" &&
      row.approval_started + APPROVAL_GRACE_MS >= now
    ) {
      // An approval that began before expiry gets one tightly bounded window
      // to finish its TenantDO transaction. cleanup/alarm expires a stuck
      // approval immediately after this window.
      return false;
    }
    if (
      row.state === "acknowledging" &&
      typeof row.delivery_deadline === "number" &&
      row.delivery_deadline >= now
    ) {
      return false;
    }
    if (row.state !== "expired") {
      this.scheduleRollback(row);
      this.ctx.storage.sql.exec(
        "UPDATE aviary_enrollments SET state='expired', grant_json=NULL, detail='expired' WHERE device_code=?",
        row.device_code,
      );
      row.state = "expired";
      row.grant_json = null;
      row.detail = "expired";
      this.audit("expire", row, row.tenant ?? "", "", "expired", now);
    }
    return true;
  }

  private start(msg: Record<string, unknown>): InternalResult {
    const now = Number(msg.now) || Date.now();
    const manifest = msg.manifest as AviaryManifest;
    const manifestJson = typeof msg.manifestJson === "string" ? msg.manifestJson : "";
    const digest = typeof msg.manifestSha256 === "string" ? msg.manifestSha256 : "";
    const publicKey = typeof msg.publicKey === "string" ? msg.publicKey : "";
    const reqIp = typeof msg.reqIp === "string" ? msg.reqIp.slice(0, 100) : "";
    const reqUa = typeof msg.reqUa === "string" ? msg.reqUa.slice(0, 200) : "";
    if (!manifest || !manifestJson || !/^[a-f0-9]{64}$/.test(digest) || !publicKey) {
      return { ok: false, code: "invalid_request", message: "invalid enrollment start" };
    }

    // Retry safety: only the exact same manifest + proof key gets the existing
    // secret back. A changed route/auth/key never widens a pending request.
    const retry = this.ctx.storage.sql
      .exec<EnrollmentRow>(
        "SELECT * FROM aviary_enrollments WHERE manifest_sha256=? AND public_key=? AND state='pending' AND expires>=?",
        digest,
        publicKey,
        now,
      )
      .toArray()[0];
    if (retry) {
      return {
        ok: true,
        reused: true,
        device_code: retry.device_code,
        user_code: retry.user_code,
        expires: retry.expires,
      };
    }

    const minute = Math.floor(now / 60_000);
    this.ctx.storage.sql.exec("DELETE FROM aviary_start_rate WHERE minute < ?", minute - 2);
    const rate = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT count FROM aviary_start_rate WHERE ip=? AND minute=?",
        reqIp || "unknown",
        minute,
      )
      .toArray()[0]?.count ?? 0;
    if (rate >= MAX_STARTS_PER_IP_MINUTE) {
      return { ok: false, code: "rate_limited", message: "too many enrollment attempts" };
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO aviary_start_rate(ip,minute,count) VALUES(?,?,1) ON CONFLICT(ip,minute) DO UPDATE SET count=count+1",
      reqIp || "unknown",
      minute,
    );

    const pending = this.ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM aviary_enrollments WHERE state IN ('pending','approving') AND expires>=?",
        now,
      )
      .toArray()[0]?.n ?? 0;
    if (pending >= MAX_PENDING) {
      this.ctx.storage.sql.exec(
        "DELETE FROM aviary_enrollments WHERE expires < ? AND state IN ('expired','denied','consumed')",
        now - AVIARY_TTL_MS,
      );
      return { ok: false, code: "pending_limit", message: "too many pending enrollments" };
    }
    const total = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM aviary_enrollments")
      .toArray()[0]?.n ?? 0;
    if (total >= MAX_ROWS) {
      return { ok: false, code: "pending_limit", message: "enrollment storage is at capacity" };
    }

    // A single machine cannot have two simultaneous claims for the same app
    // path. Different machines/tenants may legitimately choose the same path;
    // tenant ownership is checked atomically at approval.
    const conflict = this.ctx.storage.sql
      .exec<EnrollmentRow>(
        "SELECT * FROM aviary_enrollments WHERE state IN ('pending','approving') AND expires>=? AND json_extract(manifest_json,'$.machine_fingerprint')=? AND json_extract(manifest_json,'$.app_path')=?",
        now,
        manifest.machine_fingerprint,
        manifest.app_path,
      )
      .toArray()[0];
    if (conflict) {
      return { ok: false, code: "manifest_conflict", message: "that machine app path already has a pending enrollment" };
    }

    let deviceCode = "";
    let userCode = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      deviceCode = randomHex(32);
      userCode = randomUserCode();
      if (!this.rowByDevice(deviceCode) && !this.rowByUser(userCode)) break;
      deviceCode = "";
    }
    if (!deviceCode) return { ok: false, code: "code_generation_failed", message: "could not allocate enrollment code" };
    const expires = now + AVIARY_TTL_MS;
    this.ctx.storage.sql.exec(
      `INSERT INTO aviary_enrollments(
         device_code,user_code,manifest_json,manifest_sha256,public_key,
         req_ip,req_ua,created,expires,state,public_approved
       ) VALUES(?,?,?,?,?,?,?,?,?,'pending',0)`,
      deviceCode,
      userCode,
      manifestJson,
      digest,
      publicKey,
      reqIp,
      reqUa,
      now,
      expires,
    );
    this.audit("start", { user_code: userCode, manifest_sha256: digest }, "", "", reqIp, now);
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Math.min(expires, now + 60_000)));
    return { ok: true, reused: false, device_code: deviceCode, user_code: userCode, expires };
  }

  private describe(userCode: unknown, now: number): InternalResult {
    const row = this.rowByUser(userCode);
    if (!row) return { ok: false, code: "not_found", message: "enrollment code not found" };
    this.expire(row, now);
    const manifest = JSON.parse(row.manifest_json) as AviaryManifest;
    return {
      ok: true,
      found: true,
      status:
        row.state === "approving"
          ? "pending"
          : row.state === "consumed" || row.state === "delivered" || row.state === "acknowledging"
            ? "approved"
            : row.state,
      manifest,
      manifest_sha256: row.manifest_sha256,
      req_ip: row.req_ip,
      req_ua: row.req_ua,
      age_seconds: Math.max(0, Math.floor((now - row.created) / 1000)),
      expires_at: new Date(row.expires).toISOString(),
      public_approval_required: manifest.edge_auth === "public",
      public_approved: !!row.public_approved,
      ...(row.tenant && (row.state === "approved" || row.state === "delivered" || row.state === "acknowledging" || row.state === "consumed")
        ? { approved_tenant: row.tenant }
        : {}),
      ...(row.approver ? { approver: row.approver } : {}),
      ...(row.detail ? { detail: row.detail } : {}),
    };
  }

  private async approve(msg: Record<string, unknown>): Promise<InternalResult> {
    const now = Number(msg.now) || Date.now();
    const row = this.rowByUser(msg.userCode);
    const tenant = typeof msg.tenant === "string" ? msg.tenant.slice(0, 200) : "";
    const approver = typeof msg.approver === "string" ? msg.approver.slice(0, 200) : "";
    const publicApproved = msg.publicApproved === true;
    const publicOrigin = typeof msg.publicOrigin === "string" ? msg.publicOrigin : "";
    if (!row) return { ok: false, code: "not_found", message: "enrollment code not found" };
    if (this.expire(row, now)) return { ok: false, code: "expired", status: "expired", message: "enrollment code expired" };
    if (!tenant) return { ok: false, code: "invalid_tenant", message: "tenant required" };
    const manifest = JSON.parse(row.manifest_json) as AviaryManifest;
    if (manifest.expected_tenant && manifest.expected_tenant !== tenant) {
      return {
        ok: false,
        code: "tenant_mismatch",
        message: "sign in to the tenant named by the approved manifest",
      };
    }
    if (manifest.edge_auth === "public" && !publicApproved) {
      return { ok: false, code: "public_approval_required", message: "public Internet access requires separate confirmation" };
    }
    if (row.state === "approved" || row.state === "delivered" || row.state === "acknowledging") {
      return { ok: true, status: "approved", approved_tenant: row.tenant };
    }
    if (row.state === "denied" || row.state === "consumed") {
      return { ok: false, code: "terminal_state", status: row.state, message: "enrollment can no longer be approved" };
    }
    if (row.state === "approving") {
      if (row.tenant && row.tenant !== tenant) {
        return { ok: false, code: "tenant_conflict", message: "enrollment is already being approved for another tenant" };
      }
      // Only the request that changed pending -> approving owns the external
      // TenantDO mutation. Duplicate clicks do not join the transaction and can
      // never compensate/undo the owner's successful approval.
      return { ok: true, status: "pending" };
    }

    // Resolve and validate the grant URL before reserving a service or moving
    // this enrollment into the approval transaction. A bad deployment value
    // therefore fails closed without leaving a registered service behind.
    const state = await tenantOp<{ host?: string }>(this.env, tenant, "getState");
    const origin = resolveAviaryPublicOrigin(
      this.env.AVIARY_PUBLIC_ORIGIN,
      state.host,
      publicOrigin,
    );
    if (!origin) {
      return {
        ok: false,
        code: "invalid_public_origin",
        message: "Aviary public origin is not a valid HTTP(S) origin",
      };
    }

    const approvalNonce = randomHex(16);
    this.ctx.storage.sql.exec(
      "UPDATE aviary_enrollments SET state='approving',tenant=?,approver=?,public_approved=?,approval_started=?,approval_nonce=? WHERE device_code=? AND state='pending'",
      tenant,
      approver,
      publicApproved ? 1 : 0,
      now,
      approvalNonce,
      row.device_code,
    );
    const owner = this.rowByDevice(row.device_code);
    if (!owner || owner.state !== "approving" || owner.approval_nonce !== approvalNonce) {
      return { ok: true, status: owner?.state === "approved" ? "approved" : "pending" };
    }

    const registered = await tenantOp<{
      ok: boolean;
      error?: string;
      created?: boolean;
      credentialEpoch?: number;
    }>(
      this.env,
      tenant,
      "registerAviaryService",
      {
        manifest,
        manifestSha256: row.manifest_sha256,
        approvalNonce,
      },
    );
    if (!registered.ok) {
      const code = registered.error === "app_path_collision" ? "app_path_collision" : "registration_failed";
      const detail = code === "app_path_collision" ? "app path is already owned by another service" : "service registration failed";
      this.ctx.storage.sql.exec(
        "UPDATE aviary_enrollments SET state='denied',grant_json=NULL,detail=? WHERE device_code=?",
        code,
        row.device_code,
      );
      this.audit("deny", row, tenant, approver, code, now);
      return { ok: false, code, status: "denied", message: detail };
    }
    if (typeof registered.credentialEpoch !== "number") {
      return { ok: false, code: "registration_failed", message: "service credential epoch was not reserved" };
    }
    this.ctx.storage.sql.exec(
      "UPDATE aviary_enrollments SET service_created=?,credential_epoch=? WHERE device_code=? AND state='approving' AND approval_nonce=?",
      registered.created === false ? 0 : 1,
      registered.credentialEpoch,
      row.device_code,
      approvalNonce,
    );

    let current = this.rowByDevice(row.device_code);
    if (
      !current ||
      current.state !== "approving" ||
      current.tenant !== tenant ||
      current.approval_nonce !== approvalNonce ||
      typeof current.approval_started !== "number" ||
      current.approval_started + APPROVAL_GRACE_MS < Date.now()
    ) {
      await tenantOp(this.env, tenant, "releaseAviaryService", {
        appPath: manifest.app_path,
        manifestSha256: row.manifest_sha256,
        approvalNonce,
      }).catch(() => undefined);
      return { ok: false, code: "expired", status: "expired", message: "enrollment expired during approval" };
    }

    const refreshToken = await signToken(
      {
        tenant,
        service: manifest.app_path,
        box: manifest.machine,
        kind: "refresh",
        epoch: current.credential_epoch ?? undefined,
        exp: Math.floor(now / 1000) + REFRESH_TOKEN_TTL_SECONDS,
      },
      this.env.TICKET_SECRET,
    );
    const grant = {
      tenant,
      service: manifest.app_path,
      box: manifest.machine,
      refresh_token: refreshToken,
      public_url: `${origin}/${encodeURIComponent(manifest.app_path)}/mcp`,
      manifest_sha256: row.manifest_sha256,
      edge_auth: manifest.edge_auth,
      routes: [...manifest.routes],
      machine_fingerprint: manifest.machine_fingerprint,
      public_approved: manifest.edge_auth === "public" ? publicApproved : false,
      ...(manifest.expected_tenant
        ? { expected_tenant: manifest.expected_tenant }
        : {}),
    };
    current = this.rowByDevice(row.device_code);
    if (
      !current ||
      current.state !== "approving" ||
      current.tenant !== tenant ||
      current.approval_nonce !== approvalNonce ||
      typeof current.approval_started !== "number" ||
      current.approval_started + APPROVAL_GRACE_MS < Date.now()
    ) {
      await tenantOp(this.env, tenant, "releaseAviaryService", {
        appPath: manifest.app_path,
        manifestSha256: row.manifest_sha256,
        approvalNonce,
      }).catch(() => undefined);
      return { ok: false, code: "expired", status: "expired", message: "enrollment expired during approval" };
    }
    this.ctx.storage.sql.exec(
      "UPDATE aviary_enrollments SET state='approved',grant_json=?,detail=NULL WHERE device_code=? AND state='approving' AND tenant=? AND approval_started=? AND approval_nonce=?",
      JSON.stringify(grant),
      row.device_code,
      tenant,
      current.approval_started,
      approvalNonce,
    );
    const finalized = this.rowByDevice(row.device_code);
    if (
      !finalized ||
      finalized.state !== "approved" ||
      finalized.approval_nonce !== approvalNonce ||
      !finalized.grant_json
    ) {
      await tenantOp(this.env, tenant, "releaseAviaryService", {
        appPath: manifest.app_path,
        manifestSha256: row.manifest_sha256,
        approvalNonce,
      }).catch(() => undefined);
      return { ok: false, code: "terminal_state", message: "enrollment changed during approval" };
    }
    this.audit("approve", row, tenant, approver, manifest.edge_auth, now);
    return { ok: true, status: "approved", approved_tenant: tenant };
  }

  private deny(msg: Record<string, unknown>): InternalResult {
    const now = Number(msg.now) || Date.now();
    const row = this.rowByUser(msg.userCode);
    const tenant = typeof msg.tenant === "string" ? msg.tenant.slice(0, 200) : "";
    const approver = typeof msg.approver === "string" ? msg.approver.slice(0, 200) : "";
    const reason = typeof msg.reason === "string" && msg.reason.trim()
      ? msg.reason.trim().slice(0, 300)
      : "denied by administrator";
    if (!row) return { ok: false, code: "not_found", message: "enrollment code not found" };
    if (this.expire(row, now)) return { ok: false, code: "expired", status: "expired", message: "enrollment code expired" };
    if (row.state === "denied") return { ok: true, status: "denied" };
    if (row.state !== "pending") {
      return { ok: false, code: "terminal_state", status: row.state, message: "enrollment can no longer be denied" };
    }
    this.ctx.storage.sql.exec(
      "UPDATE aviary_enrollments SET state='denied',tenant=?,approver=?,grant_json=NULL,detail=? WHERE device_code=? AND state='pending'",
      tenant,
      approver,
      reason,
      row.device_code,
    );
    this.audit("deny", row, tenant, approver, reason, now);
    return { ok: true, status: "denied" };
  }

  private async poll(msg: Record<string, unknown>): Promise<InternalResult> {
    const now = Number(msg.now) || Date.now();
    const row = this.rowByDevice(msg.deviceCode);
    if (!row) return { ok: false, code: "not_found", message: "enrollment not found" };
    const digest = typeof msg.manifestSha256 === "string" ? msg.manifestSha256 : "";
    const publicKey = typeof msg.publicKey === "string" ? msg.publicKey : "";
    const signature = typeof msg.signature === "string" ? msg.signature : "";
    const ackDelivery = typeof msg.ackDelivery === "string" ? msg.ackDelivery : "";
    if (digest !== row.manifest_sha256) {
      return { ok: false, code: "manifest_mismatch", message: "manifest binding does not match" };
    }
    if (publicKey !== row.public_key) {
      return { ok: false, code: "invalid_proof", message: "proof key does not match" };
    }
    const keyBytes = b64urlToBytes(publicKey);
    const sigBytes = b64urlToBytes(signature);
    if (!keyBytes || keyBytes.length !== 32 || !sigBytes || sigBytes.length !== 64) {
      return { ok: false, code: "invalid_proof", message: "invalid Ed25519 proof" };
    }
    let proofOk = false;
    try {
      const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
      proofOk = await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        sigBytes,
        ackDelivery
          ? new TextEncoder().encode(
              `${AVIARY_PROTOCOL}\nack\n${row.device_code}\n${digest}\n${ackDelivery}`,
            )
          : proofStatement(row.device_code, digest),
      );
    } catch {
      proofOk = false;
    }
    if (!proofOk) return { ok: false, code: "invalid_proof", message: "invalid Ed25519 proof" };
    // Crypto verification yields; re-read durable state before making the
    // one-time transition so an interleaved approval/denial/expiry cannot be
    // mistaken for the stale row captured above.
    const current = this.rowByDevice(row.device_code);
    if (!current) return { ok: false, code: "not_found", message: "enrollment not found" };
    if (this.expire(current, Date.now())) return { ok: true, status: "expired" };
    if (ackDelivery) {
      if (current.delivery_id !== ackDelivery) {
        return { ok: false, code: "invalid_delivery_ack", message: "delivery acknowledgement does not match" };
      }
      if (current.state === "consumed") {
        return { ok: true, status: "consumed" }; // idempotent lost ACK response
      }
      if (current.state !== "delivered" && current.state !== "acknowledging") {
        return { ok: false, code: "invalid_delivery_ack", message: "grant has not been delivered" };
      }
      if (current.state === "acknowledging" && current.consumed_by !== ackDelivery) {
        return { ok: false, code: "invalid_delivery_ack", message: "another acknowledgement is active" };
      }
      if (current.state === "delivered") {
        this.ctx.storage.sql.exec(
          "UPDATE aviary_enrollments SET state='acknowledging',consumed_by=?,delivery_deadline=? WHERE device_code=? AND state='delivered' AND delivery_id=?",
          ackDelivery,
          Date.now() + APPROVAL_GRACE_MS,
          current.device_code,
          ackDelivery,
        );
      }
      if (
        !current.tenant ||
        !current.approval_nonce ||
        typeof current.credential_epoch !== "number"
      ) {
        return { ok: false, code: "credential_epoch_commit_failed", message: "credential epoch is unavailable" };
      }
      const manifest = JSON.parse(current.manifest_json) as AviaryManifest;
      const committed = await tenantOp<{ ok: boolean }>(
        this.env,
        current.tenant,
        "commitAviaryCredentialEpoch",
        {
          appPath: manifest.app_path,
          box: manifest.machine,
          approvalNonce: current.approval_nonce,
          credentialEpoch: current.credential_epoch,
        },
      );
      if (!committed.ok) {
        return { ok: false, code: "credential_epoch_commit_failed", message: "credential activation failed" };
      }
      this.ctx.storage.sql.exec(
        "UPDATE aviary_enrollments SET state='consumed',grant_json=NULL,detail='consumed',consumed_by=? WHERE device_code=? AND state='acknowledging' AND delivery_id=? AND consumed_by=?",
        ackDelivery,
        current.device_code,
        ackDelivery,
        ackDelivery,
      );
      const acknowledged = this.rowByDevice(current.device_code);
      if (!acknowledged || acknowledged.state !== "consumed" || acknowledged.consumed_by !== ackDelivery) {
        return { ok: false, code: "invalid_delivery_ack", message: "delivery acknowledgement lost its race" };
      }
      this.audit("consume", current, current.tenant ?? "", "", "grant persisted by agent", now);
      return { ok: true, status: "consumed" };
    }
    if (current.state === "pending" || current.state === "approving") return { ok: true, status: "pending" };
    if (current.state === "denied") return { ok: true, status: "denied", detail: current.detail || "denied" };
    if (current.state === "expired") return { ok: true, status: "expired" };
    if (current.state === "consumed") {
      return { ok: true, status: "denied", detail: "enrollment grant already consumed" };
    }
    if (current.state === "delivered" || current.state === "acknowledging") {
      if (!current.grant_json || !current.delivery_id) {
        return { ok: false, code: "invalid_state", message: "delivered grant is unavailable" };
      }
      return {
        ok: true,
        status: "approved",
        delivery_id: current.delivery_id,
        grant: JSON.parse(current.grant_json),
      };
    }
    if (current.state !== "approved" || !current.grant_json) {
      return { ok: false, code: "invalid_state", message: "enrollment is in an invalid state" };
    }

    // Retain the exact proof-gated grant briefly so a lost HTTP response can be
    // retried. finchd ACKs with a distinct Ed25519 statement only after its
    // owner-only credential file has been atomically persisted.
    const deliveryID = randomHex(16);
    this.ctx.storage.sql.exec(
      "UPDATE aviary_enrollments SET state='delivered',delivery_id=?,delivery_deadline=? WHERE device_code=? AND state='approved'",
      deliveryID,
      Math.min(current.expires, Date.now() + DELIVERY_RETRY_MS),
      current.device_code,
    );
    const delivered = this.rowByDevice(current.device_code);
    if (!delivered || delivered.state !== "delivered" || delivered.delivery_id !== deliveryID) {
      if (delivered?.state === "delivered" && delivered.grant_json && delivered.delivery_id) {
        return {
          ok: true,
          status: "approved",
          delivery_id: delivered.delivery_id,
          grant: JSON.parse(delivered.grant_json),
        };
      }
      return { ok: false, code: "invalid_state", message: "grant delivery transition failed" };
    }
    this.audit("deliver", current, current.tenant ?? "", "", "grant released", now);
    return {
      ok: true,
      status: "approved",
      delivery_id: deliveryID,
      grant: JSON.parse(current.grant_json),
    };
  }
}

function enrollmentStub(env: Env): DurableObjectStub {
  return env.AVIARY_ENROLLMENT.get(env.AVIARY_ENROLLMENT.idFromName("global"));
}

export async function aviaryEnrollmentOp<T = InternalResult>(
  env: Env,
  op: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await enrollmentStub(env).fetch("https://aviary-enrollment/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...args }),
  });
  return (await res.json()) as T;
}
