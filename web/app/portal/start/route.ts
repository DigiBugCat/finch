// GET /portal/start?slug=<host-key>&rd=<relpath>
//
// The appliance login-wall BOUNCE handler. When an unauthenticated browser
// hits a gated <slug>.finchmcp.com appliance, the worker's browserGate 302's
// it here (see worker/src/index.ts). This route is /portal-protected by
// middleware.ts, so Clerk has already forced sign-in by the time we run — the
// session is guaranteed real.
//
// Flow:
//   1. resolveTenant() — the signed-in Clerk user + their hub tenant. This is
//      the SECURITY-CRITICAL identity; everything below is bound to it.
//   2. Read + harden the inputs:
//        - slug is the worker host key: either a single DNS label for
//          <slug>.finchmcp.com or a validated full hostname for custom domains.
//        - rd MUST be a site-relative path (leading "/", no scheme/host/"//")
//          so the eventual landing redirect can't be an open redirect.
//   3. POST /api/portal-grant {slug,userId} to the hub via hubFetch. The hub
//      verifies WE own the slug (routerLookup(slug) === tenant-from-assertion)
//      and 403s otherwise — ownership is enforced hub-side off the SIGNED
//      assertion, never off the slug we pass. userId rides the body because the
//      assertion only binds the tenant.
//   4. On success, 302 the browser to the appliance's reserved callback:
//        https://<host>/__finch/cb?g=<grant>&rd=<rd>
//      where the worker burns the single-use grant and sets the finch_session
//      cookie host-scoped to that slug.
//
// We never set a cookie here and never trust client-supplied identity — the
// only authority is the Clerk session + the hub's ownership check.

import { resolveTenant, hubFetch, HttpError } from "@/lib/hub";

/** The appliance base domain that vanity slugs live under: <slug>.finchmcp.com.
 *  Configurable so staging can point elsewhere; defaults to the prod apex. The
 *  worker is the source of truth for host→key (hostKeyFromHost in index.ts); this
 *  only has to AGREE with it for the host we 302 to. */
async function applianceDomain(): Promise<string> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = getCloudflareContext().env as Record<string, unknown>;
    const v = env?.APPLIANCE_DOMAIN;
    if (typeof v === "string" && v.length) return v;
  } catch {
    // not under the Cloudflare adapter (`next dev`) — fall through
  }
  const pv = process.env.APPLIANCE_DOMAIN;
  return typeof pv === "string" && pv.length ? pv : "finchmcp.com";
}

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A portal host key is either a legacy single-label slug or a full hostname.
 *  This remains the open-redirect guard: full hostnames are safe to redirect to
 *  only because /api/portal-grant verifies routerLookup(key) === this tenant
 *  before issuing a grant. */
function isValidHostKey(key: string): boolean {
  if (!key || key !== key.toLowerCase()) return false;
  if (!key.includes(".")) return DNS_LABEL_RE.test(key);
  if (key.length > 253) return false;
  const labels = key.split(".");
  return labels.length >= 2 && labels.every((label) => DNS_LABEL_RE.test(label));
}

/** Validate that `rd` is a SITE-RELATIVE path we can safely hand back to the
 *  appliance: it must start with a single "/" and must NOT start with "//" or
 *  "/\" (protocol-relative URLs that browsers treat as cross-host), and must
 *  not contain a scheme. Anything else collapses to "/". Open-redirect guard. */
function safeRelPath(rd: string | null): string {
  if (!rd) return "/";
  // Must be path-absolute, single leading slash. "//host" and "/\\host" are
  // protocol-relative and would navigate off-host — reject.
  if (!rd.startsWith("/") || rd.startsWith("//") || rd.startsWith("/\\")) {
    return "/";
  }
  // Defense in depth: a leading scheme (e.g. "/%2F.." tricks aside) — reject any
  // backslash anywhere (browsers normalize "\" → "/") and any control chars.
  if (/[\\\x00-\x1f]/.test(rd)) return "/";
  return rd;
}

export async function GET(req: Request) {
  // resolveTenant throws HttpError(401) if somehow unauthenticated despite the
  // middleware gate — fail closed to the sign-in flow rather than 500.
  let userId: string;
  try {
    ({ userId } = await resolveTenant());
  } catch {
    // Bounce to sign-in; Clerk middleware will catch the protected /portal path.
    return Response.redirect(new URL("/sign-in", req.url), 302);
  }

  const url = new URL(req.url);
  const hostKey = (url.searchParams.get("slug") || "").trim().toLowerCase();
  const rd = safeRelPath(url.searchParams.get("rd"));

  // Host-key guard FIRST — without a valid key we can neither ask the hub about
  // ownership nor build a safe redirect host.
  if (!isValidHostKey(hostKey)) {
    return new Response("invalid service host", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Ask the hub to mint a single-use portal grant. The hub re-derives the
  // tenant from our SIGNED assertion (hubFetch attaches it) and refuses (403)
  // unless that tenant owns `slug`. We pass userId in the body so the grant —
  // and thus the eventual session cookie — is stamped with the signed-in user.
  let res: Response;
  try {
    res = await hubFetch("/api/portal-grant", {
      method: "POST",
      body: JSON.stringify({ slug: hostKey, userId }),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return new Response(`portal grant failed: ${err.message}`, {
        status: err.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("portal grant failed", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // 403 = this tenant does not own this appliance. Surface a clean message
  // rather than bouncing into a host we have no claim to.
  if (res.status === 403) {
    return new Response(
      "This service isn't registered to your account. " +
        "Sign in with the account that owns it, or check the link.",
      { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  if (!res.ok) {
    return new Response("Could not start the service session. Try again.", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Read the grant out of the 200 body. An empty/non-JSON body throws in
  // res.json() — treat that the same as a missing grant (a malformed success)
  // and return the clean 502 rather than letting the throw surface as an opaque
  // 500.
  let grant: string | undefined;
  try {
    const data = (await res.json()) as { grant?: string };
    grant = data?.grant;
  } catch {
    grant = undefined;
  }
  if (!grant) {
    return new Response("Could not start the service session. Try again.", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Hand the grant to the appliance's reserved callback. The worker there burns
  // the single-use jti and sets the host-scoped finch_session cookie, then 302s
  // to `rd`.
  const domain = await applianceDomain();
  const cbHost = hostKey.includes(".") ? hostKey : `${hostKey}.${domain}`;
  const cb =
    `https://${cbHost}/__finch/cb` +
    `?g=${encodeURIComponent(grant)}&rd=${encodeURIComponent(rd)}`;

  return Response.redirect(cb, 302);
}
