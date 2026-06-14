// POST /api/finch/keys {label,scope,owner} -> hub POST /api/keys
import { errorResponse, hubProxy } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    const body = await req.text();
    return await hubProxy("/api/keys", { method: "POST", body });
  } catch (err) {
    return errorResponse(err);
  }
}
