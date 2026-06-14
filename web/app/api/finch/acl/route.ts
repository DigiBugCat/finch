// POST /api/finch/acl {src,dst} -> hub POST /api/acl
import { adminProxy, errorResponse } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    return await adminProxy(req, "/api/acl", "POST");
  } catch (err) {
    return errorResponse(err);
  }
}
