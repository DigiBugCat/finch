/// <reference types="@cloudflare/workers-types" />
//
// AviaryEnrollmentDO — RETIRED. It owned the Aviary service-device enrollment
// state machine (/api/aviary/*, /aviary/authorize, `finch aviary …`), which
// was removed when Finch was cut down to the CLI slice.
//
// This stub exists only so the class stays exported: wrangler migration v5
// declared it, and a deploy whose script no longer exports a migrated class
// fails. Its binding is gone, so nothing routes a request here; the only way
// an instance still wakes is the 60s expiry alarm the retired class kept armed
// while an enrollment was in flight.
//
// The rows themselves (and the audit trail) are kept. Deleting that data
// needs an explicit `deleted_classes` migration, deliberately NOT added here —
// do it as a separate, reviewed cleanup once nothing needs the audit rows.
// What is NOT kept is credential material: an enrollment that was approved,
// delivered or awaiting acknowledgement when the cut deployed holds the
// issued refresh token in `grant_json`. The retired cleanup nulled that
// column on expiry; with it gone the token would sit at rest indefinitely, so
// every wake-up scrubs the secret-bearing columns of every row (retire) and
// disarms the alarm.
//
// Boxes enrolled through the old flow keep working: their refresh tokens are
// ordinary TICKET_SECRET grants handled by /refresh (with the per-box
// credential epoch still stored on the TenantDO), not by this object.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

// Columns of the retired aviary_enrollments table that can hold credential
// material: the issued grant (refresh token), and the one-time nonce that
// guarded its approval. Anything else in a row is metadata for the audit.
const SECRET_COLUMNS = ["grant_json", "approval_nonce"];

export class AviaryEnrollmentDO extends DurableObject<Env> {
  async fetch(_req: Request): Promise<Response> {
    await this.retire();
    return Response.json(
      { error: "Aviary device enrollment has been removed" },
      { status: 410 },
    );
  }

  // Fires on an instance that still had the retired expiry alarm armed at
  // deploy time. Without a handler the runtime would error and retry; here it
  // scrubs the stored secrets and does not reschedule, which ends the loop.
  async alarm(): Promise<void> {
    await this.retire();
  }

  /** Null every secret-bearing column in every enrollment row, then disarm
   *  the alarm. Idempotent, and a no-op on an instance that never created
   *  the table (it creates nothing). */
  private async retire(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const columns = new Set(
      sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('aviary_enrollments')")
        .toArray()
        .map((c) => c.name),
    );
    const scrub = SECRET_COLUMNS.filter((c) => columns.has(c));
    if (scrub.length > 0) {
      sql.exec(
        `UPDATE aviary_enrollments SET ${scrub.map((c) => `${c}=NULL`).join(",")} ` +
          `WHERE ${scrub.map((c) => `${c} IS NOT NULL`).join(" OR ")}`,
      );
    }
    await this.ctx.storage.deleteAlarm();
  }
}
