import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import worker from "../src/index";
import { signAssertion, verifyToken } from "../src/auth";
import {
  AVIARY_PROTOCOL,
  AVIARY_TTL_MS,
  resolveAviaryPublicOrigin,
} from "../src/aviary-enrollment-do";
import { aviaryVerificationBaseForTest } from "../src/aviary-enrollment-api";

const TENANT = env.DEFAULT_TENANT!;
const SERVICE_SECRET = env.FINCH_SERVICE_SECRET;
const BASE = "http://hub.test";
let seq = 0;

type KeyMaterial = {
  pair: CryptoKeyPair;
  publicKey: string;
  fingerprint: string;
};

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(raw: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function keys(): Promise<KeyMaterial> {
  const pair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    pair,
    publicKey: b64url(raw),
    fingerprint: `SHA256:${hex(await sha256(raw)).slice(0, 32)}`,
  };
}

function manifest(
  key: KeyMaterial,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const n = ++seq;
  const value: Record<string, unknown> = {
    service: `Aviary Test ${n}`,
    app_path: `aviary-test-${n}`,
    routes: ["/api/v1", "/birdz", "/mcp"],
    edge_auth: "key",
    machine: `test-box-${n}`,
    machine_fingerprint: key.fingerprint,
    expected_tenant: TENANT,
    ...overrides,
  };
  if (value.edge_auth === "public" && !("expected_tenant" in overrides)) {
    delete value.expected_tenant;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const escaped: Record<string, string> = {
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  };
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => escaped[ch]);
}

async function digest(value: unknown): Promise<string> {
  return hex(await sha256(canonicalJson(value)));
}

async function call(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        host: "hub.test",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env as any,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function tenantHeaders(tenant = TENANT): Promise<Record<string, string>> {
  return {
    "X-Finch-Service": SERVICE_SECRET,
    "X-Finch-Auth": await signAssertion(
      { tenant, exp: Math.floor(Date.now() / 1000) + 300 },
      SERVICE_SECRET,
    ),
  };
}

async function start(
  key: KeyMaterial,
  m: Record<string, unknown>,
  ip?: string,
): Promise<{ response: Response; body: any; manifestSha256: string }> {
  const manifestSha256 = await digest(m);
  const response = await call(
    "/api/aviary/device/start",
    {
      protocol: AVIARY_PROTOCOL,
      manifest: m,
      manifest_sha256: manifestSha256,
      device_public_key: key.publicKey,
    },
    {
      "cf-connecting-ip": ip || `203.0.113.${(seq % 240) + 1}`,
      "user-agent": "finch-enrollment-test/1",
    },
  );
  return { response, body: await response.clone().json(), manifestSha256 };
}

async function proof(
  key: KeyMaterial,
  deviceCode: string,
  manifestSha256: string,
  deliveryID?: string,
): Promise<Record<string, string>> {
  const statement = new TextEncoder().encode(
    deliveryID
      ? `${AVIARY_PROTOCOL}\nack\n${deviceCode}\n${manifestSha256}\n${deliveryID}`
      : `${AVIARY_PROTOCOL}\npoll\n${deviceCode}\n${manifestSha256}`,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, key.pair.privateKey, statement),
  );
  return { alg: "Ed25519", public_key: key.publicKey, signature: b64url(signature) };
}

async function ack(
  key: KeyMaterial,
  started: any,
  manifestSha256: string,
  deliveryID: string,
): Promise<Response> {
  return call("/api/aviary/device/poll", {
    protocol: AVIARY_PROTOCOL,
    device_code: started.device_code,
    manifest_sha256: manifestSha256,
    ack_delivery: deliveryID,
    proof: await proof(key, started.device_code, manifestSha256, deliveryID),
  });
}

async function poll(
  key: KeyMaterial,
  started: any,
  manifestSha256: string,
): Promise<Response> {
  return call("/api/aviary/device/poll", {
    protocol: AVIARY_PROTOCOL,
    device_code: started.device_code,
    manifest_sha256: manifestSha256,
    proof: await proof(key, started.device_code, manifestSha256),
  });
}

describe("Aviary service device enrollment", () => {
  it("binds start, describe, private approval, one refresh grant, and replay", async () => {
    const key = await keys();
    const m = manifest(key);
    const begun = await start(key, m);
    expect(begun.response.status).toBe(200);
    expect(begun.body.device_code).toMatch(/^[a-f0-9]{64}$/);
    expect(begun.body.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(begun.body.verification_uri).toBe("https://web.test/aviary/authorize");
    expect(begun.body.manifest_sha256).toBe(begun.manifestSha256);
    expect(begun.body.public_approval_required).toBe(false);

    const describe = await call(
      "/api/aviary/device/describe",
      { user_code: begun.body.user_code },
      await tenantHeaders(),
    );
    expect(describe.status).toBe(200);
    const shown = (await describe.json()) as any;
    expect(shown.status).toBe("pending");
    expect(shown.manifest).toEqual(m);
    expect(shown.req_ua).toBe("finch-enrollment-test/1");
    expect(JSON.stringify(shown)).not.toContain(begun.body.device_code);
    expect(JSON.stringify(shown)).not.toContain("refresh_token");

    const approve = await call(
      "/api/aviary/device/approve",
      { user_code: begun.body.user_code, approver: "user_test" },
      await tenantHeaders(),
    );
    expect(approve.status, await approve.clone().text()).toBe(200);

    const first = await poll(key, begun.body, begun.manifestSha256);
    expect(first.status).toBe(200);
    const approved = (await first.json()) as any;
    expect(approved.status).toBe("approved");
    expect(approved.delivery_id).toMatch(/^[a-f0-9]{32}$/);
    expect(approved.grant).toMatchObject({
      tenant: TENANT,
      service: m.app_path,
      box: m.machine,
      manifest_sha256: begun.manifestSha256,
      edge_auth: "key",
      routes: m.routes,
      machine_fingerprint: key.fingerprint,
      public_approved: false,
    });
    expect(approved.grant.public_url).toBe(
      `https://relay.test/${encodeURIComponent(String(m.app_path))}/mcp`,
    );
    const token = await verifyToken(approved.grant.refresh_token, env.TICKET_SECRET);
    expect(token).toMatchObject({
      tenant: TENANT,
      service: m.app_path,
      box: m.machine,
      kind: "refresh",
    });

    const replay = await poll(key, begun.body, begun.manifestSha256);
    expect(replay.status).toBe(200);
    const redelivered = (await replay.json()) as any;
    expect(redelivered.delivery_id).toBe(approved.delivery_id);
    expect(redelivered.grant.refresh_token).toBe(approved.grant.refresh_token);
    const acknowledged = await ack(
      key,
      begun.body,
      begun.manifestSha256,
      approved.delivery_id,
    );
    expect(await acknowledged.json()).toEqual({ status: "consumed" });
    const ackReplay = await ack(
      key,
      begun.body,
      begun.manifestSha256,
      approved.delivery_id,
    );
    expect(await ackReplay.json()).toEqual({ status: "consumed" });
    expect(await (await poll(key, begun.body, begun.manifestSha256)).json()).toEqual({
      status: "denied",
      detail: "enrollment grant already consumed",
    });
    const completed = await call(
      "/api/aviary/device/describe",
      { user_code: begun.body.user_code },
      await tenantHeaders(),
    );
    expect((await completed.json() as any).status).toBe("approved");
  });

  it("fails closed for invalid explicit public origins", () => {
    expect(
      resolveAviaryPublicOrigin(
        "https://relay.test/hidden",
        "tenant.finchmcp.com",
        "https://hub.test",
      ),
    ).toBeNull();
    expect(
      resolveAviaryPublicOrigin(
        "https://user:pass@relay.test",
        "tenant.finchmcp.com",
        "https://hub.test",
      ),
    ).toBeNull();
    expect(
      resolveAviaryPublicOrigin("", "tenant.finchmcp.com", "https://hub.test"),
    ).toBeNull();
  });

  it("requires a separate, explicit public approval bit", async () => {
    const key = await keys();
    const m = manifest(key, { edge_auth: "public" });
    const begun = await start(key, m);
    expect(begun.response.status).toBe(200);
    expect(begun.body.public_approval_required).toBe(true);

    const refused = await call(
      "/api/aviary/device/approve",
      { user_code: begun.body.user_code, public_approved: false },
      await tenantHeaders(),
    );
    expect(refused.status).toBe(400);
    expect((await refused.json() as any).error.code).toBe("public_approval_required");

    const approved = await call(
      "/api/aviary/device/approve",
      { user_code: begun.body.user_code, public_approved: true },
      await tenantHeaders(),
    );
    expect(approved.status).toBe(200);
    const result = (await (await poll(key, begun.body, begun.manifestSha256)).json()) as any;
    expect(result.grant.public_approved).toBe(true);
    expect(result.grant.edge_auth).toBe("public");
  });

  it("supports deliberate denial without releasing a credential", async () => {
    const key = await keys();
    const begun = await start(key, manifest(key));
    const denied = await call(
      "/api/aviary/device/deny",
      { user_code: begun.body.user_code, reason: "not my machine" },
      await tenantHeaders(),
    );
    expect(denied.status).toBe(200);
    const result = await poll(key, begun.body, begun.manifestSha256);
    expect(await result.json()).toEqual({ status: "denied", detail: "not my machine" });
  });

  it("supports approver binding and enforces an optional expected tenant", async () => {
    const missingKey = await keys();
    const missingManifest = manifest(missingKey);
    delete missingManifest.expected_tenant;
    const missing = await start(missingKey, missingManifest);
    expect(missing.response.status).toBe(200);
    const bound = await call(
      "/api/aviary/device/approve",
      { user_code: missing.body.user_code },
      await tenantHeaders(),
    );
    expect(bound.status).toBe(200);
    expect((await bound.json() as any).approved_tenant).toBe(TENANT);

    const key = await keys();
    const begun = await start(key, manifest(key));
    const wrongTenant = "tenant_other";
    const described = await call(
      "/api/aviary/device/describe",
      { user_code: begun.body.user_code },
      await tenantHeaders(wrongTenant),
    );
    expect(described.status).toBe(403);
    expect((await described.json() as any).error.code).toBe("tenant_mismatch");
    const wrongApproval = await call(
      "/api/aviary/device/approve",
      { user_code: begun.body.user_code },
      await tenantHeaders(wrongTenant),
    );
    expect(wrongApproval.status).toBe(403);
    expect((await wrongApproval.json() as any).error.code).toBe("tenant_mismatch");

    const rightApproval = await call(
      "/api/aviary/device/approve",
      { user_code: begun.body.user_code },
      await tenantHeaders(),
    );
    expect(rightApproval.status).toBe(200);
  });

  it("makes duplicate concurrent approval idempotent without compensation races", async () => {
    const key = await keys();
    const m = manifest(key);
    const begun = await start(key, m);
    const [a, b] = await Promise.all([
      call(
        "/api/aviary/device/approve",
        { user_code: begun.body.user_code, approver: "admin-a" },
        await tenantHeaders(),
      ),
      call(
        "/api/aviary/device/approve",
        { user_code: begun.body.user_code, approver: "admin-b" },
        await tenantHeaders(),
      ),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const granted = (await (await poll(key, begun.body, begun.manifestSha256)).json()) as any;
    expect(granted.status).toBe("approved");
    const tenantStub = env.TENANT.get(env.TENANT.idFromName(TENANT));
    const state = await tenantStub.fetch("https://tenant/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "getState" }),
    });
    expect((await state.json() as any).services.some((s: any) => s.id === m.app_path)).toBe(true);
  });

  it("rejects changed digest, proof key, and signature", async () => {
    const key = await keys();
    const other = await keys();
    const begun = await start(key, manifest(key));
    const validProof = await proof(key, begun.body.device_code, begun.manifestSha256);

    const changedDigest = await call("/api/aviary/device/poll", {
      protocol: AVIARY_PROTOCOL,
      device_code: begun.body.device_code,
      manifest_sha256: "0".repeat(64),
      proof: validProof,
    });
    expect(changedDigest.status).toBe(409);
    expect((await changedDigest.json() as any).error.code).toBe("manifest_mismatch");

    const changedKey = await call("/api/aviary/device/poll", {
      protocol: AVIARY_PROTOCOL,
      device_code: begun.body.device_code,
      manifest_sha256: begun.manifestSha256,
      proof: { ...validProof, public_key: other.publicKey },
    });
    expect(changedKey.status).toBe(401);

    const badSignature = await call("/api/aviary/device/poll", {
      protocol: AVIARY_PROTOCOL,
      device_code: begun.body.device_code,
      manifest_sha256: begun.manifestSha256,
      proof: { ...validProof, signature: b64url(new Uint8Array(64)) },
    });
    expect(badSignature.status).toBe(401);
  });

  it("denies an existing app-path collision and never chooses a suffix", async () => {
    const key = await keys();
    const appPath = `collision-${++seq}`;
    const legacy = await call(
      "/api/enroll",
      { name: appPath },
      await tenantHeaders(),
    );
    expect(legacy.status).toBe(200);
    expect((await legacy.json() as any).id).toBe(appPath);
    const begun = await start(key, manifest(key, { app_path: appPath }));
    const approval = await call(
      "/api/aviary/device/approve",
      { user_code: begun.body.user_code },
      await tenantHeaders(),
    );
    expect(approval.status).toBe(409);
    expect((await approval.json() as any).error.code).toBe("app_path_collision");
    expect(await (await poll(key, begun.body, begun.manifestSha256)).json()).toMatchObject({
      status: "denied",
      detail: "app_path_collision",
    });
  });

  it("cannot widen an approved path or turn a private Aviary service public", async () => {
    const key = await keys();
    const appPath = `no-widen-${++seq}`;
    const m = manifest(key, { app_path: appPath, routes: ["/mcp"] });
    const begun = await start(key, m);
    expect((await call(
      "/api/aviary/device/approve",
      { user_code: begun.body.user_code },
      await tenantHeaders(),
    )).status).toBe(200);

    const widenedKey = await keys();
    const widened = manifest(widenedKey, {
      app_path: appPath,
      machine: m.machine,
      routes: ["/admin", "/mcp"],
    });
    const second = await start(widenedKey, widened);
    expect(second.response.status).toBe(200);
    const wideningApproval = await call(
      "/api/aviary/device/approve",
      { user_code: second.body.user_code },
      await tenantHeaders(),
    );
    expect(wideningApproval.status).toBe(409);
    expect((await wideningApproval.json() as any).error.code).toBe("app_path_collision");

    const tenantStub = env.TENANT.get(env.TENANT.idFromName(TENANT));
    const publicFlip = await tenantStub.fetch("https://tenant/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "setAuth", service: appPath, mode: "public" }),
    });
    const flipBody = await publicFlip.json();
    expect(flipBody).toEqual({
      ok: false,
      error: "aviary service requires a new public-access approval",
    });

    const relayHeaders = await tenantHeaders();
    const blocked = await call(`/${appPath}/admin`, undefined, relayHeaders);
    expect(blocked.status).toBe(404);
    const allowed = await call(`/${appPath}/mcp`, undefined, relayHeaders);
    expect(allowed.status).toBe(503); // route allowed, but no live relay in this test
  });

  it("recovers a lost local credential with same routes and supersedes the old epoch only after ACK", async () => {
    const firstKey = await keys();
    const appPath = `recover-${++seq}`;
    const firstManifest = manifest(firstKey, {
      app_path: appPath,
      service: "Recoverable Service",
      routes: ["/mcp"],
      machine: "recovery-box",
    });
    const first = await start(firstKey, firstManifest);
    expect((await call(
      "/api/aviary/device/approve",
      { user_code: first.body.user_code },
      await tenantHeaders(),
    )).status).toBe(200);
    const delivered1 = (await (await poll(firstKey, first.body, first.manifestSha256)).json()) as any;
    expect((await ack(
      firstKey,
      first.body,
      first.manifestSha256,
      delivered1.delivery_id,
    )).status).toBe(200);
    expect((await call("/refresh", { refreshToken: delivered1.grant.refresh_token })).status).toBe(200);

    const secondKey = await keys();
    const secondManifest = manifest(secondKey, {
      app_path: appPath,
      service: "Recoverable Service",
      routes: ["/mcp"],
      machine: "recovery-box",
    });
    const second = await start(secondKey, secondManifest);
    expect(second.response.status).toBe(200);
    const reapproved = await call(
      "/api/aviary/device/approve",
      { user_code: second.body.user_code },
      await tenantHeaders(),
    );
    expect(reapproved.status, await reapproved.clone().text()).toBe(200);
    const delivered2 = (await (await poll(secondKey, second.body, second.manifestSha256)).json()) as any;

    // Rotation is reserved, not activated, until the new credential is safely
    // persisted and ACKed. The old token keeps working during that window.
    expect((await call("/refresh", { refreshToken: delivered1.grant.refresh_token })).status).toBe(200);
    expect((await call("/refresh", { refreshToken: delivered2.grant.refresh_token })).status).toBe(403);
    expect((await ack(
      secondKey,
      second.body,
      second.manifestSha256,
      delivered2.delivery_id,
    )).status).toBe(200);
    expect((await call("/refresh", { refreshToken: delivered2.grant.refresh_token })).status).toBe(200);
    const superseded = await call("/refresh", { refreshToken: delivered1.grant.refresh_token });
    expect(superseded.status).toBe(403);
    expect(await superseded.json()).toEqual({ error: "refresh credential superseded" });

    // A dashboard revocation removes the registry entry, so every old refresh
    // fails closed. A later deliberate enrollment can recreate the exact box.
    const tenantStub = env.TENANT.get(env.TENANT.idFromName(TENANT));
    await tenantStub.fetch("https://tenant/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "release", id: appPath }),
    });
    expect((await call("/refresh", { refreshToken: delivered2.grant.refresh_token })).status).toBe(403);

    const thirdKey = await keys();
    const thirdManifest = manifest(thirdKey, {
      app_path: appPath,
      service: "Recoverable Service",
      routes: ["/mcp"],
      machine: "recovery-box",
    });
    const third = await start(thirdKey, thirdManifest);
    expect((await call(
      "/api/aviary/device/approve",
      { user_code: third.body.user_code },
      await tenantHeaders(),
    )).status).toBe(200);
    const delivered3 = (await (await poll(thirdKey, third.body, third.manifestSha256)).json()) as any;
    expect((await ack(
      thirdKey,
      third.body,
      third.manifestSha256,
      delivered3.delivery_id,
    )).status).toBe(200);
    expect((await call("/refresh", { refreshToken: delivered3.grant.refresh_token })).status).toBe(200);
  });

  it("expires and erases an abandoned approved plaintext grant", async () => {
    const key = await keys();
    const begun = await start(key, manifest(key));
    expect((await call(
      "/api/aviary/device/approve",
      { user_code: begun.body.user_code },
      await tenantHeaders(),
    )).status).toBe(200);

    const stub = env.AVIARY_ENROLLMENT.get(env.AVIARY_ENROLLMENT.idFromName("global"));
    await stub.fetch("https://enrollment/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "describe",
        userCode: begun.body.user_code,
        now: Date.now() + AVIARY_TTL_MS + 1,
      }),
    });
    const runInDO = runInDurableObject as unknown as (
      stub: DurableObjectStub,
      callback: (instance: any) => unknown,
    ) => Promise<any>;
    const stored = await runInDO(stub, (instance) =>
      instance.ctx.storage.sql
        .exec(
          "SELECT state,grant_json FROM aviary_enrollments WHERE device_code=?",
          begun.body.device_code,
        )
        .toArray()[0],
    );
    expect(stored.state).toBe("expired");
    expect(stored.grant_json).toBeNull();
  });

  it("accepts 63-character app paths and rejects 64", async () => {
    const acceptedKey = await keys();
    const accepted = await start(
      acceptedKey,
      manifest(acceptedKey, { app_path: `a${"b".repeat(62)}` }),
    );
    expect(accepted.response.status).toBe(200);

    const rejectedKey = await keys();
    const tooLong = manifest(rejectedKey, { app_path: `a${"b".repeat(63)}` });
    const rejected = await start(rejectedKey, tooLong);
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error.code).toBe("invalid_manifest");
  });

  it("fails closed for unauthenticated describe/decisions and oversized bodies", async () => {
    const describe = await call("/api/aviary/device/describe", { user_code: "ABCD-EFGH" });
    expect(describe.status).toBe(401);
    const huge = await call("/api/aviary/device/start", { padding: "x".repeat(17 * 1024) });
    expect(huge.status).toBe(400);
    expect((await huge.json() as any).error.code).toBe("invalid_json");
  });

  it("pins verification origins and persistently throttles start floods per IP", async () => {
    expect(
      aviaryVerificationBaseForTest(
        { WEB_URL: "https://evil.example" } as any,
        "finchmcp.com",
      ),
    ).toBeNull();
    expect(
      aviaryVerificationBaseForTest(
        {
          WEB_URL: "https://dashboard.example",
          AVIARY_VERIFICATION_ORIGINS: "https://dashboard.example",
        } as any,
        "finchmcp.com",
      ),
    ).toBe("https://dashboard.example");

    const ip = `198.51.100.${(Date.now() % 200) + 1}`;
    for (let i = 0; i < 10; i++) {
      const key = await keys();
      expect((await start(key, manifest(key), ip)).response.status).toBe(200);
    }
    const blockedKey = await keys();
    const blocked = await start(blockedKey, manifest(blockedKey), ip);
    expect(blocked.response.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limited");
  });
});
