// POST /api/finch/enroll {name,group} -> hub POST /api/enroll
import { adminProxy, errorResponse } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    return await adminProxy(req, "/api/enroll", "POST");
  } catch (err) {
    return errorResponse(err);
  }
}
