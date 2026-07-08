// POST /api/finch/acl {src,dst} -> hub POST /api/acl
// Managing access is a paid "sharing" capability — sharingProxy gates on the
// entitlement, not just admin.
import { errorResponse, sharingProxy } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    return await sharingProxy(req, "/api/acl", "POST");
  } catch (err) {
    return errorResponse(err);
  }
}
