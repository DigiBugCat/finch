/// <reference types="@cloudflare/workers-types" />
//
// AviaryEnrollmentDO — RETIRED. It owned the Aviary service-device enrollment
// state machine (/api/aviary/*, /aviary/authorize, `finch aviary …`), which
// was removed when Finch was cut down to the CLI slice.
//
// This stub exists only so the class stays exported: wrangler migration v5
// declared it, and a deploy whose script no longer exports a migrated class
// fails. Its SQLite storage (pending/approved enrollment rows and the audit
// trail) is left untouched. Deleting that data needs an explicit
// `deleted_classes` migration, deliberately NOT added here — do it as a
// separate, reviewed cleanup once nothing needs the audit rows.
//
// Boxes enrolled through the old flow keep working: their refresh tokens are
// ordinary TICKET_SECRET grants handled by /refresh (with the per-box
// credential epoch still stored on the TenantDO), not by this object.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

export class AviaryEnrollmentDO extends DurableObject<Env> {
  async fetch(_req: Request): Promise<Response> {
    return Response.json(
      { error: "Aviary device enrollment has been removed" },
      { status: 410 },
    );
  }
}
