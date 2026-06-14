// PUT /api/finch/settings {key,val} -> hub PUT /api/settings
import { adminProxy, errorResponse } from "@/lib/hub";

export async function PUT(req: Request) {
  try {
    return await adminProxy(req, "/api/settings", "PUT");
  } catch (err) {
    return errorResponse(err);
  }
}
