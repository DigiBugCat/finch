// GET /dashboard — TEMPORARY redirect for the removed web dashboard.
//
// The tray app in released agents opens /dashboard (and
// /dashboard?service=<id>), and people have it bookmarked. The dashboard is
// gone and Finch is driven from the CLI, so send them to the docs instead of a
// 404. A relative Location keeps the redirect on whatever origin served it.
// Delete this file once released agents without the tray are the norm.

export function GET(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "/docs", "cache-control": "no-store" },
  });
}
