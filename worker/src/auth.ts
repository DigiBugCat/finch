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

/**
 * Sign a stateless join ticket:
 *   base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, secret))
 * The secret is TICKET_SECRET (passed by the caller from env).
 */
export async function signToken(
  payload: TicketPayload,
  secret: string,
): Promise<string> {
  const body = bytesToB64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return body + "." + bytesToB64url(new Uint8Array(sig));
}

/**
 * Verify and decode a ticket. Returns the payload, or null if:
 *   - it's malformed
 *   - the HMAC signature doesn't match (wrong/tampered)
 *   - it has expired (exp passed)
 * Constant-time signature comparison; no storage touched (stateless).
 */
export async function verifyToken(
  ticket: string,
  secret: string,
): Promise<TicketPayload | null> {
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot === ticket.length - 1) return null;
  const body = ticket.slice(0, dot);
  const sigPart = ticket.slice(dot + 1);

  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlToBytes(sigPart);
  } catch {
    return null;
  }

  const key = await hmacKey(secret);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(body)),
  );
  if (!timingSafeEqual(sigBytes, expected)) return null;

  let payload: TicketPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
  } catch {
    return null;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.tenant !== "string" ||
    typeof payload.appliance !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (Date.now() / 1000 > payload.exp) return null; // expired
  return payload;
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
