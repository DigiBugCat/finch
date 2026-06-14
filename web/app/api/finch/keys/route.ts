// POST /api/finch/keys {label,scope,owner} -> hub POST /api/keys
import { adminProxy, errorResponse } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    return await adminProxy(req, "/api/keys", "POST");
  } catch (err) {
    return errorResponse(err);
  }
}
