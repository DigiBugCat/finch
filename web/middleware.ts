import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

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
  "/aviary(.*)",
  "/portal(.*)",
]);

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

  if (isProtectedRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|txt|xml)).*)",
    "/(api|trpc)(.*)",
  ],
};
