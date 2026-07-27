// POST /api/finch/services/:id/:action -> hub POST /api/services/:id/:action
// action ∈ { release, approve, decline }
import { errorResponse, hubFetchAs, HttpError, requireAdmin } from "@/lib/hub";
import { relayHubJson, requireServiceId } from "../../_contract";

const ACTIONS = new Set(["release", "approve", "decline"]);

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  try {
    const ctx = await requireAdmin();
    const { id: rawId, action } = await params;
    if (!ACTIONS.has(action)) {
      throw new HttpError(404, "unknown service action");
    }
    const id = requireServiceId(rawId);
    const response = await hubFetchAs(
      ctx.tenant,
      `/api/services/${encodeURIComponent(id)}/${action}`,
      { method: "POST" },
    );
    return await relayHubJson(response);
  } catch (err) {
    return errorResponse(err);
  }
}
