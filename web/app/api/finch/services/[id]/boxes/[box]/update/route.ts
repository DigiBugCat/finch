// POST /api/finch/services/:id/boxes/:box/update -> hub POST /api/box-update
// Pushes an out-of-band "update" frame to the box's live relay socket: the
// agent self-updates from the hub's /releases and re-execs in place. The hub
// answers 503 X-Finch-Offline when the box has no live socket (dashboard falls
// back to the copy-paste `finch update` hint).
import { errorResponse, hubProxy, requireAdmin } from "@/lib/hub";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; box: string }> },
) {
  try {
    await requireAdmin();
    const { id, box } = await params;
    return await hubProxy("/api/box-update", {
      method: "POST",
      body: JSON.stringify({ service: id, box }),
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
