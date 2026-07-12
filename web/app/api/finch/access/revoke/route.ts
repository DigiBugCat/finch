// POST /api/finch/access/revoke {id | ruleId} -> pull a user's service grant.
// Accepts either the access-request row id or the ACL rule id. Removal is
// SURGICAL (DO removeUserGrant): only the {user, service} destination comes
// out, so a multi-dst rule keeps its other services. If a broader rule
// (all/tag/group/locked) still covers the user we FAIL with 409 rather than
// report a revoke that changed nothing at the door.
import {
  callerLabel,
  errorResponse,
  HttpError,
  listAccessAs,
  removeUserGrantAs,
  requireSharing,
  setAccessStatusAs,
} from "@/lib/hub";

export async function POST(req: Request) {
  try {
    const { tenant, userId } = await requireSharing();
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      ruleId?: string;
      service?: string;
    };
    const id = (body?.id ?? "").trim();
    const ruleId = (body?.ruleId ?? "").trim();
    if (!id && !ruleId) throw new HttpError(400, "id or ruleId required");

    const { requests, grants } = await listAccessAs(tenant);

    // Resolve the {email, service} pairs to revoke from whichever handle the
    // caller gave us; the DO then removes exactly those pairs. A ruleId (a
    // grants-table row) covers EVERY service the rule dst's; a request-row id
    // covers just that row's service.
    let email: string;
    let services: string[];
    if (ruleId) {
      const rule = grants.find((r) => r.id === ruleId);
      if (!rule) throw new HttpError(404, "unknown grant");
      const svcs = rule.dst
        .filter((d) => d.type === "service" && d.name)
        .map((d) => d.name as string);
      if (rule.src.type !== "user" || !rule.src.name || !svcs.length) {
        throw new HttpError(400, "not a revocable user→service grant");
      }
      email = rule.src.name.toLowerCase();
      services = svcs;
    } else {
      const row = requests.find((r) => r.id === id);
      if (!row) throw new HttpError(404, "unknown access request");
      email = row.email;
      services = [row.service];
    }

    const resolvedBy = await callerLabel(userId);
    for (const service of services) {
      const { stillAllowed } = await removeUserGrantAs(tenant, email, service);
      if (stillAllowed) {
        // The user still reaches the service via a rule this op can't narrow —
        // surface that instead of a false ok (the chip would say revoked while
        // the door still lets them in).
        throw new HttpError(
          409,
          "access is still granted by a broader rule — edit it in the Rules tab",
        );
      }
      // Close every request row for the pair so the queue reflects the door.
      for (const row of requests) {
        if (row.email !== email || row.service !== service) continue;
        if (row.status === "denied") continue;
        await setAccessStatusAs(tenant, row.id, "denied", resolvedBy);
      }
    }
    return Response.json({ ok: true }, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
