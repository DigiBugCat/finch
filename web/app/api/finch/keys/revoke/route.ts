// POST /api/finch/keys/revoke -> revoke a minted finch_ key.
//
// Two shapes are accepted:
//   1. Tenant-level (the Keys view): { id, label? } — revoke a key by its stable
//      identity. `label` is display-only legacy metadata and is never trusted as
//      the revocation handle.
//   2. Box-scoped (the service detail view's per-box key chip):
//      { box, service, key } — detach a key from a specific box.
//
// Both map onto the hub's POST /api/boxes/:box/keys/revoke. Presence of the
// complete service+box scope means detach; its absence means global revoke.
import { errorResponse, hubFetchAs, HttpError, requireAdmin } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import {
  cleanString,
  rejectUnknownFields,
  relayHubJson,
} from "../route-contract";
import { requireBoxName, requireServiceId } from "../../services/_contract";

const MAX_REVOKE_REQUEST_BYTES = 4 * 1024;
const MAX_HANDLE_LENGTH = 128;

function validRevokeResponse(value: Record<string, unknown>): boolean {
  return value.ok === true;
}

export async function POST(req: Request) {
  try {
    const ctx = await requireAdmin();
    const body = await readJsonObject(req, MAX_REVOKE_REQUEST_BYTES);
    rejectUnknownFields(body, ["id", "label", "box", "service", "key"]);

    const hasId = body.id !== undefined;
    const hasBoxShape =
      body.box !== undefined || body.service !== undefined || body.key !== undefined;
    if (hasId && hasBoxShape) {
      throw new HttpError(400, "choose either id or box, service and key");
    }

    // Tenant-level revoke from the Keys view: identify the key by id, forward the
    // same stable id in the body. No box scope — the hub drops the whole record.
    let path: string;
    let payload: { service?: string; key: string };
    if (hasId) {
      const id = cleanString(body.id, "id", MAX_HANDLE_LENGTH);
      if (body.label !== undefined) cleanString(body.label, "label", 100);
      path = `/api/boxes/${encodeURIComponent(id)}/keys/revoke`;
      payload = { key: id };
    } else {
      // Box-scoped revoke from the service detail view.
      const box = requireBoxName(body.box);
      const service = requireServiceId(body.service);
      const key = cleanString(body.key, "key", MAX_HANDLE_LENGTH);
      path = `/api/boxes/${encodeURIComponent(box)}/keys/revoke`;
      payload = { service, key };
    }

    let res: Response;
    try {
      res = await hubFetchAs(ctx.tenant, path, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "hub unavailable");
    }
    return await relayHubJson(res, validRevokeResponse);
  } catch (err) {
    return errorResponse(err);
  }
}
