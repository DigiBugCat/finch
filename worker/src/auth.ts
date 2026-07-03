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
  // `appliance` is required for the agent-channel grants (join/connect/refresh)
  // but ABSENT on the browser login-wall grants (portal/session), which are
  // scoped to a slug-host, not a single appliance. Optional at the type level;
  // verifyToken still requires it for the agent kinds via its shape validator.
  appliance?: string;
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
  //   - "portal"  — the short-lived (~60s), SINGLE-USE (jti) hand-off the hub
  //                 mints (POST /api/portal-grant) for a Clerk-authed browser. The
  //                 browser carries it to GET /__finch/cb on the slug host, which
  //                 burns the jti and sets the long-lived session cookie. Scoped
  //                 to {tenant,slug,userId}, NOT an appliance.
  //   - "session" — the long-lived (~12h) browser login-wall cookie minted at
  //                 /__finch/cb. Signed with the SEPARATE SESSION_SECRET (see
  //                 signSession/verifySession) so a leaked session signer can't
  //                 forge join/connect/portal grants. Carries {tenant,slug,userId,
  //                 epoch}; browserGate checks epoch === the tenant's current
  //                 sessionEpoch so "sign everyone out" invalidates live cookies.
  kind?: "join" | "connect" | "refresh" | "portal" | "session";
  machine?: string; // present (and verified) for kind:"connect"|"refresh" tokens
  // The routing host key a portal/session grant is bound to. For legacy
  // <slug>.finchmcp.com hosts this is the bare slug; for custom hostnames it is
  // the full lowercase hostname. The field stays named `slug` for wire compat.
  // Present (and verified) ONLY for kind:"portal"|"session"; the agent kinds
  // bind an appliance instead. Ties the browser grant to a single host.
  slug?: string;
  // The Clerk user id the portal/session grant was minted for (login-wall audit /
  // identity). Present for kind:"portal"|"session".
  userId?: string;
  // The tenant's sessionEpoch at session-mint time (kind:"session" only). The hub
  // rejects the cookie once the tenant bumps that epoch ("sign everyone out"),
  // mirroring the cliTokenEpoch revocation path. (Distinct from a join jti.)
  epoch?: number;
  // Random one-time id. On a join ticket the hub records it (TenantDO used-set)
  // at first /join and rejects any replay until exp, so a captured ticket can't
  // be reused for its whole TTL. Also carried on a kind:"portal" grant: the slug
  // host's /__finch/cb burns it (claimTicket) so a captured portal grant can't be
  // replayed to mint a second session. Connect tokens don't carry one (they're
  // already bound to a single machine + a ~120s window and are dialed repeatedly).
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

/** Shared shape-validator for the HMAC ticket envelope. Used by BOTH verifyToken
 *  (TICKET_SECRET grants: join/connect/refresh/portal) and verifySession
 *  (SESSION_SECRET grants: session) — they ride the same envelope and payload
 *  shape, differing only in the SECRET they were signed with. The browser kinds
 *  (portal/session) carry {slug,userId} and NO appliance; the agent kinds carry
 *  an appliance and NO slug. We enforce kind ∈ the known set, require `appliance`
 *  for the agent kinds, and type-check the optional fields; the per-callsite
 *  predicate (e.g. _connect's kind==="connect" check) does the rest. */
function validateTicket(p: any): TicketPayload | null {
  if (typeof p.tenant !== "string" || typeof p.exp !== "number") return null;
  const kind = p.kind;
  const knownKind =
    kind === undefined ||
    kind === "join" ||
    kind === "connect" ||
    kind === "refresh" ||
    kind === "portal" ||
    kind === "session";
  if (!knownKind) return null;
  // The agent-channel grants (join/connect/refresh, and the legacy undefined
  // kind) are appliance-scoped — `appliance` MUST be a string. The browser grants
  // (portal/session) are slug-scoped and carry no appliance.
  const isBrowserKind = kind === "portal" || kind === "session";
  if (!isBrowserKind && typeof p.appliance !== "string") return null;
  if (p.appliance !== undefined && typeof p.appliance !== "string") return null;
  if (p.machine !== undefined && typeof p.machine !== "string") return null;
  if (p.slug !== undefined && typeof p.slug !== "string") return null;
  if (p.userId !== undefined && typeof p.userId !== "string") return null;
  if (p.epoch !== undefined && typeof p.epoch !== "number") return null;
  if (p.jti !== undefined && typeof p.jti !== "string") return null;
  return p as TicketPayload;
}

/**
 * Verify and decode a ticket. Returns the payload, or null if it's malformed,
 * the HMAC doesn't match, the shape is wrong, or it has expired.
 */
export function verifyToken(
  ticket: string,
  secret: string,
): Promise<TicketPayload | null> {
  return verifyEnvelope<TicketPayload>(ticket, secret, validateTicket);
}

// ---- browser login-wall session (SESSION_SECRET) -------------------------
//
// The session cookie minted at /__finch/cb is the long-lived (~12h) proof a
// browser already cleared the Clerk login wall. It rides the SAME HMAC envelope
// as the ticket grants but is signed with a SEPARATE secret (env.SESSION_SECRET)
// so a leaked session signer can NOT be turned into a forged join/connect/portal
// grant (those are signed with TICKET_SECRET) and vice-versa. The payload is a
// kind:"session" TicketPayload carrying {tenant,slug,userId,epoch}.

/** Sign a kind:"session" login-wall cookie with the SESSION_SECRET. */
export function signSession(
  payload: TicketPayload,
  secret: string,
): Promise<string> {
  return signEnvelope(payload, secret);
}

/** Verify + decode a login-wall session cookie (SESSION_SECRET). Returns the
 *  payload, or null if it's malformed/forged/expired/wrong-shape. The caller
 *  (browserGate) still asserts kind==="session" + tenant/slug/epoch match. */
export function verifySession(
  token: string,
  secret: string,
): Promise<TicketPayload | null> {
  return verifyEnvelope<TicketPayload>(token, secret, validateTicket);
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
  // `kind` is the audience: a short-lived per-call web→hub assertion ("assertion",
  // the default for back-compat) vs a long-lived CLI token ("cli"). A CLI token
  // must NOT be accepted where a per-call assertion is expected, and vice-versa.
  kind?: string;
  // `epoch` (CLI tokens only): the tenant's cliTokenEpoch at mint time. The hub
  // rejects the token once the tenant bumps that epoch ("revoke all CLI tokens"),
  // giving a revocation path that doesn't require rotating the global secret.
  epoch?: number;
}

/** Sign a tenant assertion with the service secret. Per-call assertions pass
 *  `{tenant,exp}` (kind defaults to "assertion" on verify); CLI tokens pass
 *  `{tenant,exp,kind:"cli",epoch}`. */
export function signAssertion(
  payload: TenantAssertion,
  secret: string,
): Promise<string> {
  return signEnvelope(payload, secret);
}

/** Verify + decode a tenant assertion's full payload (kind defaulted to
 *  "assertion"), or null if missing/forged/expired/malformed. */
export async function verifyAssertionPayload(
  token: string,
  secret: string,
): Promise<TenantAssertion | null> {
  return verifyEnvelope<TenantAssertion>(token, secret, (p) =>
    typeof p.tenant === "string" && p.tenant && typeof p.exp === "number"
      ? {
          tenant: p.tenant,
          exp: p.exp,
          kind: typeof p.kind === "string" ? p.kind : "assertion",
          ...(typeof p.epoch === "number" ? { epoch: p.epoch } : {}),
        }
      : null,
  );
}

/**
 * Verify a tenant assertion of the expected `kind` (default "assertion").
 * Returns the tenant id, or null if missing/forged/expired or the kind mismatches
 * — so a long-lived CLI token can't stand in for a per-call assertion.
 */
export async function verifyAssertion(
  token: string,
  secret: string,
  expectedKind = "assertion",
): Promise<string | null> {
  const p = await verifyAssertionPayload(token, secret);
  if (!p || p.kind !== expectedKind) return null;
  return p.tenant;
}
