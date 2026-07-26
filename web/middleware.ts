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
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|txt|xml)).*)",
    "/(api|trpc)(.*)",
  ],
};
