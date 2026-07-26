// PUT /api/finch/settings {key,val} -> hub PUT /api/settings
import { errorResponse, HttpError, hubFetchAs, requireAdmin } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { relayHubJson } from "../services/_contract";

const STRING_LIMITS = { org: 100, subdomain: 63, defaultGroup: 100, keyExpiry: 32 } as const;
const BOOLEAN_KEYS = new Set(["requireApproval", "enforceExpiry", "require2fa"]);

function parseSetting(body: Record<string, unknown>): { key: string; val: string | boolean } {
  if (Object.keys(body).some((key) => key !== "key" && key !== "val")) {
    throw new HttpError(400, "unknown settings request field");
  }
  if (typeof body.key !== "string") throw new HttpError(400, "invalid setting key");
  if (BOOLEAN_KEYS.has(body.key)) {
    if (typeof body.val !== "boolean") throw new HttpError(400, "setting value must be boolean");
    return { key: body.key, val: body.val };
  }
  if (body.key in STRING_LIMITS) {
    if (typeof body.val !== "string") throw new HttpError(400, "setting value must be a string");
    const value = body.val.trim();
    if ([...value].length > STRING_LIMITS[body.key as keyof typeof STRING_LIMITS]) {
      throw new HttpError(400, "setting value is too long");
    }
    if (/\p{Cc}/u.test(value)) throw new HttpError(400, "setting value contains control characters");
    return { key: body.key, val: value };
  }
  throw new HttpError(400, "invalid setting key");
}

export async function PUT(req: Request) {
  try {
    const ctx = await requireAdmin();
    const setting = parseSetting(await readJsonObject(req, 4 * 1024));
    const response = await hubFetchAs(ctx.tenant, "/api/settings", {
      method: "PUT",
      body: JSON.stringify(setting),
    });
    return await relayHubJson(response);
  } catch (err) {
    return errorResponse(err);
  }
}
