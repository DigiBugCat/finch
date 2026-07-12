// POST /api/finch/access/request {email,service} -> hub POST /api/access/request
// Creates (or returns the existing) pending access-request row in the tenant
// DO. The DO is idempotent for a live pending/invited email+service pair.
import {
  callerLabel,
  errorResponse,
  HttpError,
  hubProxy,
  requireSharing,
} from "@/lib/hub";

export async function POST(req: Request) {
  try {
    const { userId } = await requireSharing();
    const body = (await req.json().catch(() => ({}))) as {
      email?: string;
      service?: string;
    };
    const email = (body?.email ?? "").trim().toLowerCase();
    const service = (body?.service ?? "").trim();
    if (!email || !service) {
      throw new HttpError(400, "email and service required");
    }

    return await hubProxy("/api/access/request", {
      method: "POST",
      body: JSON.stringify({
        email,
        service,
        requestedBy: await callerLabel(userId),
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
