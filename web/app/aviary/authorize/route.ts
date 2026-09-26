// GET /aviary/authorize — TEMPORARY stub for the removed Aviary device
// enrollment approval page.
//
// A hub that predates the CLI cut still hands `finch aviary` clients a
// verification_uri pointing here (worker/src/aviary-enrollment-api.ts). The
// page is gone, so say so plainly instead of a 404. Delete this file once the
// hub cut is deployed everywhere and no longer issues these links.

const MESSAGE =
  "Aviary device enrollment has been removed from Finch. " +
  "Use `finch login` and `finch add` on the box instead.\n";

export function GET(): Response {
  return new Response(MESSAGE, {
    status: 410,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
