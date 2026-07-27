import { HttpError, hubFetchAs } from "@/lib/hub";

const MAX_FIELD_LENGTH = 256;
const MAX_HUB_RESPONSE_BYTES = 512 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENTITY_TYPES = new Set(["user", "group", "key", "tag", "service", "all"]);
const ACCESS_STATUSES = new Set(["pending", "invited", "granted", "denied"]);

type JsonObject = Record<string, unknown>;

export interface AccessRowContract {
  id: string;
  email: string;
  service: string;
  requestedBy: string;
  status: "pending" | "invited" | "granted" | "denied";
  created: number;
  resolvedBy?: string;
  resolvedAt?: number;
}

export interface AccessGrantContract {
  id: string;
  src: { type: string; name?: string };
  dst: { type: string; name?: string }[];
}

export function requiredString(
  body: JsonObject,
  key: string,
  message: string,
  maxLength = MAX_FIELD_LENGTH,
): string {
  const value = body[key];
  if (typeof value !== "string") throw new HttpError(400, message);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new HttpError(400, message);
  }
  return trimmed;
}

export function accessId(body: JsonObject, key = "id"): string {
  return requiredString(body, key, `${key} required`);
}

export function accessEmail(body: JsonObject): string {
  const email = requiredString(body, "email", "valid email and service required", 254)
    .toLowerCase();
  if (!validEmailContract(email)) {
    throw new HttpError(400, "valid email and service required");
  }
  return email;
}

export function validEmailContract(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 254 || !EMAIL_RE.test(value)) return false;
  const at = value.indexOf("@");
  return at > 0 && at <= 64 && value.length - at - 1 <= 253;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validContractString(value: unknown, maxLength = MAX_FIELD_LENGTH): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validEntity(value: unknown): value is { type: string; name?: string } {
  if (!isObject(value) || typeof value.type !== "string" || !ENTITY_TYPES.has(value.type)) {
    return false;
  }
  return value.type === "all"
    ? value.name === undefined
    : validContractString(value.name);
}

function validAccessRow(value: unknown): value is AccessRowContract {
  if (!isObject(value)) return false;
  return (
    validContractString(value.id) &&
    validEmailContract(value.email) &&
    validContractString(value.service) &&
    validContractString(value.requestedBy) &&
    typeof value.status === "string" &&
    ACCESS_STATUSES.has(value.status) &&
    typeof value.created === "number" &&
    Number.isFinite(value.created) &&
    (value.resolvedBy === undefined || validContractString(value.resolvedBy)) &&
    (value.resolvedAt === undefined ||
      (typeof value.resolvedAt === "number" && Number.isFinite(value.resolvedAt)))
  );
}

function validAccessGrant(value: unknown): value is AccessGrantContract {
  if (!isObject(value)) return false;
  return (
    validContractString(value.id) &&
    validEntity(value.src) &&
    value.src.type === "user" &&
    Array.isArray(value.dst) &&
    value.dst.length > 0 &&
    value.dst.every(validEntity)
  );
}

export function accessLens(value: unknown): {
  requests: AccessRowContract[];
  grants: AccessGrantContract[];
} {
  if (
    !isObject(value) ||
    !Array.isArray(value.requests) ||
    !value.requests.every(validAccessRow) ||
    !Array.isArray(value.grants) ||
    !value.grants.every(validAccessGrant)
  ) {
    throw new HttpError(502, "invalid response from hub");
  }
  return { requests: value.requests, grants: value.grants };
}

export function accessRequestResult(value: unknown): JsonObject {
  if (!isObject(value) || value.ok !== true || !validAccessRow(value.request)) {
    throw new HttpError(502, "invalid response from hub");
  }
  return value;
}

export function revokeResult(value: unknown): { removed: boolean; stillAllowed: boolean } {
  if (
    !isObject(value) ||
    typeof value.removed !== "boolean" ||
    typeof value.stillAllowed !== "boolean"
  ) {
    throw new HttpError(502, "invalid response from hub");
  }
  return { removed: value.removed, stillAllowed: value.stillAllowed };
}

export async function fetchAccessLens(tenant: string): Promise<{
  requests: AccessRowContract[];
  grants: AccessGrantContract[];
}> {
  const response = await hubFetchAs(tenant, "/api/access", { method: "GET" });
  if (!response.ok) throw new HttpError(response.status, "could not list access");
  return accessLens(await readHubJsonObject(response));
}

export async function revokeUserGrant(
  tenant: string,
  email: string,
  service: string,
): Promise<{ removed: boolean; stillAllowed: boolean }> {
  const response = await hubFetchAs(tenant, "/api/access/revoke-grant", {
    method: "POST",
    body: JSON.stringify({ email: email.toLowerCase(), service }),
  });
  if (!response.ok) throw new HttpError(response.status, "could not remove grant");
  return revokeResult(await readHubJsonObject(response));
}

export async function readHubJsonObject(response: Response): Promise<JsonObject> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_HUB_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(502, "invalid response from hub");
  }
  if (!response.body) throw new HttpError(502, "invalid response from hub");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HUB_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(502, "invalid response from hub");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isObject(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new HttpError(502, "invalid response from hub");
  }
}

export function aclPayload(body: JsonObject): {
  src: { type: string; name?: string };
  dst: { type: string; name?: string }[];
} {
  const src = body.src;
  const dst = body.dst;
  if (
    !validEntity(src) ||
    !["user", "group", "key"].includes(src.type) ||
    !Array.isArray(dst) ||
    dst.length === 0 ||
    dst.length > 100 ||
    !dst.every(validEntity) ||
    !dst.every((entity) => ["service", "tag", "group", "all"].includes(entity.type))
  ) {
    throw new HttpError(400, "valid src and dst required");
  }

  const canonicalSrc = {
    type: src.type,
    ...(src.name === undefined
      ? {}
      : { name: src.type === "user" ? src.name.trim().toLowerCase() : src.name.trim() }),
  };
  const canonicalDst = dst.map((entity) => ({
    type: entity.type,
    ...(entity.name === undefined ? {} : { name: entity.name.trim() }),
  }));
  const keys = canonicalDst.map((entity) => `${entity.type}:${entity.name ?? ""}`.toLowerCase());
  if (new Set(keys).size !== keys.length || (canonicalDst.length > 1 && keys.includes("all:"))) {
    throw new HttpError(400, "destinations must be unique and all must stand alone");
  }
  return { src: canonicalSrc, dst: canonicalDst };
}
