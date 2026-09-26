import { describe, it, expect } from "vitest";
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";

// The retired AviaryEnrollmentDO keeps its rows (audit history) but must not
// keep credential material: an enrollment approved before the cut holds the
// issued refresh token in grant_json. Every wake-up — the leftover expiry
// alarm, or any request — nulls the secret columns and disarms the alarm.

const ns = () => (env as any).AVIARY_ENROLLMENT as DurableObjectNamespace;
const runInDO = runInDurableObject as unknown as (
  target: DurableObjectStub,
  callback: (instance: any) => unknown,
) => Promise<any>;

/** The retired schema (the columns this test touches), one approved row
 *  holding a grant, one terminal row without, and the old alarm armed. */
async function seedLegacy(stub: DurableObjectStub) {
  await runInDO(stub, async (instance: any) => {
    const sql = instance.ctx.storage.sql;
    sql.exec(`CREATE TABLE aviary_enrollments (
      device_code TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL, tenant TEXT, grant_json TEXT, detail TEXT,
      approval_nonce TEXT)`);
    sql.exec(
      "INSERT INTO aviary_enrollments VALUES (?,?,?,?,?,?,?)",
      "dc_1", "ABCD-EFGH", "approved", "user_1",
      JSON.stringify({ refresh_token: "rt_secret" }), null, "nonce_1",
    );
    sql.exec(
      "INSERT INTO aviary_enrollments VALUES (?,?,?,?,?,?,?)",
      "dc_2", "IJKL-MNOP", "consumed", "user_1", null, "consumed", null,
    );
    await instance.ctx.storage.setAlarm(Date.now() + 60_000);
  });
}

async function snapshot(stub: DurableObjectStub) {
  return runInDO(stub, async (instance: any) => ({
    rows: instance.ctx.storage.sql
      .exec(
        "SELECT device_code, state, grant_json, approval_nonce FROM aviary_enrollments ORDER BY device_code",
      )
      .toArray(),
    alarm: await instance.ctx.storage.getAlarm(),
  }));
}

const SCRUBBED = [
  { device_code: "dc_1", state: "approved", grant_json: null, approval_nonce: null },
  { device_code: "dc_2", state: "consumed", grant_json: null, approval_nonce: null },
];

describe("retired AviaryEnrollmentDO", () => {
  it("scrubs a stored grant when its leftover alarm fires, and disarms it", async () => {
    const stub = ns().get(ns().idFromName("alarm"));
    await seedLegacy(stub);
    expect((await snapshot(stub)).rows[0].grant_json).toContain("rt_secret");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const after = await snapshot(stub);
    expect(after.rows).toEqual(SCRUBBED);
    expect(after.alarm).toBeNull();
  });

  it("scrubs on any request too, and still answers 410", async () => {
    const stub = ns().get(ns().idFromName("fetch"));
    await seedLegacy(stub);
    const res = await stub.fetch("https://aviary/", { method: "POST", body: "{}" });
    expect(res.status).toBe(410);
    const after = await snapshot(stub);
    expect(after.rows).toEqual(SCRUBBED);
    expect(after.alarm).toBeNull();
  });

  it("creates nothing on an instance that never stored anything", async () => {
    const stub = ns().get(ns().idFromName("empty"));
    const res = await stub.fetch("https://aviary/", { method: "POST", body: "{}" });
    expect(res.status).toBe(410);
    const tables = await runInDO(stub, (instance: any) =>
      instance.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='aviary_enrollments'")
        .toArray(),
    );
    expect(tables).toEqual([]);
  });
});
