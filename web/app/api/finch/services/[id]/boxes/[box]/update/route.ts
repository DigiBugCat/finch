// POST /api/finch/services/:id/boxes/:box/update -> hub POST /api/box-update
// Pushes an out-of-band "update" frame to the box's live relay socket: the
// agent self-updates from the hub's /releases and re-execs in place. The hub
// answers 503 X-Finch-Offline when the box has no live socket (dashboard falls
// back to the copy-paste `finch update` hint).
import { errorResponse, hubFetchAs, requireAdmin } from "@/lib/hub";
import { relayHubJson, requireBoxName, requireServiceId } from "../../../../_contract";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; box: string }> },
) {
  try {
    const ctx = await requireAdmin();
    const { id: rawId, box: rawBox } = await params;
    const id = requireServiceId(rawId);
    const box = requireBoxName(rawBox);
    const response = await hubFetchAs(ctx.tenant, "/api/box-update", {
      method: "POST",
      body: JSON.stringify({ service: id, box }),
      headers: { "content-type": "application/json" },
    });
    return await relayHubJson(response);
  } catch (err) {
    return errorResponse(err);
  }
}
