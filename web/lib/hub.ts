// lib/hub.ts — server-only bridge to the Finch hub control plane.
//
// The hub (../worker) is the source of truth. Its /api/* surface is
// service-secret authed and tenant-scoped:
//   X-Finch-Service: <FINCH_SERVICE_SECRET>   (must equal the hub's)
//   X-Finch-Tenant:  <tenantId>                (the Clerk org id, or user id)
//
// This module centralizes (a) resolving the tenant from the Clerk session and
// (b) calling the hub with the right headers. Route handlers stay thin.

import "server-only";
import { auth } from "@clerk/nextjs/server";

/** A thrown HttpError short-circuits a route handler with a JSON response. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Read a runtime var from the Cloudflare env (OpenNext) or process.env.
 *  Under `next dev` getCloudflareContext throws/has no env, so we fall back. */
async function runtimeEnv(name: string): Promise<string | undefined> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = getCloudflareContext().env as Record<string, unknown>;
    const v = env?.[name];
    if (typeof v === "string" && v.length) return v;
  } catch {
    // not running under the Cloudflare adapter (e.g. `next dev`) — fall through
  }
  const pv = process.env[name];
  return typeof pv === "string" && pv.length ? pv : undefined;
}

/**
 * The tenant = the Clerk org id, or the user id if there's no active org.
 * Throws 401 (HttpError) when the request is unauthenticated.
 */
export async function resolveTenant(): Promise<string> {
  const { userId, orgId } = await auth();
  if (!userId) throw new HttpError(401, "unauthenticated");
  return orgId ?? userId;
}

/**
 * Call the hub control API for the current tenant. Resolves the tenant from
 * the Clerk session, attaches the service secret + tenant headers, and fetches
 * `${HUB_URL}${path}`. Returns the raw Response (caller decides how to read it).
 */
export async function hubFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const tenant = await resolveTenant();

  const hubUrl = await runtimeEnv("HUB_URL");
  const serviceSecret = await runtimeEnv("FINCH_SERVICE_SECRET");
  if (!hubUrl) throw new HttpError(500, "HUB_URL is not configured");
  if (!serviceSecret) {
    throw new HttpError(500, "FINCH_SERVICE_SECRET is not configured");
  }

  const headers = new Headers(init.headers);
  headers.set("X-Finch-Service", serviceSecret);
  headers.set("X-Finch-Tenant", tenant);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return fetch(`${hubUrl}${path}`, { ...init, headers });
}

/** Call the hub and pass its JSON body + status straight back to the client. */
export async function hubProxy(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await hubFetch(path, init);
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
    },
  });
}

/** Turn a thrown HttpError (or anything) into a JSON Response for a handler. */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : "internal error";
  return Response.json({ error: message }, { status: 500 });
}
