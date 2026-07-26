// lib/assertion.ts — the pure, dependency-free signer for the tenant assertion
// the web BFF presents to the hub control API (X-Finch-Auth).
//
// Extracted from hub.ts so it can be unit-tested in isolation against the
// worker's verifyAssertion (worker/src/auth.ts) — a CONTRACT test. If this wire
// format ever drifts from the hub's verifier, every hub call would silently 401;
// the contract test catches that at build time instead of in production.
//
// Wire format mirrors the hub's verifyAssertion EXACTLY:
//   base64url(JSON {tenant,exp}) "." base64url(HMAC-SHA256(body, secret))
// HMAC via Web Crypto only (crypto.subtle) — this runs in the workerd/edge
// runtime where there is no node:crypto.

/** TTL of a signed tenant assertion (seconds). Short — each hub call mints a
 *  fresh one; this only bounds clock-skew tolerance / replay window. */
export const ASSERTION_TTL_SECONDS = 120;

const TENANT_RE = /^[A-Za-z0-9_-]{1,128}$/;

const te = new TextEncoder();

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// CLI tokens are NOT minted here — the hub mints them (epoch-bound, kind:"cli")
// via /api/cli-mint, so they can be revoked without rotating the global secret.
// This module signs only the short-lived per-call assertion the BFF sends.

/** Sign a {tenant,exp} assertion with the shared service secret (HMAC-SHA256).
 *  `nowSeconds` is injectable for deterministic tests; defaults to wall clock. */
export async function signAssertion(
  tenant: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  kind?: "user",
): Promise<string> {
  // The hub treats this payload as an authorization identity, so refuse to
  // mint ambiguous or resource-amplifying assertions even when a caller passes
  // an upstream value without first going through the tenant-cookie validator.
  if (typeof tenant !== "string" || !TENANT_RE.test(tenant)) {
    throw new TypeError("invalid assertion tenant");
  }
  if (typeof secret !== "string" || !secret) {
    throw new TypeError("assertion secret is required");
  }
  if (
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 0 ||
    nowSeconds > Number.MAX_SAFE_INTEGER - ASSERTION_TTL_SECONDS
  ) {
    throw new TypeError("invalid assertion timestamp");
  }
  if (kind !== undefined && kind !== "user") {
    throw new TypeError("invalid assertion kind");
  }
  const payload = { tenant, exp: nowSeconds + ASSERTION_TTL_SECONDS, ...(kind ? { kind } : {}) };
  const body = bytesToB64url(te.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(body));
  return body + "." + bytesToB64url(new Uint8Array(sig));
}
