// GET /api/finch/slug-check?slug=foo -> hub GET /api/slug-available?slug=foo
// Claim-free availability check for the Hub-domain picker in Settings.
import { errorResponse, HttpError, hubFetchAs, requireAdmin } from "@/lib/hub";
import { forwardHubResponse } from "../_shared";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export async function GET(req: Request) {
  try {
    const ctx = await requireAdmin();
    const slug = (new URL(req.url).searchParams.get("slug") || "").trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw new HttpError(400, "invalid slug");
    // No body on a GET — undici rejects a GET RequestInit that carries one.
    const response = await hubFetchAs(
      ctx.tenant,
      `/api/slug-available?slug=${encodeURIComponent(slug)}`,
      { method: "GET" },
    );
    return forwardHubResponse(response);
  } catch (err) {
    return errorResponse(err);
  }
}
