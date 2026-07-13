import { auth } from "@clerk/nextjs/server";
import { HttpError, userFetch } from "@/lib/hub";
import { syncIdentity } from "@/lib/identity";

async function serviceDomain(): Promise<string> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const value = (getCloudflareContext().env as Record<string, unknown>)?.BOX_DOMAIN;
    if (typeof value === "string" && value) return value;
  } catch {}
  return process.env.BOX_DOMAIN || "finchmcp.com";
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
  if (!rd || !rd.startsWith("/") || rd.startsWith("//") || rd.startsWith("/\\")) return "/";
  return /[\\\x00-\x1f]/.test(rd) ? "/" : rd;
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
  const data = await res.json().catch(() => null) as { grant?: string } | null;
  if (!data?.grant) return new Response("Could not start the service session. Try again.", { status: 502 });
  const domain = await serviceDomain();
  const cbHost = hostKey.includes(".") ? hostKey : `${hostKey}.${domain}`;
  return Response.redirect(`https://${cbHost}/__finch/cb?g=${encodeURIComponent(data.grant)}&rd=${encodeURIComponent(rd)}`, 302);
}
