import "server-only";
import { cookies } from "next/headers";

const TENANT_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const activeTenantCookieName = () => process.env.NODE_ENV === "production" ? "__Host-finch_active_tenant" : "finch_active_tenant";
export function validTenantId(value: unknown): value is string { return typeof value === "string" && TENANT_RE.test(value); }
export async function readActiveTenant(store?: Awaited<ReturnType<typeof cookies>>): Promise<string | null> { const jar=store??await cookies(); const value=jar.get(activeTenantCookieName())?.value; return validTenantId(value)?value:null; }
export async function writeActiveTenant(tenantId:string,store?:Awaited<ReturnType<typeof cookies>>):Promise<void>{if(!validTenantId(tenantId))throw new Error("invalid tenant id");const jar=store??await cookies();jar.set(activeTenantCookieName(),tenantId,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",maxAge:31536000});}
export async function clearActiveTenant(store?:Awaited<ReturnType<typeof cookies>>):Promise<void>{const jar=store??await cookies();jar.delete(activeTenantCookieName());}
