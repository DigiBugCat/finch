// POST /api/finch/keys/revoke -> revoke a minted finch_ key.
//
// Two shapes are accepted:
//   1. Tenant-level (the Keys view): { id, label } — revoke a key by its stable
//      identity. `id` is the canonical handle the dashboard renders; `label` is
//      what today's hub revoke op matches on (it drops the Key record whose
//      label matches once no box still references it). We forward both so
//      the revoke is keyed by identity, not by a free-typed string.
//   2. Box-scoped (the service detail view's per-box key chip):
//      { box, service, key } — detach a key from a specific box.
//
// Both map onto the hub's POST /api/boxes/:box/keys/revoke {service,key}.
import { errorResponse, hubProxy, HttpError, requireAdmin } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const label = typeof body.label === "string" ? body.label : "";
    const box = typeof body.box === "string" ? body.box : "";
    const service = typeof body.service === "string" ? body.service : "";
    const key = typeof body.key === "string" ? body.key : "";

    // Tenant-level revoke from the Keys view: identify the key by id, forward the
    // label the hub matches on. No box scope — the hub drops the whole record.
    if (id) {
      if (!label) {
        throw new HttpError(400, "label required to revoke key");
      }
      return await hubProxy(`/api/boxes/${encodeURIComponent(id)}/keys/revoke`, {
        method: "POST",
        body: JSON.stringify({ service: "*", key: label }),
      });
    }

    // Box-scoped revoke from the service detail view.
    if (!box || !service || !key) {
      throw new HttpError(400, "box, service and key required");
    }
    return await hubProxy(
      `/api/boxes/${encodeURIComponent(box)}/keys/revoke`,
      { method: "POST", body: JSON.stringify({ service, key }) },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
