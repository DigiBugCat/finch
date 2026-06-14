// PUT /api/finch/settings {key,val} -> hub PUT /api/settings
import { errorResponse, hubProxy } from "@/lib/hub";

export async function PUT(req: Request) {
  try {
    const body = await req.text();
    return await hubProxy("/api/settings", { method: "PUT", body });
  } catch (err) {
    return errorResponse(err);
  }
}
