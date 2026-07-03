// POST /api/finch/appliances/:id/:action -> hub POST /api/appliances/:id/:action
// action ∈ { release, approve, decline }
import { errorResponse, hubProxy, HttpError, requireAdmin } from "@/lib/hub";

const ACTIONS = new Set(["release", "approve", "decline"]);

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  try {
    await requireAdmin();
    const { id, action } = await params;
    if (!ACTIONS.has(action)) {
      throw new HttpError(404, `unknown service action: ${action}`);
    }
    return await hubProxy(
      `/api/appliances/${encodeURIComponent(id)}/${action}`,
      { method: "POST" },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
