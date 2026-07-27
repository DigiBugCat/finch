// PUT /api/finch/settings {key,val} -> hub PUT /api/settings
import { errorResponse, HttpError, hubFetchAs, requireAdmin } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { relayHubJson } from "../services/_contract";

const STRING_LIMITS = { org: 100, subdomain: 63, defaultGroup: 100, keyExpiry: 32 } as const;
const BOOLEAN_KEYS = new Set(["requireApproval", "enforceExpiry", "require2fa"]);
// Mirrors SLUG_RE in ../slug-check and SUBDOMAIN_LABEL_RE in the hub's tenant-do.
const SUBDOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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
    // A subdomain is a bare DNS label. A dotted value would register an
    // arbitrary host key in the shared RouterDO, bypassing the vanity-tier gate
    // and CF provisioning that /api/finch/hostnames enforces. The hub rejects
    // this too (tenant-do updateSetting) — this is the second layer.
    // Compare lowercased: the hub lowercases before validating, so "Demo" is a
    // legitimate slug and must not be rejected here.
    if (body.key === "subdomain" && value && !SUBDOMAIN_LABEL_RE.test(value.toLowerCase())) {
      throw new HttpError(400, "subdomain must be a single label (letters, digits, hyphens)");
    }
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
