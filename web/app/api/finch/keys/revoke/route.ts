// POST /api/finch/keys/revoke -> revoke a minted finch_ key.
//
// Two shapes are accepted:
//   1. Tenant-level (the Keys view): { id, label } — revoke a key by its stable
//      identity. `id` is the canonical handle the dashboard renders; `label` is
//      what today's hub revoke op matches on (it drops the Key record whose
//      label matches once no machine still references it). We forward both so
//      the revoke is keyed by identity, not by a free-typed string.
//   2. Machine-scoped (the appliance detail view's per-machine key chip):
//      { machine, appliance, key } — detach a key from a specific machine.
//
// Both map onto the hub's POST /api/machines/:machine/keys/revoke {appliance,key}.
import { errorResponse, hubProxy, HttpError, requireAdmin } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const label = typeof body.label === "string" ? body.label : "";
    const machine = typeof body.machine === "string" ? body.machine : "";
    const appliance = typeof body.appliance === "string" ? body.appliance : "";
    const key = typeof body.key === "string" ? body.key : "";

    // Tenant-level revoke from the Keys view: identify the key by id, forward the
    // label the hub matches on. No machine scope — the hub drops the whole record.
    if (id) {
      if (!label) {
        throw new HttpError(400, "label required to revoke key");
      }
      return await hubProxy(`/api/machines/${encodeURIComponent(id)}/keys/revoke`, {
        method: "POST",
        body: JSON.stringify({ appliance: "*", key: label }),
      });
    }

    // Machine-scoped revoke from the appliance detail view.
    if (!machine || !appliance || !key) {
      throw new HttpError(400, "machine, appliance and key required");
    }
    return await hubProxy(
      `/api/machines/${encodeURIComponent(machine)}/keys/revoke`,
      { method: "POST", body: JSON.stringify({ appliance, key }) },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
