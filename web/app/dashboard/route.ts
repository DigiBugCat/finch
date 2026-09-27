// GET /dashboard — TEMPORARY redirect for the removed web dashboard.
//
// The tray app in released agents opens /dashboard (and
// /dashboard?service=<id>), and people have it bookmarked. The dashboard is
// gone; its read-only successor is /fleet (sign-in first if needed), so send
// them there instead of a 404. A relative Location keeps the redirect on whatever origin served it.
// Delete this file once released agents without the tray are the norm.

export function GET(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "/fleet", "cache-control": "no-store" },
  });
}
