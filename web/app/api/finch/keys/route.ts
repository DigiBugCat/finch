// POST /api/finch/keys {label,scope,owner} -> hub POST /api/keys
import { errorResponse, HttpError, hubFetchAs, requireAdmin } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import {
  cleanString,
  isObject,
  rejectUnknownFields,
  relayHubJson,
} from "./route-contract";

const MAX_KEY_REQUEST_BYTES = 16 * 1024;
const MAX_LABEL_LENGTH = 100;
const MAX_OWNER_LENGTH = 320;
const MAX_SERVICE_ID_LENGTH = 128;
const MAX_SCOPED_SERVICES = 100;

type KeyScope = { all: true } | { services: string[] };

function parseScope(value: unknown): KeyScope | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new HttpError(400, "scope must be an object");

  rejectUnknownFields(value, ["all", "services"]);
  if (value.all === true) {
    if (value.services !== undefined) {
      throw new HttpError(400, "scope cannot combine all and services");
    }
    return { all: true };
  }
  if (value.all !== undefined && value.all !== false) {
    throw new HttpError(400, "scope.all must be a boolean");
  }
  if (!Array.isArray(value.services)) {
    throw new HttpError(400, "scope.services must be an array");
  }
  if (value.services.length > MAX_SCOPED_SERVICES) {
    throw new HttpError(400, "too many scoped services");
  }
  const services = value.services.map((service) =>
    cleanString(service, "scope service", MAX_SERVICE_ID_LENGTH),
  );
  return { services: Array.from(new Set(services)) };
}

function validMintResponse(
  value: Record<string, unknown>,
  expectedLabel: string,
  expectedScope: KeyScope,
): boolean {
  if (
    typeof value.key !== "string" ||
    !/^finch_[A-Za-z0-9_-]{43}$/.test(value.key) ||
    value.label !== expectedLabel
  ) {
    return false;
  }
  if (!isObject(value.scope)) return false;
  if ("all" in expectedScope) {
    return value.scope.all === true && value.scope.services === undefined;
  }
  if (
    (value.scope.all !== undefined && value.scope.all !== false) ||
    !Array.isArray(value.scope.services) ||
    !value.scope.services.every((service) => typeof service === "string")
  ) {
    return false;
  }
  const services = value.scope.services as string[];
  return (
    services.length === expectedScope.services.length &&
    services.every(
      (service, index) => service === expectedScope.services[index],
    )
  );
}

export async function POST(req: Request) {
  try {
    const ctx = await requireAdmin();
    const body = await readJsonObject(req, MAX_KEY_REQUEST_BYTES);
    rejectUnknownFields(body, ["label", "owner", "scope"]);

    const label = cleanString(body.label, "label", MAX_LABEL_LENGTH);
    const owner =
      body.owner === undefined
        ? undefined
        : cleanString(body.owner, "owner", MAX_OWNER_LENGTH);
    const scope = parseScope(body.scope);

    let res: Response;
    try {
      res = await hubFetchAs(ctx.tenant, "/api/keys", {
        method: "POST",
        body: JSON.stringify({ label, ...(owner ? { owner } : {}), ...(scope ? { scope } : {}) }),
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "hub unavailable");
    }
    const expectedScope: KeyScope = scope ?? { services: [] };
    return await relayHubJson(res, (value) =>
      validMintResponse(value, label, expectedScope),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
