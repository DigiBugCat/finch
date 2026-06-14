// POST /api/finch/keys/revoke {machine,appliance,key}
//   -> hub POST /api/machines/:machine/keys/revoke {appliance,key}
import { errorResponse, hubProxy, HttpError } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { machine, appliance, key } = body ?? {};
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
