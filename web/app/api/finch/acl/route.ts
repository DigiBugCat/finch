// POST /api/finch/acl {src,dst} -> hub POST /api/acl
import { errorResponse, hubProxy, requireAdmin } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = await req.text();
    return await hubProxy("/api/acl", { method: "POST", body });
  } catch (err) {
    return errorResponse(err);
  }
}
