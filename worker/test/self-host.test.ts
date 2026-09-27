import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import { signAssertion } from "../src/auth";

// SELF-HOSTED, SINGLE-ACCOUNT MODE (docs/self-host.md). The test env already
// runs the way that guide configures a hub: DEV=1 with DEFAULT_TENANT, and no
// Cloudflare-for-SaaS credentials. resolveTenant looks the request host up in
// RouterDO BEFORE it falls back to DEFAULT_TENANT, so a hostname any signed-in
// account registers wins over the owner's fallback. These tests pin both the
// takeover the guide warns about and the config that closes it.

const SERVICE = env.FINCH_SERVICE_SECRET;
const OWNER = env.DEFAULT_TENANT as string;
const nowSec = () => Math.floor(Date.now() / 1000);
let seq = 0;

async function call(req: Request, e: Record<string, unknown> = env as any): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, e as any, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function cliEpoch(tenant: string): Promise<number> {
  const res = await env.TENANT.get(env.TENANT.idFromName(tenant)).fetch("https://tenant/op", {
    method: "POST",
    body: JSON.stringify({ op: "cliEpoch" }),
  });
  return (((await res.json()) as any).epoch ?? 0) as number;
}

/** `finch domain add <hostname>` as a CLI logged in to `tenant`, sent to the hub host. */
async function domainAdd(
  hubHost: string,
  tenant: string,
  hostname: string,
  e: Record<string, unknown> = env as any,
): Promise<Response> {
  const token = await signAssertion(
    { tenant, exp: nowSec() + 300, kind: "cli", epoch: await cliEpoch(tenant) },
    SERVICE,
  );
  return call(
    new Request(`http://${hubHost}/api/cli/hostnames`, {
      method: "POST",
      headers: {
        host: hubHost,
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ hostname }),
    }),
    e,
  );
}

async function routedTo(hostname: string): Promise<string | null> {
  const res = await env.ROUTER.get(env.ROUTER.idFromName("global")).fetch("https://router/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "lookup", slug: hostname }),
  });
  return ((await res.json()) as any).tenant || null;
}

describe("self-hosted hub in single-account mode", () => {
  it("lets any signed-in account claim the hub's own hostname when it is not reserved", async () => {
    const hub = `finch-${seq++}-${Date.now()}.selfhost.test`;
    const stranger = `user_stranger_${seq++}`;
    expect(OWNER).toBeTruthy();
    // Unclaimed: the hub host falls back to the owner (DEFAULT_TENANT).
    expect(await routedTo(hub)).toBeNull();

    const res = await domainAdd(hub, stranger, hub);
    expect(res.status).toBe(200);
    // RouterDO now answers first, so every request on the hub host is the stranger's.
    expect(await routedTo(hub)).toBe(stranger);
  });

  it("refuses other accounts once VANITY_SUFFIXES/VANITY_TENANT reserve the hub host", async () => {
    const hub = `finch-${seq++}-${Date.now()}.selfhost.test`;
    const stranger = `user_stranger_${seq++}`;
    const guarded = { ...(env as any), VANITY_SUFFIXES: hub, VANITY_TENANT: OWNER };

    const res = await domainAdd(hub, stranger, hub, guarded);
    expect(res.status).toBe(403);
    // Also covers names under the hub host.
    const sub = await domainAdd(hub, stranger, `x.${hub}`, guarded);
    expect(sub.status).toBe(403);
    // Still unclaimed, so the hub host keeps falling back to the owner.
    expect(await routedTo(hub)).toBeNull();
    expect(await routedTo(`x.${hub}`)).toBeNull();

    // The owner is not locked out by the same setting.
    const own = await domainAdd(hub, OWNER, hub, guarded);
    expect(own.status).toBe(200);
    expect(await routedTo(hub)).toBe(OWNER);
  });
});
