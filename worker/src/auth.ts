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
  // Compact tokens use canonical, unpadded base64url. Rejecting the standard
  // alphabet, padding, impossible lengths, and non-canonical trailing bits
  // prevents multiple wire strings from representing the same signed bytes.
  if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) {
    throw new Error("invalid base64url");
  }
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (bytesToB64url(out) !== s) throw new Error("non-canonical base64url");
  return out;
}

const enc = new TextEncoder();
const MAX_COMPACT_TOKEN_CHARS = 16 * 1024;

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
  // Every ticket grant is service-scoped; verifyToken rejects one without it.
  service: string;
  exp: number; // epoch SECONDS; verifyToken rejects once Date.now()/1000 > exp
  // `kind` distinguishes the HMAC grants that share this signer:
  //   - "join"    (or absent) — the short, single-use enroll ticket presented at
  //                 POST /join. Burned (jti) on first use.
  //   - "refresh" — the long-lived (~30d) per-box credential handed back at
  //                 /join. The agent persists it in memory and presents it at
  //                 POST /refresh to mint fresh connect-tokens, so steady-state
  //                 reconnection never re-uses the one-shot join ticket.
  //   - "connect" — the short-lived (~120s) per-box grant the agent presents
  //                 on the /_connect WS dial (?ct=…). Bound to a single box.
  // (The browser login wall's "portal"/"session" kinds were removed; a token
  // carrying either kind no longer verifies.)
  kind?: "join" | "connect" | "refresh";
  box?: string; // present (and verified) for kind:"connect"|"refresh" tokens
  // Random one-time id. On a join ticket the hub records it (TenantDO used-set)
  // at first /join and rejects any replay until exp, so a captured ticket can't
  // be reused for its whole TTL. Connect tokens don't carry one (they're
  // already bound to a single box + a ~120s window and are dialed repeatedly).
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
  if (
    typeof token !== "string" ||
    !token ||
    token.length > MAX_COMPACT_TOKEN_CHARS ||
    !secret
  ) return null;
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
  if (!Number.isFinite(payload.exp) || Date.now() / 1000 >= payload.exp) return null;
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

/** Shape-validator for the HMAC ticket envelope (TICKET_SECRET grants:
 *  join/connect/refresh). We enforce kind ∈ the known set, require `service`,
 *  and type-check the optional fields; the per-callsite predicate (e.g.
 *  _connect's kind==="connect" check) does the rest. */
function validateTicket(p: any): TicketPayload | null {
  if (
    typeof p.tenant !== "string" ||
    !p.tenant ||
    typeof p.exp !== "number" ||
    !Number.isFinite(p.exp)
  ) return null;
  const kind = p.kind;
  const knownKind =
    kind === undefined ||
    kind === "join" ||
    kind === "connect" ||
    kind === "refresh";
  if (!knownKind) return null;
  if (typeof p.service !== "string" || !p.service) return null;
  if (p.box !== undefined && typeof p.box !== "string") return null;
  // Only the retired Aviary device flow issued grants carrying a per-box
  // credential `epoch`. The single-user purge deleted the stored epochs they
  // were checked against, so no such grant verifies any more; a box enrolled
  // that way re-joins with `finch add`.
  if (p.epoch !== undefined) return null;
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
    typeof p.tenant === "string" && p.tenant &&
      typeof p.exp === "number" && Number.isFinite(p.exp) &&
      (p.kind === undefined || typeof p.kind === "string") &&
      (p.epoch === undefined ||
        (typeof p.epoch === "number" && Number.isFinite(p.epoch)))
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

// ---- signed caller assertions (Finch edge -> hosted service) ------------
//
// Once a relay caller has authenticated, the Worker replaces all caller-
// supplied identity headers with a short-lived ES256 compact JWS. Hosted
// services verify the signature with the public JWKS and then enforce the
// tenant/service audience plus the bound HTTP method and public path.
//
// The signing set is a private JWKS stored as a Worker secret. Keeping more
// than one key in the set lets operators publish a replacement public key
// before making it active and retain the old public key until all assertions
// signed with it have expired. The active key is selected by an ordinary,
// non-secret kid variable; private key material is never returned by jwks().

export type CallerAuthMethod =
  | "finch_key"
  | "oauth"
  | "service";

/** Claims injected into X-Finch-Assertion after successful edge auth. */
export interface CallerAssertionClaims {
  iss: string;
  sub: string;
  aud: string;
  tenant: string;
  service: string;
  auth_method: CallerAuthMethod;
  method: string;
  /** Exact path + query delivered to the hosted application. */
  upstream_path: string;
  /** Normalized path presented at the Finch edge, retained for audit/binding. */
  public_path: string;
  /** base64url(SHA-256(raw request body)); digest of empty bytes when absent. */
  body_sha256: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  actor?: string;
  key_id?: string;
  key_label?: string;
}

export interface CallerAssertionConfig {
  /** kid of the private key used for new assertions. */
  activeKid?: string;
  /** JSON-encoded private JWKS: {"keys":[{EC P-256 private JWK}, ...]}. */
  privateJwks?: string;
}

export type CallerAssertionJwk = JsonWebKey & {
  kid: string;
  alg?: string;
  use?: string;
};

interface ParsedAssertionKeySet {
  keys: CallerAssertionJwk[];
  byKid: Map<string, CallerAssertionJwk>;
}

let parsedAssertionKeySetCache:
  | { raw: string; set: ParsedAssertionKeySet }
  | undefined;
let assertionSigningKeyCache:
  | { raw: string; kid: string; key: CryptoKey }
  | undefined;
let assertionSelfTestCache:
  | { raw: string; kid: string; issuer: string }
  | undefined;

/** True when assertion signing was requested. Partial config is intentionally
 *  considered enabled so a bad rollout fails closed rather than silently
 *  forwarding a request without an identity assertion. */
export function callerAssertionsConfigured(
  config: CallerAssertionConfig,
): boolean {
  return !!(config.activeKid || config.privateJwks);
}

function parseAssertionKeySet(raw: string): ParsedAssertionKeySet {
  if (parsedAssertionKeySetCache?.raw === raw) {
    return parsedAssertionKeySetCache.set;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FINCH_ASSERTION_PRIVATE_JWKS is not valid JSON");
  }
  const keys = (parsed as any)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("FINCH_ASSERTION_PRIVATE_JWKS must contain a non-empty keys array");
  }
  const byKid = new Map<string, CallerAssertionJwk>();
  for (const candidate of keys) {
    if (
      !candidate ||
      candidate.kty !== "EC" ||
      candidate.crv !== "P-256" ||
      typeof candidate.x !== "string" ||
      typeof candidate.y !== "string" ||
      typeof candidate.kid !== "string" ||
      !candidate.kid
    ) {
      throw new Error("assertion JWKS keys must be named EC P-256 JWKs");
    }
    if (candidate.alg !== undefined && candidate.alg !== "ES256") {
      throw new Error(`assertion key ${candidate.kid} must use alg ES256`);
    }
    if (byKid.has(candidate.kid)) {
      throw new Error(`duplicate assertion key id: ${candidate.kid}`);
    }
    byKid.set(candidate.kid, candidate as CallerAssertionJwk);
  }
  const set = { keys: keys as CallerAssertionJwk[], byKid };
  parsedAssertionKeySetCache = { raw, set };
  return set;
}

function publicAssertionJwk(key: CallerAssertionJwk): CallerAssertionJwk {
  return {
    kty: "EC",
    crv: "P-256",
    x: key.x,
    y: key.y,
    kid: key.kid,
    alg: "ES256",
    use: "sig",
  };
}

/** Public rotation set for /.well-known/finch-jwks.json. */
export function callerAssertionJwks(config: CallerAssertionConfig): {
  keys: CallerAssertionJwk[];
} {
  if (!config.privateJwks) {
    throw new Error("FINCH_ASSERTION_PRIVATE_JWKS is required");
  }
  const set = parseAssertionKeySet(config.privateJwks);
  return { keys: set.keys.map(publicAssertionJwk) };
}

/** Sign one compact JWS using the configured active ES256 key. */
export async function signCallerAssertion(
  claims: CallerAssertionClaims,
  config: CallerAssertionConfig,
): Promise<string> {
  if (!config.activeKid || !config.privateJwks) {
    throw new Error(
      "FINCH_ASSERTION_ACTIVE_KID and FINCH_ASSERTION_PRIVATE_JWKS are both required",
    );
  }
  const set = parseAssertionKeySet(config.privateJwks);
  const jwk = set.byKid.get(config.activeKid);
  if (!jwk) {
    throw new Error(`active assertion key not found: ${config.activeKid}`);
  }
  if (typeof jwk.d !== "string" || !jwk.d) {
    throw new Error(`active assertion key ${config.activeKid} has no private component`);
  }
  const header = bytesToB64url(
    enc.encode(
      JSON.stringify({ alg: "ES256", kid: config.activeKid, typ: "JWT" }),
    ),
  );
  const payload = bytesToB64url(enc.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  let key: CryptoKey;
  if (
    assertionSigningKeyCache?.raw === config.privateJwks &&
    assertionSigningKeyCache.kid === config.activeKid
  ) {
    key = assertionSigningKeyCache.key;
  } else {
    key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    assertionSigningKeyCache = {
      raw: config.privateJwks,
      kid: config.activeKid,
      key,
    };
  }
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    enc.encode(signingInput),
  );
  return `${signingInput}.${bytesToB64url(new Uint8Array(signature))}`;
}

/** Prove the configured active private key can sign a token that verifies
 *  against the exact public JWKS we emit. The successful result is cached per
 *  isolate/config so the public JWKS endpoint is not an ECDSA signing oracle or
 *  a CPU-amplification surface. No token or private material leaves this
 *  function. */
export async function selfTestCallerAssertion(
  config: CallerAssertionConfig,
  issuer: string,
): Promise<string> {
  if (!config.activeKid || !config.privateJwks || !issuer) {
    throw new Error(
      "FINCH_ASSERTION_ACTIVE_KID, FINCH_ASSERTION_PRIVATE_JWKS, and " +
        "FINCH_ASSERTION_ISSUER are required",
    );
  }
  if (
    assertionSelfTestCache?.raw === config.privateJwks &&
    assertionSelfTestCache.kid === config.activeKid &&
    assertionSelfTestCache.issuer === issuer
  ) {
    return config.activeKid;
  }

  const now = Math.floor(Date.now() / 1000);
  const tenant = "finch-assertion-self-test";
  const service = "finch-assertion-self-test";
  const claims: CallerAssertionClaims = {
    iss: issuer,
    sub: "service:finch-assertion-self-test",
    aud: `finch:${tenant}:${service}`,
    tenant,
    service,
    auth_method: "service",
    method: "GET",
    upstream_path: "/.well-known/finch-jwks.json",
    public_path: "/.well-known/finch-jwks.json",
    body_sha256: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    iat: now,
    nbf: now - 5,
    exp: now + 60,
    jti: crypto.randomUUID(),
  };
  const token = await signCallerAssertion(claims, config);
  const publicJwks = callerAssertionJwks(config);
  const verified = await verifyCallerAssertion(token, publicJwks, {
    now,
    issuer,
    audience: claims.aud,
    tenant,
    service,
    method: claims.method,
    upstreamPath: claims.upstream_path,
    publicPath: claims.public_path,
    bodySha256: claims.body_sha256,
  });
  if (!verified || verified.jti !== claims.jti) {
    throw new Error("active assertion key failed its sign/verify self-test");
  }
  assertionSelfTestCache = {
    raw: config.privateJwks,
    kid: config.activeKid,
    issuer,
  };
  return config.activeKid;
}

export interface CallerAssertionExpectations {
  issuer?: string;
  audience?: string;
  tenant?: string;
  service?: string;
  method?: string;
  upstreamPath?: string;
  publicPath?: string;
  bodySha256?: string;
  now?: number;
}

/** Verification helper used by contract tests and non-Python consumers. Hosted
 *  applications should fetch the public JWKS and apply the same checks. */
export async function verifyCallerAssertion(
  token: string,
  jwks: { keys: CallerAssertionJwk[] },
  expected: CallerAssertionExpectations = {},
): Promise<CallerAssertionClaims | null> {
  if (
    typeof token !== "string" ||
    token.length > MAX_COMPACT_TOKEN_CHARS ||
    !jwks ||
    !Array.isArray(jwks.keys)
  ) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: any;
  let claims: any;
  let signature: Uint8Array;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    signature = b64urlToBytes(parts[2]);
  } catch {
    return null;
  }
  if (
    header?.alg !== "ES256" ||
    typeof header?.kid !== "string" ||
    header.typ !== "JWT"
  ) {
    return null;
  }
  const jwk = jwks.keys.find(
    (k) => k.kid === header.kid && k.kty === "EC" && k.crv === "P-256",
  );
  if (!jwk) return null;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature,
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return null;

  const strings = [
    "iss",
    "sub",
    "aud",
    "tenant",
    "service",
    "auth_method",
    "method",
    "upstream_path",
    "public_path",
    "body_sha256",
    "jti",
  ];
  if (strings.some((name) => typeof claims?.[name] !== "string" || !claims[name])) {
    return null;
  }
  if (
    typeof claims.iat !== "number" || !Number.isFinite(claims.iat) ||
    typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) ||
    typeof claims.exp !== "number" || !Number.isFinite(claims.exp)
  ) {
    return null;
  }
  const now = expected.now ?? Math.floor(Date.now() / 1000);
  if (
    claims.exp <= now ||
    claims.nbf > now + 5 ||
    claims.iat > now + 5 ||
    claims.exp <= claims.iat ||
    claims.exp <= claims.nbf
  ) return null;
  if (claims.exp - claims.iat > 300) return null; // assertions are always short-lived
  if (
    !["finch_key", "oauth", "service"].includes(
      claims.auth_method,
    )
  ) {
    return null;
  }
  if (expected.issuer !== undefined && claims.iss !== expected.issuer) return null;
  if (expected.audience !== undefined && claims.aud !== expected.audience) return null;
  if (expected.tenant !== undefined && claims.tenant !== expected.tenant) return null;
  if (expected.service !== undefined && claims.service !== expected.service) return null;
  if (expected.method !== undefined && claims.method !== expected.method.toUpperCase()) {
    return null;
  }
  if (
    expected.upstreamPath !== undefined &&
    claims.upstream_path !== expected.upstreamPath
  ) {
    return null;
  }
  if (
    expected.publicPath !== undefined &&
    claims.public_path !== expected.publicPath
  ) {
    return null;
  }
  if (
    expected.bodySha256 !== undefined &&
    claims.body_sha256 !== expected.bodySha256
  ) {
    return null;
  }
  return claims as CallerAssertionClaims;
}

// ---- Clerk OAuth token verification (the MCP OAuth plane) -------------------
// OAuth-only MCP clients (claude.ai custom connectors) can't send finch_ keys;
// they present a Clerk-issued OAuth access token instead. We verify it against
// Clerk's userinfo endpoint (works for opaque and JWT tokens alike — no JWKS or
// token-format assumptions) and hand back the identity so relayMcp can check it
// against the resolved tenant. A tiny isolate-local cache keeps the per-call
// Clerk round-trip off the hot path for chatty MCP sessions.

const CLERK_TOKEN_CACHE = new Map<string, { who: ClerkIdentity | null; exp: number }>();
const CLERK_TOKEN_PENDING = new Map<string, Promise<ClerkIdentity | null>>();
const CLERK_TOKEN_CACHE_TTL_MS = 60_000;
const CLERK_TOKEN_CACHE_MAX = 500;
const MAX_CLERK_USERINFO_BYTES = 16 * 1024;

/** The identity a verified Clerk OAuth token names. Only the Clerk user id
 *  is read: a tenant is one Clerk user, so the relay admits the token iff its
 *  user id is the tenant id. Organization claims are not read. */
export interface ClerkIdentity {
  sub?: string;      // Clerk user id (user_…)
  user_id?: string;  // some Clerk responses use user_id
}

async function boundedResponseJson(res: Response): Promise<unknown> {
  const declared = res.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_CLERK_USERINFO_BYTES) {
    throw new Error("userinfo response too large");
  }
  if (!res.body) throw new Error("missing userinfo body");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CLERK_USERINFO_BYTES) {
        await reader.cancel("userinfo response too large");
        throw new Error("userinfo response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function verifyClerkOAuthToken(
  token: string,
  issuer: string,
  userinfoFetcher?: Pick<Fetcher, "fetch">,
): Promise<ClerkIdentity | null> {
  if (
    typeof token !== "string" || !token ||
    token.length > MAX_COMPACT_TOKEN_CHARS ||
    typeof issuer !== "string" || !issuer
  ) return null;
  const key = await hashKey(`${issuer}\0${token}`); // never cache raw tokens
  const now = Date.now();
  const hit = CLERK_TOKEN_CACHE.get(key);
  if (hit && hit.exp > now) return hit.who;
  const pending = CLERK_TOKEN_PENDING.get(key);
  if (pending) return pending;

  const lookup = (async (): Promise<ClerkIdentity | null> => {
    let who: ClerkIdentity | null = null;
    let cacheable = false;
    try {
      const target = `${issuer.replace(/\/+$/, "")}/oauth/userinfo`;
      const init = { headers: { authorization: `Bearer ${token}` } };
      const r = userinfoFetcher
        ? await userinfoFetcher.fetch(target, init)
        : await fetch(target, init);
      cacheable = [400, 401, 403].includes(r.status);
      if (r.ok) {
        const raw = await boundedResponseJson(r);
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          const value = raw as Record<string, unknown>;
          if (
            (value.sub === undefined || typeof value.sub === "string") &&
            (value.user_id === undefined || typeof value.user_id === "string") &&
            (typeof value.sub === "string" || typeof value.user_id === "string")
          ) {
            // Keep only the user id: nothing else in userinfo is read, so
            // nothing else is cached.
            who = {
              ...(typeof value.sub === "string" ? { sub: value.sub } : {}),
              ...(typeof value.user_id === "string" ? { user_id: value.user_id } : {}),
            };
            cacheable = true;
          }
        }
      }
    } catch {
      who = null; // network/parse fault reads as unauthenticated but is retryable
    }
    if (cacheable) {
      if (CLERK_TOKEN_CACHE.size >= CLERK_TOKEN_CACHE_MAX) {
        const oldest = CLERK_TOKEN_CACHE.keys().next().value as string | undefined;
        if (oldest) CLERK_TOKEN_CACHE.delete(oldest);
      }
      CLERK_TOKEN_CACHE.set(key, {
        who,
        exp: Date.now() + CLERK_TOKEN_CACHE_TTL_MS,
      });
    }
    return who;
  })();
  CLERK_TOKEN_PENDING.set(key, lookup);
  try {
    return await lookup;
  } finally {
    CLERK_TOKEN_PENDING.delete(key);
  }
}
