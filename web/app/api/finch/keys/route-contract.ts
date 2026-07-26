import { HttpError } from "@/lib/hub";
export {
  isJsonObject as isObject,
  relayValidatedHubJson as relayHubJson,
} from "../_shared";

export function cleanString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a string`);
  }
  const clean = value.trim();
  if (!clean) throw new HttpError(400, `${field} required`);
  if (/[\u0000-\u001f\u007f]/.test(clean)) {
    throw new HttpError(400, `${field} contains control characters`);
  }
  if (clean.length > maxLength) {
    throw new HttpError(400, `${field} is too long`);
  }
  return clean;
}

export function rejectUnknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new HttpError(400, `unknown field: ${unknown[0]}`);
}
