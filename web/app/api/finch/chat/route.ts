// POST /api/finch/chat {service, messages} — the dashboard's "test in chat"
// panel. Admin-only; relays to the hub's /chat/completions using the web's
// service auth (no finch_ key), so chatting never mints keys.
import { requireAdmin, hubFetch, errorResponse } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const res = await hubFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ service: body.service, messages: body.messages }),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
