// POST /api/finch/enroll {name,group} -> hub POST /api/enroll
import { errorResponse, HttpError, hubFetchAs, requireAdmin } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";

const MAX_ENROLL_REQUEST_BYTES = 4 * 1024;
const MAX_NAME_CHARACTERS = 100;
const MAX_GROUP_CHARACTERS = 100;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
// The worker derives a DNS-label-safe canonical ID and guarantees <=63 chars.
// `name` remains independent display input; the returned `id` is authoritative.
const SERVICE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizedString(
  value: unknown,
  field: string,
  maxCharacters: number,
  required: boolean,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) {
    if (required) throw new HttpError(400, `${field} required`);
    return undefined;
  }
  if ([...normalized].length > maxCharacters) {
    throw new HttpError(400, `${field} is too long`);
  }
  if (CONTROL_CHARACTERS.test(normalized)) {
    throw new HttpError(400, `${field} contains control characters`);
  }
  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validEnrollResponse(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    SERVICE_ID.test(value.id) &&
    typeof value.ticket === "string" &&
    value.ticket.length > 0 &&
    value.ticket.length <= 4096 &&
    typeof value.url === "string" &&
    value.url.length > 0 &&
    value.url.length <= 8192 &&
    typeof value.install === "string" &&
    value.install.length > 0 &&
    value.install.length <= 8192 &&
    Number.isSafeInteger(value.expiresAt) &&
    (value.expiresAt as number) > Math.floor(Date.now() / 1000)
  );
}

async function relayEnrollResponse(res: Response): Promise<Response> {
  const raw = await res.text();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  if (!res.ok) {
    return isObject(value)
      ? new Response(raw, { status: res.status, headers: { "content-type": "application/json" } })
      : Response.json({ error: "hub request failed" }, { status: res.status });
  }
  if (!isObject(value) || !validEnrollResponse(value)) {
    throw new HttpError(502, "invalid response from hub");
  }
  return new Response(raw, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: Request) {
  try {
    // Resolve authorization before touching a potentially hostile request body.
    const ctx = await requireAdmin();
    const body = await readJsonObject(req, MAX_ENROLL_REQUEST_BYTES);
    const unknown = Object.keys(body).filter((key) => key !== "name" && key !== "group");
    if (unknown.length) throw new HttpError(400, `unknown field: ${unknown[0]}`);

    const name = normalizedString(body.name, "name", MAX_NAME_CHARACTERS, true)!;
    const group = normalizedString(body.group, "group", MAX_GROUP_CHARACTERS, false);
    let res: Response;
    try {
      res = await hubFetchAs(ctx.tenant, "/api/enroll", {
        method: "POST",
        body: JSON.stringify({ name, ...(group ? { group } : {}) }),
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "hub unavailable");
    }
    try {
      return await relayEnrollResponse(res);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "invalid response from hub");
    }
  } catch (err) {
    return errorResponse(err);
  }
}
