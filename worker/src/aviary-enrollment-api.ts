/// <reference types="@cloudflare/workers-types" />
// Public proof-of-possession start/poll routes plus tenant-admin describe and
// decision routes for Aviary service enrollment.

import type { Env } from "./index";
import { clientIp, json, rateLimitOk } from "./index";
import { serviceOk, verifyAssertion } from "./auth";
import {
  AVIARY_POLL_INTERVAL_SECONDS,
  AVIARY_PROTOCOL,
  AVIARY_TTL_MS,
  aviaryEnrollmentOp,
  type AviaryManifest,
} from "./aviary-enrollment-do";

const MAX_BODY_BYTES = 16 * 1024;
// Finch DynamicRegistry's service/app path cap is 63 bytes/ASCII characters.
const APP_PATH_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const SERVICE_RE = /^[A-Za-z0-9 ._-]{1,100}$/;
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MACHINE_RE = /^[A-Za-z0-9 ._-]{1,64}$/;
const ROUTE_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;

type OpResult = {
  ok: boolean;
  code?: string;
  message?: string;
  status?: string;
  [key: string]: unknown;
};

function enrollmentError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

async function boundedJson(req: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function b64urlToBytes(raw: unknown): Uint8Array | null {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const pad = "=".repeat((4 - (raw.length % 4)) % 4);
    const binary = atob(raw.replace(/-/g, "+").replace(/_/g, "/") + pad);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** Match encoding/json's default HTML-safe string escaping. JSON.stringify
 *  otherwise leaves <, >, &, U+2028, and U+2029 literal, producing a different
 *  manifest digest from the Go agent for otherwise-valid service labels. */
function goCanonicalJson(value: unknown): string {
  const escaped: Record<string, string> = {
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  };
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => escaped[ch]);
}

function cleanRoute(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let route = raw.trim();
  if (route.endsWith("/")) route = route.slice(0, -1);
  if (!route || route === "/" || route.length > 256 || !route.startsWith("/")) return null;
  if (/[?*#\\%]/.test(route) || route.includes("//")) return null;
  const segments = route.slice(1).split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !ROUTE_SEGMENT_RE.test(segment),
    )
  ) {
    return null;
  }
  return route;
}

async function canonicalManifest(
  raw: unknown,
  publicKey: Uint8Array,
): Promise<{ manifest: AviaryManifest; json: string; digest: string } | { error: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "manifest must be an object" };
  }
  const input = raw as Record<string, unknown>;
  const service = typeof input.service === "string" ? input.service.trim() : "";
  if (!SERVICE_RE.test(service)) {
    return { error: "service must be 1-100 characters using letters, digits, spaces, dot, underscore, or hyphen" };
  }
  const appPath = typeof input.app_path === "string" ? input.app_path.trim() : "";
  if (!APP_PATH_RE.test(appPath)) return { error: "app_path must be one safe URL segment" };
  const machine = typeof input.machine === "string" ? input.machine.trim() : "";
  if (!MACHINE_RE.test(machine)) return { error: "machine has invalid characters or length" };
  const edgeAuth = input.edge_auth === undefined || input.edge_auth === ""
    ? "key"
    : input.edge_auth;
  if (edgeAuth !== "key" && edgeAuth !== "public") {
    return { error: "edge_auth must be key or public" };
  }
  const rawRoutes = input.routes === undefined
    ? ["/mcp", "/api/v1", "/birdz"]
    : input.routes;
  if (!Array.isArray(rawRoutes) || rawRoutes.length < 1 || rawRoutes.length > 16) {
    return { error: "routes must contain 1-16 safe path prefixes" };
  }
  const routes: string[] = [];
  for (const value of rawRoutes) {
    const route = cleanRoute(value);
    if (!route) return { error: `route ${JSON.stringify(value)} is not a safe path prefix` };
    if (!routes.includes(route)) routes.push(route);
  }
  routes.sort();
  const fingerprint = `SHA256:${(await sha256Hex(publicKey)).slice(0, 32)}`;
  if (input.machine_fingerprint !== fingerprint) {
    return { error: "machine_fingerprint does not match the device proof key" };
  }
  const expectedTenant = typeof input.expected_tenant === "string"
    ? input.expected_tenant.trim()
    : "";
  if (expectedTenant && !TENANT_RE.test(expectedTenant)) {
    return { error: "expected_tenant has invalid characters or length" };
  }
  // Property order intentionally matches Go's ServiceEnrollmentManifest
  // declaration; goCanonicalJson also mirrors encoding/json's HTML escaping.
  const manifest: AviaryManifest = {
    service,
    app_path: appPath,
    routes,
    edge_auth: edgeAuth,
    machine,
    machine_fingerprint: fingerprint,
    ...(expectedTenant ? { expected_tenant: expectedTenant } : {}),
  };
  const encoded = goCanonicalJson(manifest);
  return { manifest, json: encoded, digest: await sha256Hex(encoded) };
}

function verificationBase(env: Env, host: string): string | null {
  const local = host.startsWith("localhost") || host.startsWith("127.");
  const hubOrigin = `${local ? "http" : "https"}://${host}`;
  let configured: URL;
  try {
    configured = new URL(env.WEB_URL || hubOrigin);
  } catch {
    return null;
  }
  if (
    configured.username ||
    configured.password ||
    configured.search ||
    configured.hash ||
    (configured.pathname !== "/" && configured.pathname !== "") ||
    (configured.protocol !== "https:" && !(local && configured.protocol === "http:"))
  ) {
    return null;
  }
  const allowed = new Set<string>([hubOrigin]);
  for (const raw of (env.AVIARY_VERIFICATION_ORIGINS || "").split(",")) {
    const value = raw.trim();
    if (!value) continue;
    try {
      const origin = new URL(value);
      if (
        origin.protocol === "https:" &&
        !origin.username &&
        !origin.password &&
        !origin.search &&
        !origin.hash &&
        (origin.pathname === "/" || origin.pathname === "")
      ) {
        allowed.add(origin.origin);
      }
    } catch {
      // Bad deployment allowlist entries do not become trusted origins.
    }
  }
  if (!allowed.has(configured.origin)) return null;
  return configured.origin;
}

function errorStatus(code: string | undefined): number {
  switch (code) {
    case "rate_limited":
    case "pending_limit":
      return 429;
    case "not_found":
      return 404;
    case "expired":
      return 410;
    case "manifest_conflict":
    case "manifest_mismatch":
    case "app_path_collision":
    case "tenant_conflict":
    case "terminal_state":
      return 409;
    case "tenant_mismatch":
      return 403;
    case "invalid_proof":
      return 401;
    case "internal_error":
    case "registration_failed":
    case "credential_epoch_commit_failed":
      return 503;
    default:
      return 400;
  }
}

function opError(out: OpResult): Response {
  return enrollmentError(
    errorStatus(out.code),
    out.code || "invalid_request",
    out.message || "invalid enrollment request",
  );
}

async function authenticatedTenant(req: Request, env: Env): Promise<string | null> {
  if (!serviceOk(req, env)) return null;
  return verifyAssertion(req.headers.get("X-Finch-Auth") || "", env.FINCH_SERVICE_SECRET);
}

export async function handleAviaryEnrollmentApi(
  req: Request,
  env: Env,
  host: string,
): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method !== "POST") return enrollmentError(405, "method_not_allowed", "POST only");
  const body = await boundedJson(req);
  if (!body) return enrollmentError(400, "invalid_json", "request must be a JSON object under 16 KiB");

  if (path === "/api/aviary/device/start") {
    if (!(await rateLimitOk(env.JOIN_LIMIT, `aviary-start:${clientIp(req)}`))) {
      return enrollmentError(429, "rate_limited", "too many enrollment attempts");
    }
    if (body.protocol !== AVIARY_PROTOCOL) {
      return enrollmentError(400, "unsupported_protocol", "unsupported enrollment protocol");
    }
    const keyBytes = b64urlToBytes(body.device_public_key);
    if (!keyBytes || keyBytes.length !== 32) {
      return enrollmentError(400, "invalid_public_key", "device_public_key must be raw Ed25519 base64url");
    }
    const canonical = await canonicalManifest(body.manifest, keyBytes);
    if ("error" in canonical) return enrollmentError(400, "invalid_manifest", canonical.error);
    if (body.manifest_sha256 !== canonical.digest) {
      return enrollmentError(400, "manifest_digest_mismatch", "manifest_sha256 does not match the canonical manifest");
    }
    const webBase = verificationBase(env, host);
    if (!webBase) {
      return enrollmentError(503, "verification_origin_misconfigured", "verification origin is not explicitly allowed");
    }
    const publicKey = String(body.device_public_key);
    const out = await aviaryEnrollmentOp<OpResult>(env, "start", {
      manifest: canonical.manifest,
      manifestJson: canonical.json,
      manifestSha256: canonical.digest,
      publicKey,
      reqIp: clientIp(req),
      reqUa: (req.headers.get("user-agent") || "").slice(0, 200),
      now: Date.now(),
    });
    if (!out.ok) return opError(out);
    const userCode = String(out.user_code);
    return json(200, {
      device_code: out.device_code,
      user_code: userCode,
      verification_uri: `${webBase}/aviary/authorize`,
      verification_uri_complete: `${webBase}/aviary/authorize?code=${encodeURIComponent(userCode)}`,
      expires_in: Math.max(1, Math.floor((Number(out.expires) - Date.now()) / 1000)),
      interval: AVIARY_POLL_INTERVAL_SECONDS,
      manifest_sha256: canonical.digest,
      public_approval_required: canonical.manifest.edge_auth === "public",
    });
  }

  if (path === "/api/aviary/device/poll") {
    if (body.protocol !== AVIARY_PROTOCOL) {
      return enrollmentError(400, "unsupported_protocol", "unsupported enrollment protocol");
    }
    const proof = body.proof;
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
      return enrollmentError(400, "invalid_proof", "proof is required");
    }
    const p = proof as Record<string, unknown>;
    if (p.alg !== "Ed25519") {
      return enrollmentError(400, "invalid_proof", "proof algorithm must be Ed25519");
    }
    const out = await aviaryEnrollmentOp<OpResult>(env, "poll", {
      deviceCode: body.device_code,
      manifestSha256: body.manifest_sha256,
      publicKey: p.public_key,
      signature: p.signature,
      ackDelivery: body.ack_delivery,
      now: Date.now(),
    });
    if (!out.ok) return opError(out);
    return json(200, Object.fromEntries(Object.entries(out).filter(([key]) => key !== "ok")));
  }

  if (
    path !== "/api/aviary/device/describe" &&
    path !== "/api/aviary/device/approve" &&
    path !== "/api/aviary/device/deny"
  ) {
    return enrollmentError(404, "not_found", "unknown enrollment route");
  }
  const tenant = await authenticatedTenant(req, env);
  if (!tenant) return enrollmentError(401, "unauthorized", "valid Finch service and tenant assertion required");
  if (!(await rateLimitOk(env.JOIN_LIMIT, `aviary-decision:${tenant}`))) {
    return enrollmentError(429, "rate_limited", "too many enrollment decisions");
  }
  const userCode = body.user_code ?? body.userCode;
  if (typeof userCode !== "string" || !userCode.trim()) {
    return enrollmentError(400, "invalid_user_code", "user_code is required");
  }
  const approver = typeof body.approver === "string" ? body.approver : "";

  if (path === "/api/aviary/device/describe") {
    const out = await aviaryEnrollmentOp<OpResult>(env, "describe", {
      userCode,
      now: Date.now(),
    });
    if (!out.ok) return opError(out);
    const describedManifest = out.manifest as AviaryManifest | undefined;
    if (
      describedManifest?.expected_tenant &&
      describedManifest.expected_tenant !== tenant
    ) {
      return enrollmentError(
        403,
        "tenant_mismatch",
        "sign in to the tenant named by the approved manifest",
      );
    }
    return json(200, Object.fromEntries(Object.entries(out).filter(([key]) => key !== "ok")));
  }
  if (path === "/api/aviary/device/approve") {
    const local = host.startsWith("localhost") || host.startsWith("127.");
    const out = await aviaryEnrollmentOp<OpResult>(env, "approve", {
      userCode,
      tenant,
      approver,
      publicApproved: body.public_approved === true,
      publicOrigin: `${local ? "http" : "https"}://${host}`,
      now: Date.now(),
    });
    if (!out.ok) return opError(out);
    return json(200, {
      ok: true,
      status: out.status,
      ...(out.approved_tenant ? { approved_tenant: out.approved_tenant } : {}),
    });
  }
  const out = await aviaryEnrollmentOp<OpResult>(env, "deny", {
    userCode,
    tenant,
    approver,
    reason: body.reason,
    now: Date.now(),
  });
  if (!out.ok) return opError(out);
  return json(200, { ok: true, status: out.status });
}

export function isAviaryEnrollmentPath(path: string): boolean {
  return path.startsWith("/api/aviary/device/");
}

// Exported for focused golden-vector tests without exposing it over HTTP.
export const aviaryManifestForTest = canonicalManifest;
export const aviaryVerificationBaseForTest = verificationBase;
