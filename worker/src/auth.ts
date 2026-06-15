/// <reference types="@cloudflare/workers-types" />
//
// auth.ts — Finch hub crypto + token primitives. Web Crypto (crypto.subtle)
// ONLY; this runs in workerd, there is no node:crypto. Three concerns live here:
//
//   1. finch_ keys     — long-lived bearer creds for MCP/tool callers. We store
//                        only sha-256(plaintext); the plaintext is shown once at
//                        mint. last4 is kept for display.
//   2. join tickets    — short-lived, STATELESS, HMAC-signed grants handed to a
//                        box so it can POST /join. No storage: the signature +
//                        embedded exp are the whole proof.
//   3. service auth     — the web app proves itself to the control API with a
//                        shared secret header.
//
// Tickets and key-hashing both need a secret. Env lives in index.ts, so the
// secret is threaded in as an argument (signToken/verifyToken take it) rather
// than imported — keeps this module dependency-free and unit-testable.

// ---- base64url (no padding) ---------------------------------------------

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Constant-time compare of two byte arrays. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---- finch_ keys ---------------------------------------------------------

/** Generate a fresh bearer key: `finch_` + base64url(32 random bytes). */
export function genFinchKey(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return "finch_" + bytesToB64url(raw);
}

/** sha-256 of the plaintext key, hex-encoded. This is what we persist. */
export async function hashKey(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(plaintext));
  return bytesToHex(new Uint8Array(digest));
}

/** Last 4 chars of a key, for non-sensitive display (e.g. `…a1b2`). */
export function last4(plaintext: string): string {
  return plaintext.slice(-4);
}

// ---- HMAC join tickets (stateless) --------------------------------------

export interface TicketPayload {
  tenant: string;
  appliance: string;
  exp: number; // epoch SECONDS; verifyToken rejects once Date.now()/1000 > exp
  // `kind` distinguishes the HMAC grants that share this signer:
  //   - "join"    (or absent) — the short, single-use enroll ticket presented at
  //                 POST /join. Burned (jti) on first use.
  //   - "refresh" — the long-lived (~30d) per-machine credential handed back at
  //                 /join. The agent persists it in memory and presents it at
  //                 POST /refresh to mint fresh connect-tokens, so steady-state
  //                 reconnection never re-uses the one-shot join ticket.
  //   - "connect" — the short-lived (~120s) per-machine grant the agent presents
  //                 on the /_connect WS dial (?ct=…). Bound to a single machine.
  kind?: "join" | "connect" | "refresh";
  machine?: string; // present (and verified) for kind:"connect"|"refresh" tokens
  // Random one-time id. On a join ticket the hub records it (TenantDO used-set)
  // at first /join and rejects any replay until exp, so a captured ticket can't
  // be reused for its whole TTL. Connect tokens don't carry one (they're already
  // bound to a single machine + a ~120s window and are dialed repeatedly).
  jti?: string;
}

/** A fresh random 128-bit ticket id (hex), for jti replay-protection. */
export function genJti(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  return bytesToHex(raw);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// ---- HMAC envelope: base64url(JSON) "." base64url(HMAC-SHA256(body)) -----
// Shared by both signed grants (join/connect tickets and tenant assertions);
// they differ only in the payload shape, so each verify passes its own
// shape-validator. Constant-time signature compare; stateless.

/** Sign `payload` into the `body.sig` envelope with `secret`. */
async function signEnvelope(payload: unknown, secret: string): Promise<string> {
  const body = bytesToB64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return body + "." + bytesToB64url(new Uint8Array(sig));
}

/** Verify an envelope's HMAC + decode its JSON body, then hand it to `validate`.
 *  Returns the validated payload (with the post-validate exp check applied), or
 *  null on any malformed/forged/expired/shape-rejected input. */
async function verifyEnvelope<T extends { exp: number }>(
  token: string,
  secret: string,
  validate: (p: any) => T | null,
): Promise<T | null> {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);

  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlToBytes(token.slice(dot + 1));
  } catch {
    return null;
  }

  // crypto.subtle.verify is constant-time — no need to re-sign + manual compare.
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(body));
  if (!ok) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const payload = validate(parsed);
  if (!payload) return null;
  if (Date.now() / 1000 > payload.exp) return null; // expired
  return payload;
}

/**
 * Sign a stateless join/connect ticket:
 *   base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, secret))
 * The secret is TICKET_SECRET (passed by the caller from env).
 */
export function signToken(
  payload: TicketPayload,
  secret: string,
): Promise<string> {
  return signEnvelope(payload, secret);
}

/**
 * Verify and decode a ticket. Returns the payload, or null if it's malformed,
 * the HMAC doesn't match, the shape is wrong, or it has expired.
 */
export function verifyToken(
  ticket: string,
  secret: string,
): Promise<TicketPayload | null> {
  return verifyEnvelope<TicketPayload>(ticket, secret, (p) =>
    typeof p.tenant === "string" &&
    typeof p.appliance === "string" &&
    typeof p.exp === "number" &&
    (p.kind === undefined ||
      p.kind === "join" ||
      p.kind === "connect" ||
      p.kind === "refresh") &&
    (p.machine === undefined || typeof p.machine === "string") &&
    (p.jti === undefined || typeof p.jti === "string")
      ? (p as TicketPayload)
      : null,
  );
}

// ---- service-to-service auth --------------------------------------------

/**
 * Control-plane requests from the web app carry a shared secret. True iff the
 * X-Finch-Service header matches FINCH_SERVICE_SECRET. The secret is read off
 * `env` structurally so this module needn't import the Env interface.
 */
export function serviceOk(
  req: Request,
  env: { FINCH_SERVICE_SECRET: string },
): boolean {
  const got = req.headers.get("X-Finch-Service");
  if (!got || !env.FINCH_SERVICE_SECRET) return false;
  const a = enc.encode(got);
  const b = enc.encode(env.FINCH_SERVICE_SECRET);
  return timingSafeEqual(a, b);
}

// ---- signed tenant assertion (web → hub) --------------------------------
//
// The web app no longer just NAMES the tenant in a raw, unsigned X-Finch-Tenant
// header (which any holder of the shared service secret could forge for any
// tenant). Instead it SIGNS a short-lived assertion {tenant,exp} with the shared
// FINCH_SERVICE_SECRET; the hub verifies the HMAC + expiry and trusts THAT
// tenant. A leaked-but-not-signing secret holder can't replay it for arbitrary
// tenants, and the bound tenant is cryptographically tied to the request.
//
// Wire format mirrors the join ticket: base64url(JSON) "." base64url(HMAC). The
// payload is intentionally minimal ({tenant,exp}) — distinct from TicketPayload.

export interface TenantAssertion {
  tenant: string;
  exp: number; // epoch SECONDS
}

/** Sign a tenant assertion with the service secret. */
export function signAssertion(
  payload: TenantAssertion,
  secret: string,
): Promise<string> {
  return signEnvelope(payload, secret);
}

/**
 * Verify a tenant assertion. Returns the tenant id, or null if the assertion is
 * missing/malformed, the HMAC doesn't match, or it has expired.
 */
export async function verifyAssertion(
  token: string,
  secret: string,
): Promise<string | null> {
  const payload = await verifyEnvelope<TenantAssertion>(token, secret, (p) =>
    typeof p.tenant === "string" && p.tenant && typeof p.exp === "number"
      ? (p as TenantAssertion)
      : null,
  );
  return payload?.tenant ?? null;
}
