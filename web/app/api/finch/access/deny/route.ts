// POST /api/finch/access/deny {id} -> mark the request row denied.
// Pure DO transition — deny NEVER touches Clerk (an already-sent invitation
// stands; the member just gets no service grant).
import {
  callerLabel,
  errorResponse,
  HttpError,
  listAccessAs,
  requireSharing,
  setAccessStatusAs,
} from "@/lib/hub";

export async function POST(req: Request) {
  try {
    const { tenant, userId } = await requireSharing();
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    const id = (body?.id ?? "").trim();
    if (!id) throw new HttpError(400, "id required");

    // Deny is a QUEUE transition only — it never removes ACL rules. So it must
    // refuse a row that's already granted: flipping it to "denied" would show
    // a denied chip while the surviving grant keeps letting the user in.
    const { requests } = await listAccessAs(tenant);
    const row = requests.find((r) => r.id === id);
    if (!row) throw new HttpError(404, "unknown access request");
    if (row.status === "granted") {
      throw new HttpError(409, "already granted — revoke it instead");
    }

    await setAccessStatusAs(tenant, id, "denied", await callerLabel(userId), userId);
    return Response.json({ ok: true, status: "denied" }, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
