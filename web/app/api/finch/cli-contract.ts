import { HttpError } from "@/lib/hub";

export const MAX_CLI_REQUEST_BYTES = 4 * 1024;

const CLI_CODE_ALPHABET = "A-HJ-NP-Z2-9";
const CLI_CODE_RE = new RegExp(`^[${CLI_CODE_ALPHABET}]{4}-?[${CLI_CODE_ALPHABET}]{4}$`);
const EMAIL_LABEL_LIMIT = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Normalize either accepted human form (ABCD-EFGH or ABCDEFGH) to one wire form. */
export function parseCliUserCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "userCode must be a string");
  }
  const compact = value.trim().toUpperCase().replace(/\s+/g, "");
  if (!compact) throw new HttpError(400, "userCode required");
  if (!CLI_CODE_RE.test(compact)) {
    throw new HttpError(400, "invalid userCode");
  }
  const raw = compact.replace("-", "");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** The client value is a cosmetic fallback; never coerce objects into labels. */
export function parseOptionalClientEmail(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new HttpError(400, "email must be a string");
  }
  const email = value.trim();
  if (email.length > EMAIL_LABEL_LIMIT) throw new HttpError(400, "email is too long");
  if (CONTROL_CHARACTERS.test(email)) {
    throw new HttpError(400, "email contains control characters");
  }
  return email;
}

/** Clerk data is trusted for identity, but still runtime-validate and bound its label. */
export function normalizeServerEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  const email = value.trim();
  return email.length <= EMAIL_LABEL_LIMIT && !CONTROL_CHARACTERS.test(email)
    ? email
    : "";
}

export function validApproveResponse(value: JsonObject): boolean {
  return value.ok === true;
}

export function cleanDescribeResponse(value: JsonObject): JsonObject | null {
  if (typeof value.found !== "boolean") return null;
  if (value.found === false) return { found: false };

  const reqIp = value.reqIp;
  const reqUa = value.reqUa;
  const ageSeconds = value.ageSeconds;
  const approved = value.approved;
  if (
    (reqIp !== undefined && (typeof reqIp !== "string" || reqIp.length > 256)) ||
    (reqUa !== undefined && (typeof reqUa !== "string" || reqUa.length > 1024)) ||
    (ageSeconds !== undefined &&
      (!Number.isSafeInteger(ageSeconds) || (ageSeconds as number) < 0)) ||
    (approved !== undefined && typeof approved !== "boolean")
  ) {
    return null;
  }
  return {
    found: true,
    ...(reqIp !== undefined ? { reqIp } : {}),
    ...(reqUa !== undefined ? { reqUa } : {}),
    ...(ageSeconds !== undefined ? { ageSeconds } : {}),
    ...(approved !== undefined ? { approved } : {}),
  };
}
