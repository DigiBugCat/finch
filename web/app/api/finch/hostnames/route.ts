// /api/finch/hostnames -> hub /api/hostnames — custom-domain management for the
// Settings "Custom domains" card. Pure admin-gated proxy: GET lists, POST adds
// (hostname in the body), DELETE removes. Ownership + vanity-suffix gating and
// the Cloudflare-for-SaaS provisioning all live hub-side; we only forward.
import { requireAdmin, hubProxy, errorResponse } from "@/lib/hub";

export async function GET() {
  try {
    await requireAdmin();
    return await hubProxy("/api/hostnames", { method: "GET" });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = await req.text();
    return await hubProxy("/api/hostnames", { method: "POST", body });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request) {
  try {
    await requireAdmin();
    const body = await req.text();
    return await hubProxy("/api/hostnames", { method: "DELETE", body });
  } catch (err) {
    return errorResponse(err);
  }
}
