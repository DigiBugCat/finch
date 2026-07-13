// GET /api/finch/access -> hub GET /api/access (the tenant DO's listAccess:
// every access-request row plus the user→service ACL grants). Sharing-gated
// like the rest of the access surface.
import { errorResponse, hubProxy, requireSharing } from "@/lib/hub";

export async function GET() {
  try {
    await requireSharing();
    return await hubProxy("/api/access", { method: "GET" });
  } catch (err) {
    return errorResponse(err);
  }
}
