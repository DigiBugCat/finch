import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isSecurePublicRequest } from "@/lib/secure-transport";

// Only the dashboard (and future app routes) require auth. The marketing
// landing, sign-in, and sign-up are public — don't gate the front door.
//
// /portal(.*) is the appliance login-wall bounce: an unauthenticated browser
// hitting a gated <slug>.finchmcp.com appliance is 302'd by the worker to
// /portal/start. Protecting it here means Clerk forces sign-in BEFORE the
// route handler runs, so resolveTenant() always sees a real session and we
// can mint a portal grant bound to the signed-in user.
const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/cli(.*)",
  "/portal(.*)",
]);

// Device enrollment links are opened directly from the Finch CLI. Clerk's
// default protection response is an intentionally opaque 404, which makes a
// valid approval link look broken when the browser has no session. Send the
// user through sign-in explicitly and preserve the complete approval URL.
const isAviaryRoute = createRouteMatcher(["/aviary(.*)"]);

// All cookie-authed bridge handlers live under /api/finch/*.
const isFinchApiRoute = createRouteMatcher(["/api/finch(.*)"]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Defense-in-depth CSRF guard for the cookie-authed bridge. Clerk's session
 *  cookie is SameSite=Lax, which already blocks cross-site mutations, but we
 *  don't want every current/future /api/finch/* handler to depend on that.
 *  Reject any non-safe /api/finch/* request that isn't provably same-origin:
 *  prefer Sec-Fetch-Site (browser-set, unforgeable from JS), fall back to an
 *  Origin allowlist for clients that don't send it. Fail closed when neither
 *  signal proves same-origin. */
function isSameOrigin(request: Request): boolean {
  // Sec-Fetch-Site is set by the browser and can't be spoofed by page JS.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";

  // Fallback: Origin must match this request's own origin.
  const origin = request.headers.get("origin");
  if (!origin) return false; // no proof of same-origin → reject
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/**
 * Pin the origins whose session tokens this middleware will accept.
 *
 * A Clerk session JWT carries an `azp` claim naming the origin the token was
 * minted for. @clerk/backend only checks it when `authorizedParties` is set —
 * assertAuthorizedPartiesClaim() returns immediately on an empty list — so with
 * no options object every token signed by our instance is accepted regardless of
 * where it was created. That is not a theoretical gap here: every tenant gets
 * <slug>.finchmcp.com and a service with auth "public" serves arbitrary tenant
 * HTML there, so an attacker-controlled origin exists inside the same
 * registrable domain and shares our Clerk cookies. A token minted on that
 * subdomain, exfiltrated, and replayed server-side with `Sec-Fetch-Site:
 * same-origin` (which satisfies isSameOrigin above, by design — see the CSRF
 * note) would mint a ~30-day tenant-admin credential at POST
 * /api/finch/cli-token for the victim's workspace. Checking `azp` is what stops
 * that: the attacker's token names <slug>.finchmcp.com, not the app origin.
 *
 * Environment resolution mirrors allowedRedirectOrigins() in app/layout.tsx:59 —
 * the deployed origin is configuration, so NEXT_PUBLIC_APP_ORIGIN (a wrangler
 * `var`, per env) wins when set. The pk_live_ branch is the fail-closed backstop
 * so a missing/typo'd var can never silently disable the check in production;
 * scripts/deploy-preflight.mjs additionally refuses to ship prod without a real,
 * non-wildcard value. Returning undefined elsewhere keeps Clerk's default (no
 * azp assertion), which is what local dev and the workers.dev previews need:
 * their origins are not fixed here, and a pk_test instance's tenant hosts are
 * not siblings of its accounts.dev frontend API, so the attack above has no
 * same-site foothold there.
 */
function authorizedParties(): string[] | undefined {
  const configured = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim();
  if (configured) return [configured];
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
  return key.startsWith("pk_live_") ? ["https://finchmcp.com"] : undefined;
}

export default clerkMiddleware(async (auth, request) => {
  // Reject an insecure request before Clerk authentication or any route handler
  // can read a credential/body. Do not redirect mutations: the caller must fix
  // its URL rather than transmit sensitive data once over plaintext and retry.
  if (!isSecurePublicRequest(request.url)) {
    return NextResponse.json(
      { error: "HTTPS is required" },
      {
        status: 426,
        headers: { "cache-control": "no-store" },
      },
    );
  }

  if (
    isFinchApiRoute(request) &&
    !SAFE_METHODS.has(request.method) &&
    !isSameOrigin(request)
  ) {
    return NextResponse.json(
      { error: "cross-origin request rejected" },
      { status: 403 },
    );
  }

  if (isAviaryRoute(request)) {
    const { userId } = await auth();
    if (!userId) {
      const signInUrl = new URL("/sign-in", request.url);
      signInUrl.searchParams.set("redirect_url", request.url);
      return NextResponse.redirect(signInUrl);
    }
  } else if (isProtectedRoute(request)) {
    await auth.protect();
  }
},
// Options callback (not a literal object): under OpenNext the Cloudflare env is
// bound per request, so reading process.env at module-evaluation time can see an
// empty env and silently produce an unpinned middleware.
() => ({ authorizedParties: authorizedParties() }));

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|txt|xml)).*)",
    "/(api|trpc)(.*)",
  ],
};
