import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

// DirectoryDO is read-only after the single-user cut: the hub consults it to
// find the tenant a Clerk user owns, and never writes it. Pre-cut rows are
// seeded straight into storage, the way the retired write ops left them.

const stub = () => env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
const runInDO = runInDurableObject as unknown as (
  target: DurableObjectStub,
  callback: (instance: any) => unknown,
) => Promise<any>;

async function op(op: string, args: Record<string, unknown> = {}) {
  const res = await stub().fetch("https://directory.test/", {
    method: "POST",
    body: JSON.stringify({ op, ...args }),
  });
  return { status: res.status, body: await res.json<any>() };
}

describe("DirectoryDO — read-only owner index", () => {
  it("lists a user's stored memberships, and nothing for an unknown user", async () => {
    const clerkUserId = `user_dir_${Date.now()}`;
    const rows = [{ tenantId: "ft_owned", memberId: "m_1", role: "owner", state: "active" }];
    await runInDO(stub(), async (instance: any) => {
      await instance.ctx.storage.put(`u:${clerkUserId}`, rows);
    });
    expect(await op("listForUser", { clerkUserId })).toEqual({ status: 200, body: { memberships: rows } });
    expect(await op("listForUser", { clerkUserId: `${clerkUserId}_nobody` })).toEqual({
      status: 200,
      body: { memberships: [] },
    });
  });

  it("refuses every retired write op without touching stored rows", async () => {
    const clerkUserId = `user_dir_w_${Date.now()}`;
    const rows = [{ tenantId: "ft_keep", memberId: "m_1", role: "owner", state: "active" }];
    await runInDO(stub(), async (instance: any) => {
      await instance.ctx.storage.put(`u:${clerkUserId}`, rows);
    });
    for (const retired of [
      "upsertMembership",
      "removeMembership",
      "addInvitePointer",
      "clearInvitePointer",
      "invitesForEmails",
      "mapOrg",
      "orgLookup",
      "reindexTenant",
    ]) {
      const out = await op(retired, { clerkUserId, tenantId: "ft_keep", members: [] });
      expect(out.status, retired).toBe(400);
    }
    expect((await op("listForUser", { clerkUserId })).body.memberships).toEqual(rows);
  });
});
