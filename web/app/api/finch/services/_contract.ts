import { HttpError } from "@/lib/hub";
export { isJsonObject, readHubJsonObject, relayHubJson } from "../_shared";

const SERVICE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const BOX_NAME_RE = /^[A-Za-z0-9 ._-]{1,64}$/;

export function requireServiceId(value: unknown): string {
  if (typeof value !== "string" || !SERVICE_ID_RE.test(value)) {
    throw new HttpError(400, "invalid service id");
  }
  return value;
}

export function requireBoxName(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid box name");
  const box = value.trim();
  if (!BOX_NAME_RE.test(box)) throw new HttpError(400, "invalid box name");
  return box;
}
