import { HttpError } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { forwardHubResponse, readHubJsonObject } from "./_shared";

const MAX_AVIARY_REQUEST_BYTES = 4 * 1024;
const USER_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
const MANIFEST_DIGEST = /^[a-f0-9]{64}$/i;

type AviaryDecision = "describe" | "approve" | "deny";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(
  value: unknown,
  maxLength: number,
): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function cleanDescribeResponse(value: Record<string, unknown>): Record<string, unknown> | null {
  const manifest = value.manifest;
  if (
    value.found !== true ||
    !["pending", "approved", "consumed", "denied", "expired"].includes(
      typeof value.status === "string" ? value.status : "",
    ) ||
    !isObject(manifest) ||
    typeof manifest.service !== "string" ||
    !manifest.service ||
    manifest.service.length > 100 ||
    typeof manifest.app_path !== "string" ||
    !manifest.app_path ||
    manifest.app_path.length > 63 ||
    !Array.isArray(manifest.routes) ||
    manifest.routes.length > 100 ||
    !manifest.routes.every(
      (route) => typeof route === "string" && route.length > 0 && route.length <= 256,
    ) ||
    (manifest.edge_auth !== "key" && manifest.edge_auth !== "public") ||
    typeof manifest.machine !== "string" ||
    !manifest.machine ||
    manifest.machine.length > 64 ||
    typeof manifest.machine_fingerprint !== "string" ||
    !manifest.machine_fingerprint ||
    manifest.machine_fingerprint.length > 512 ||
    typeof value.manifest_sha256 !== "string" ||
    !MANIFEST_DIGEST.test(value.manifest_sha256) ||
    !optionalString(value.req_ip, 256) ||
    !optionalString(value.req_ua, 1024) ||
    (value.age_seconds !== undefined &&
      (!Number.isSafeInteger(value.age_seconds) || (value.age_seconds as number) < 0)) ||
    !optionalString(value.expires_at, 64) ||
    (value.expires_at !== undefined && Number.isNaN(Date.parse(value.expires_at as string))) ||
    (value.public_approval_required !== undefined &&
      typeof value.public_approval_required !== "boolean") ||
    (value.public_approved !== undefined && typeof value.public_approved !== "boolean") ||
    !optionalString(value.detail, 1000)
  ) {
    return null;
  }

  return {
    found: true,
    status: value.status,
    manifest: {
      service: manifest.service,
      app_path: manifest.app_path,
      routes: manifest.routes,
      edge_auth: manifest.edge_auth,
      machine: manifest.machine,
      machine_fingerprint: manifest.machine_fingerprint,
    },
    manifest_sha256: value.manifest_sha256,
    ...(value.req_ip !== undefined ? { req_ip: value.req_ip } : {}),
    ...(value.req_ua !== undefined ? { req_ua: value.req_ua } : {}),
    ...(value.age_seconds !== undefined ? { age_seconds: value.age_seconds } : {}),
    ...(value.expires_at !== undefined ? { expires_at: value.expires_at } : {}),
    ...(value.public_approval_required !== undefined
      ? { public_approval_required: value.public_approval_required }
      : {}),
    ...(value.public_approved !== undefined ? { public_approved: value.public_approved } : {}),
    ...(value.detail !== undefined ? { detail: value.detail } : {}),
  };
}

function cleanDecisionResponse(
  value: Record<string, unknown>,
  decision: Exclude<AviaryDecision, "describe">,
): Record<string, unknown> | null {
  const validStatus =
    decision === "approve"
      ? value.status === "approved" || value.status === "pending"
      : value.status === "denied";
  return value.ok === true && validStatus
    ? { ok: true, status: value.status }
    : null;
}

export async function readAviaryEnrollmentRequest(req: Request): Promise<{
  body: Record<string, unknown>;
  userCode: string;
}> {
  const body = await readJsonObject(req, MAX_AVIARY_REQUEST_BYTES);
  const raw = body.user_code !== undefined ? body.user_code : body.userCode;
  if (typeof raw !== "string") {
    throw new HttpError(400, "a valid user_code is required");
  }

  const compact = raw.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!USER_CODE_PATTERN.test(compact)) {
    throw new HttpError(400, "a valid user_code is required");
  }
  return {
    body,
    userCode: `${compact.slice(0, 4)}-${compact.slice(4)}`,
  };
}

/** Validate successful hub responses while preserving structured hub errors. */
export async function aviaryEnrollmentResponse(
  response: Response,
  decision: AviaryDecision,
): Promise<Response> {
  if (!response.ok) return forwardHubResponse(response);
  const value = await readHubJsonObject(response);
  const clean = decision === "describe"
    ? cleanDescribeResponse(value)
    : cleanDecisionResponse(value, decision);
  if (!clean) throw new HttpError(502, "invalid response from hub");
  return Response.json(clean, { status: response.status });
}
