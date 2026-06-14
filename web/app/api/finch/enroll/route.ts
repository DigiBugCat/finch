// POST /api/finch/enroll {name,group} -> hub POST /api/enroll
import { errorResponse, hubProxy, requireAdmin } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = await req.text();
    return await hubProxy("/api/enroll", { method: "POST", body });
  } catch (err) {
    return errorResponse(err);
  }
}
