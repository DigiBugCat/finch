// POST /api/finch/keys {label,scope,owner} -> hub POST /api/keys
import { errorResponse, hubProxy, requireAdmin } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = await req.text();
    return await hubProxy("/api/keys", { method: "POST", body });
  } catch (err) {
    return errorResponse(err);
  }
}
