// GET /api/finch/slug-check?slug=foo -> hub GET /api/slug-available?slug=foo
// Claim-free availability check for the Hub-domain picker in Settings.
import { requireAdmin, hubProxy, errorResponse } from "@/lib/hub";

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const slug = (new URL(req.url).searchParams.get("slug") || "").trim();
    // No body on a GET — undici rejects a GET RequestInit that carries one.
    return await hubProxy(
      `/api/slug-available?slug=${encodeURIComponent(slug)}`,
      { method: "GET" },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
