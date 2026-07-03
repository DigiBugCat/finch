// POST /api/finch/services/:id/:action -> hub POST /api/services/:id/:action
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
      `/api/services/${encodeURIComponent(id)}/${action}`,
      { method: "POST" },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
