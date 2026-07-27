// CONTRACT test: the assertion the web BFF SIGNS must be one the hub VERIFIES.
//
// The web app proves WHICH tenant a control-API call acts as by signing
// {tenant,exp} with the shared FINCH_SERVICE_SECRET (lib/assertion.ts, used by
// lib/hub.ts -> X-Finch-Auth). The hub verifies that exact envelope
// (worker/src/auth.ts verifyAssertion). If the two ever drift — payload shape,
// base64url variant, HMAC inputs — every hub call silently 401s. This test
// imports BOTH sides and asserts they agree, so the drift fails CI not prod.
import { describe, it, expect } from "vitest";
import { signAssertion, ASSERTION_TTL_SECONDS } from "@/lib/assertion";
// The real worker auth runs at runtime (vitest alias -> ../worker/src/auth.ts);
// tsc sees the type shim in test/worker-auth.d.ts. See that file for why.
import {
  verifyAssertion,
  signAssertion as workerSignAssertion,
} from "@worker-auth";

const SECRET = "shared-finch-service-secret-under-test";

describe("web→hub tenant assertion contract", () => {
  it("the hub accepts an assertion the web BFF signed (same secret)", async () => {
    const token = await signAssertion("org_abc123", SECRET);
    const tenant = await verifyAssertion(token, SECRET);
    expect(tenant).toBe("org_abc123");
  });

  it("the hub rejects an assertion signed with a different secret", async () => {
    const token = await signAssertion("org_abc123", SECRET);
    const tenant = await verifyAssertion(token, "a-different-secret");
    expect(tenant).toBeNull();
  });

  it("the hub rejects an expired assertion", async () => {
    // Sign with a `now` far enough in the past that exp (now + TTL) is already
    // behind the wall clock — verifyAssertion's exp check must reject it.
    const longAgo = Math.floor(Date.now() / 1000) - (ASSERTION_TTL_SECONDS + 60);
    const token = await signAssertion("org_abc123", SECRET, longAgo);
    const tenant = await verifyAssertion(token, SECRET);
    expect(tenant).toBeNull();
  });

  it("the web signer and the hub signer produce byte-identical envelopes", async () => {
    // Both sides share the same wire format; with the same payload (pinned now)
    // the envelopes must be identical. This pins the format, not just round-trip.
    const now = 1_700_000_000;
    const webToken = await signAssertion("org_abc123", SECRET, now);
    const hubToken = await workerSignAssertion(
      { tenant: "org_abc123", exp: now + ASSERTION_TTL_SECONDS },
      SECRET,
    );
    expect(webToken).toBe(hubToken);
  });

  it("the hub accepts a tenant id that is a bare user id (personal tenant)", async () => {
    const token = await signAssertion("user_personal_tenant", SECRET);
    expect(await verifyAssertion(token, SECRET)).toBe("user_personal_tenant");
  });

  it("pins the accepted tenant-id boundary and rejects malformed identities", async () => {
    const longestTenant = "t".repeat(128);
    expect(await verifyAssertion(await signAssertion(longestTenant, SECRET), SECRET)).toBe(longestTenant);

    for (const tenant of [
      "",
      " ",
      "tenant.with.dots",
      "t".repeat(129),
      null as unknown as string,
      { toString: () => "user_coerced" } as unknown as string,
    ]) {
      await expect(signAssertion(tenant, SECRET, 1)).rejects.toThrow("invalid assertion tenant");
    }
  });

  it("refuses missing key material and non-finite or overflowing timestamps", async () => {
    for (const secret of ["", null as unknown as string, { toString: () => SECRET } as unknown as string]) {
      await expect(signAssertion("user_1", secret, 1)).rejects.toThrow(
        "assertion secret is required",
      );
    }
    for (const now of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(signAssertion("user_1", SECRET, now)).rejects.toThrow(
        "invalid assertion timestamp",
      );
    }
  });

  it("uses a distinct verified audience for user-scoped assertions", async () => {
    const token = await signAssertion("user_1", "sëcret-安全", undefined, "user");
    const verifyWithKind = verifyAssertion as unknown as (
      token: string,
      secret: string,
      expectedKind: string,
    ) => Promise<string | null>;
    expect(await verifyAssertion(token, "sëcret-安全")).toBeNull();
    expect(await verifyWithKind(token, "sëcret-安全", "user")).toBe("user_1");
  });

  it("does not let runtime callers mint arbitrary assertion audiences", async () => {
    await expect(
      signAssertion("user_1", SECRET, undefined, "cli" as "user"),
    ).rejects.toThrow("invalid assertion kind");
  });
});
