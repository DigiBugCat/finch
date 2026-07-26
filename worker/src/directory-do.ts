/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import type { TenantMember } from "./types";
import { normalizeEmail } from "./types";

type Membership = { tenantId: string; memberId: string; role: string; state: string };
const response = (body: unknown, status = 200) => Response.json(body, { status });

export class DirectoryDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return response({ error: "POST only" }, 405);
    let a: any;
    try { a = await req.json(); } catch { return response({ error: "invalid JSON" }, 400); }
    const get = async <T>(key: string, fallback: T): Promise<T> => (await this.ctx.storage.get<T>(key)) ?? fallback;
    switch (a.op) {
      case "upsertMembership": {
        const key = `u:${a.clerkUserId}`; const rows = await get<Membership[]>(key, []);
        const row = { tenantId: a.tenantId, memberId: a.memberId, role: a.role, state: a.state };
        await this.ctx.storage.put(key, [...rows.filter(x => x.tenantId !== a.tenantId), row]); return response({ ok: true });
      }
      case "removeMembership": { const key=`u:${a.clerkUserId}`; const rows=await get<Membership[]>(key,[]); await this.ctx.storage.put(key, rows.filter(x=>x.tenantId!==a.tenantId)); return response({ok:true}); }
      case "listForUser": return response({ memberships: await get<Membership[]>(`u:${a.clerkUserId}`, []) });
      case "addInvitePointer": { const key=`e:${normalizeEmail(a.email)}`; const rows=await get<string[]>(key,[]); if(!rows.includes(a.tenantId)) rows.push(a.tenantId); await this.ctx.storage.put(key,rows); return response({ok:true}); }
      case "clearInvitePointer": { const key=`e:${normalizeEmail(a.email)}`; const rows=await get<string[]>(key,[]); await this.ctx.storage.put(key,rows.filter(x=>x!==a.tenantId)); return response({ok:true}); }
      case "invitesForEmails": { const out=new Set<string>(); for(const email of a.emails??[]) for(const id of await get<string[]>(`e:${normalizeEmail(email)}`,[])) out.add(id); return response({tenantIds:[...out]}); }
      case "mapOrg": await this.ctx.storage.put(`org:${a.clerkOrgId}`,a.tenantId); return response({ok:true});
      case "orgLookup": return response({tenantId:await get<string|null>(`org:${a.clerkOrgId}`,null)});
      case "reindexTenant": {
        // Scan the two indexes by PREFIX and only write rows that actually
        // reference this tenant. This previously listed the entire keyspace and
        // put() every u:/e: key unconditionally, so one tenant-create -- where
        // by definition no existing row can mention the brand-new id -- cost
        // O(total platform users + invited emails) writes against the single
        // global DO that every sign-in contends for (listForUser /
        // invitesForEmails / orgLookup). Nothing here ever deletes keys, so
        // that keyspace only grows and each new key taxed every future reindex.
        for (const prefix of ["u:", "e:"] as const) {
          const listed = await this.ctx.storage.list({ prefix });
          for (const [key, value] of listed) {
            if (prefix === "u:") {
              const rows = value as Membership[];
              const next = rows.filter(x => x.tenantId !== a.tenantId);
              if (next.length !== rows.length) await this.ctx.storage.put(key, next);
            } else {
              const rows = value as string[];
              const next = rows.filter(x => x !== a.tenantId);
              if (next.length !== rows.length) await this.ctx.storage.put(key, next);
            }
          }
        }
        for(const m of (a.members??[]) as TenantMember[]) {
          if(m.clerkUserId) { const key=`u:${m.clerkUserId}`; const rows=await get<Membership[]>(key,[]); const row={tenantId:a.tenantId,memberId:m.id,role:m.role,state:m.state}; await this.ctx.storage.put(key,[...rows.filter(x=>x.tenantId!==a.tenantId),row]); }
          else if(m.state==="invited") { const key=`e:${normalizeEmail(m.email)}`; const rows=await get<string[]>(key,[]); if(!rows.includes(a.tenantId)) rows.push(a.tenantId); await this.ctx.storage.put(key,rows); }
        }
        return response({ok:true});
      }
      default: return response({error:`unknown op: ${a.op}`},400);
    }
  }
}
