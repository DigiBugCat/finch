// GET /portal/start — TEMPORARY stub for the removed browser login wall.
//
// A hub that predates the CLI cut still redirects a browser without a
// finch_session on a key-protected service here (worker/src/index.ts
// maybeBrowserGate and the /__finch/cb re-bounce). The portal is gone, so
// answer with the plain 401 the cut hub gives directly, instead of a 404.
// Delete this file once the hub cut is deployed everywhere and no longer
// redirects to /portal/start.

const MESSAGE =
  "This service requires a finch_ key. Send it as `Authorization: Bearer finch_...`; " +
  "browser sign-in to Finch services has been removed.\n";

export function GET(): Response {
  return new Response(MESSAGE, {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
