import { auth } from "@clerk/nextjs/server";
import { HttpError, userFetch } from "@/lib/hub";
import { syncIdentity } from "@/lib/identity";

async function serviceDomain(): Promise<string> {
  let configured: unknown;
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    configured = (getCloudflareContext().env as Record<string, unknown>)?.BOX_DOMAIN;
  } catch {}
  const value = typeof configured === "string" && configured
    ? configured
    : process.env.BOX_DOMAIN || "finchmcp.com";
  const domain = value.trim().toLowerCase();
  if (!isValidHostKey(domain) || !domain.includes(".")) {
    throw new HttpError(500, "BOX_DOMAIN is not a valid DNS domain");
  }
  return domain;
}

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function isValidHostKey(key: string): boolean {
  if (!key || key !== key.toLowerCase()) return false;
  if (!key.includes(".")) return DNS_LABEL_RE.test(key);
  if (key.length > 253) return false;
  const labels = key.split(".");
  return labels.length >= 2 && labels.every((label) => DNS_LABEL_RE.test(label));
}
function safeRelPath(rd: string | null): string {
  if (rd && rd.length > 2_048) return "/";
  if (!rd || !rd.startsWith("/") || rd.startsWith("//") || rd.startsWith("/\\")) return "/";
  return /[\\\x00-\x1f]/.test(rd) ? "/" : rd;
}

function validGrant(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !/[\x00-\x20\x7f]/.test(value);
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.redirect(new URL("/sign-in", req.url), 302);
  const url = new URL(req.url);
  const hostKey = (url.searchParams.get("slug") || "").trim().toLowerCase();
  const rd = safeRelPath(url.searchParams.get("rd"));
  if (!isValidHostKey(hostKey)) return new Response("invalid service host", { status: 400 });

  try {
    const identity = await syncIdentity(userId);
    if (identity.emails.length) {
      await userFetch(userId, "/api/user/sync", { method: "POST", body: JSON.stringify(identity) }).catch(() => undefined);
    }
  } catch (error) {
    console.warn("portal identity sync failed", error);
  }

  let res: Response;
  try {
    res = await userFetch(userId, "/api/portal-grant", { method: "POST", body: JSON.stringify({ slug: hostKey }) });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return new Response("portal grant failed", { status });
  }
  if (res.status === 403) return new Response("You're not a member of the workspace that owns this app — ask its admin for an invite.", { status: 403 });
  if (!res.ok) return new Response("Could not start the service session. Try again.", { status: 502 });
  const data: unknown = await res.json().catch(() => null);
  const grant = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>).grant
    : undefined;
  if (!validGrant(grant)) return new Response("Could not start the service session. Try again.", { status: 502 });
  let domain: string;
  try {
    domain = await serviceDomain();
  } catch {
    return new Response("Portal service is not configured.", { status: 500 });
  }
  const cbHost = hostKey.includes(".") ? hostKey : `${hostKey}.${domain}`;
  return Response.redirect(`https://${cbHost}/__finch/cb?g=${encodeURIComponent(grant)}&rd=${encodeURIComponent(rd)}`, 302);
}
