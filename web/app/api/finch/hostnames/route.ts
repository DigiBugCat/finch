// /api/finch/hostnames -> hub /api/hostnames — custom-domain management for the
// Settings "Custom domains" card. Pure admin-gated proxy: GET lists, POST adds
// (hostname in the body), DELETE removes. Ownership + vanity-suffix gating and
// the Cloudflare-for-SaaS provisioning all live hub-side; we only forward.
import { errorResponse, HttpError, hubFetchAs, requireAdmin } from "@/lib/hub";
import { forwardHubResponse, readJsonObject } from "../_shared";

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function customHostname(value: unknown): string {
  const hostname = typeof value === "string" ? value.trim().toLowerCase() : "";
  const labels = hostname.split(".");
  if (
    hostname.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !DNS_LABEL_RE.test(label))
  ) {
    throw new HttpError(400, "invalid hostname");
  }
  return hostname;
}

async function mutate(req: Request, method: "POST" | "DELETE"): Promise<Response> {
  const ctx = await requireAdmin();
  const body = await readJsonObject(req);
  const hostname = customHostname(body.hostname);
  const response = await hubFetchAs(ctx.tenant, "/api/hostnames", {
    method,
    body: JSON.stringify({ hostname }),
  });
  return forwardHubResponse(response);
}

export async function GET() {
  try {
    const ctx = await requireAdmin();
    const response = await hubFetchAs(ctx.tenant, "/api/hostnames", { method: "GET" });
    return forwardHubResponse(response);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    return await mutate(req, "POST");
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request) {
  try {
    return await mutate(req, "DELETE");
  } catch (err) {
    return errorResponse(err);
  }
}
