import { describe, it, expect } from "vitest";
import {
  callerAssertionJwks,
  genFinchKey,
  hashKey,
  last4,
  signCallerAssertion,
  selfTestCallerAssertion,
  signToken,
  verifyToken,
  signAssertion,
  verifyAssertion,
  verifyCallerAssertion,
  type CallerAssertionClaims,
  type CallerAssertionJwk,
  type TicketPayload,
} from "../src/auth";
import assertionVector from "./assertion-vectors.json";

// These run inside workerd (vitest-pool-workers), so crypto.subtle and
// crypto.getRandomValues are the genuine runtime primitives auth.ts uses.

const SECRET = "test-ticket-secret";
const nowSec = () => Math.floor(Date.now() / 1000);

describe("genFinchKey", () => {
  it("mints a finch_-prefixed key", () => {
    const k = genFinchKey();
    expect(k.startsWith("finch_")).toBe(true);
  });

  it("is unique across mints (random)", () => {
    const keys = new Set(Array.from({ length: 100 }, () => genFinchKey()));
    expect(keys.size).toBe(100);
  });

  it("encodes 32 random bytes as base64url (no padding, url-safe)", () => {
    const body = genFinchKey().slice("finch_".length);
    // base64url(32 bytes) is 43 chars (ceil(32*4/3) with padding stripped).
    expect(body.length).toBe(43);
    expect(body).not.toContain("=");
    expect(body).not.toContain("+");
    expect(body).not.toContain("/");
    expect(/^[A-Za-z0-9_-]+$/.test(body)).toBe(true);
  });
});

describe("hashKey", () => {
  it("is deterministic: same input -> same sha-256 hex", async () => {
    const k = genFinchKey();
    const h1 = await hashKey(k);
    const h2 = await hashKey(k);
    expect(h1).toBe(h2);
  });

  it("produces a 64-char lowercase hex sha-256 digest", async () => {
    const h = await hashKey("finch_whatever");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different inputs", async () => {
    const a = await hashKey(genFinchKey());
    const b = await hashKey(genFinchKey());
    expect(a).not.toBe(b);
  });

  it("matches a known SHA-256 vector", async () => {
    // sha256("abc") — canonical NIST vector.
    expect(await hashKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("last4", () => {
  it("returns the trailing 4 chars", () => {
    expect(last4("finch_abcd1234")).toBe("1234");
  });
});

describe("signToken / verifyToken (join + connect tickets)", () => {
  const basePayload = (): TicketPayload => ({
    tenant: "tenant-1",
    service: "web-scraper",
    exp: nowSec() + 3600,
    kind: "join",
  });

  it("happy path: a freshly signed ticket verifies and round-trips", async () => {
    const p = basePayload();
    const tok = await signToken(p, SECRET);
    const got = await verifyToken(tok, SECRET);
    expect(got).not.toBeNull();
    expect(got!.tenant).toBe(p.tenant);
    expect(got!.service).toBe(p.service);
    expect(got!.exp).toBe(p.exp);
    expect(got!.kind).toBe("join");
  });

  it("round-trips a connect ticket with a box field", async () => {
    const p: TicketPayload = {
      tenant: "t",
      service: "a",
      box: "m",
      kind: "connect",
      exp: nowSec() + 120,
    };
    const got = await verifyToken(await signToken(p, SECRET), SECRET);
    expect(got).not.toBeNull();
    expect(got!.kind).toBe("connect");
    expect(got!.box).toBe("m");
  });

  it("rejects a tampered signature", async () => {
    const tok = await signToken(basePayload(), SECRET);
    const [body, sig] = tok.split(".");
    // Flip one char in the signature segment.
    const flipped = sig[0] === "A" ? "B" : "A";
    const tampered = `${body}.${flipped}${sig.slice(1)}`;
    expect(await verifyToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a tampered body (payload changed, old sig)", async () => {
    const tok = await signToken(basePayload(), SECRET);
    const sig = tok.split(".")[1];
    // Re-encode a payload claiming a different tenant, keep the old signature.
    const forgedBody = btoa(
      JSON.stringify({ ...basePayload(), tenant: "attacker" }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyToken(`${forgedBody}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects an expired ticket", async () => {
    const p = { ...basePayload(), exp: nowSec() - 1 };
    const tok = await signToken(p, SECRET);
    expect(await verifyToken(tok, SECRET)).toBeNull();
  });

  it("rejects verification under the wrong secret", async () => {
    const tok = await signToken(basePayload(), SECRET);
    expect(await verifyToken(tok, "wrong-secret")).toBeNull();
  });

  it("rejects malformed tickets (no dot / empty halves)", async () => {
    expect(await verifyToken("nodothere", SECRET)).toBeNull();
    expect(await verifyToken(".sigonly", SECRET)).toBeNull();
    expect(await verifyToken("bodyonly.", SECRET)).toBeNull();
    expect(await verifyToken("", SECRET)).toBeNull();
  });

  it("rejects a ticket with an invalid kind", async () => {
    // Hand-build a payload with a bogus kind, signed correctly, to prove the
    // shape validation (not just the HMAC) rejects it.
    const bogus = { tenant: "t", service: "a", exp: nowSec() + 60, kind: "x" };
    const body = btoa(JSON.stringify(bogus))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    // sign the body the same way signToken does, via a known-good join token's
    // signer: easiest is to sign a real payload then swap the body in is invalid
    // (HMAC won't match). So instead assert verifyToken of a correctly-signed
    // bogus-kind token is null by signing through the public API with a cast.
    const tok = await signToken(bogus as unknown as TicketPayload, SECRET);
    expect(tok.startsWith(body + ".")).toBe(true); // body encoded as expected
    expect(await verifyToken(tok, SECRET)).toBeNull(); // bogus kind rejected
  });
});

describe("signAssertion / verifyAssertion (tenant assertion)", () => {
  it("happy path: returns the tenant id", async () => {
    const tok = await signAssertion(
      { tenant: "org_123", exp: nowSec() + 60 },
      SECRET,
    );
    expect(await verifyAssertion(tok, SECRET)).toBe("org_123");
  });

  it("rejects an expired assertion", async () => {
    const tok = await signAssertion(
      { tenant: "org_123", exp: nowSec() - 1 },
      SECRET,
    );
    expect(await verifyAssertion(tok, SECRET)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const tok = await signAssertion(
      { tenant: "org_123", exp: nowSec() + 60 },
      SECRET,
    );
    const [body, sig] = tok.split(".");
    const flipped = sig[0] === "A" ? "B" : "A";
    expect(
      await verifyAssertion(`${body}.${flipped}${sig.slice(1)}`, SECRET),
    ).toBeNull();
  });

  it("rejects the wrong secret and empty input", async () => {
    const tok = await signAssertion(
      { tenant: "org_123", exp: nowSec() + 60 },
      SECRET,
    );
    expect(await verifyAssertion(tok, "nope")).toBeNull();
    expect(await verifyAssertion("", SECRET)).toBeNull();
    expect(await verifyAssertion(tok, "")).toBeNull();
  });
});

async function assertionKey(kid: string): Promise<CallerAssertionJwk> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return {
    ...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    kid,
    alg: "ES256",
    use: "sig",
  } as CallerAssertionJwk;
}

function callerClaims(over: Partial<CallerAssertionClaims> = {}): CallerAssertionClaims {
  const now = nowSec();
  return {
    iss: "https://finch.test",
    sub: "key:k_123",
    aud: "finch:tenant-1:service-1",
    tenant: "tenant-1",
    service: "service-1",
    auth_method: "finch_key",
    method: "POST",
    upstream_path: "/api/v1/tools/search?limit=5",
    public_path: "/service-1/api/v1/tools/search",
    body_sha256: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    iat: now,
    nbf: now - 5,
    exp: now + 60,
    jti: crypto.randomUUID(),
    key_id: "k_123",
    key_label: "integration",
    actor: "user_123",
    ...over,
  };
}

describe("ES256 caller assertions", () => {
  it("verifies the shared static cross-language contract vector", async () => {
    const got = await verifyCallerAssertion(
      assertionVector.token,
      assertionVector.jwks as { keys: CallerAssertionJwk[] },
      {
        now: assertionVector.now,
        issuer: assertionVector.claims.iss,
        audience: assertionVector.claims.aud,
        tenant: assertionVector.claims.tenant,
        service: assertionVector.claims.service,
        method: assertionVector.claims.method,
        upstreamPath: assertionVector.claims.upstream_path,
        publicPath: assertionVector.claims.public_path,
        bodySha256: assertionVector.claims.body_sha256,
      },
    );
    expect(got).toEqual(assertionVector.claims);
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(assertionVector.request_body),
      ),
    );
    let binary = "";
    for (const byte of digest) binary += String.fromCharCode(byte);
    expect(
      btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    ).toBe(assertionVector.claims.body_sha256);
  });

  it("publishes only public JWK material and verifies all bound claims", async () => {
    const privateKey = await assertionKey("assert-2026-a");
    const config = {
      activeKid: privateKey.kid,
      privateJwks: JSON.stringify({ keys: [privateKey] }),
    };
    const claims = callerClaims();
    const token = await signCallerAssertion(claims, config);
    const jwks = callerAssertionJwks(config);

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kid).toBe("assert-2026-a");
    expect(jwks.keys[0].d).toBeUndefined();
    expect(jwks.keys[0].key_ops).toBeUndefined();

    const verified = await verifyCallerAssertion(token, jwks, {
      issuer: claims.iss,
      audience: claims.aud,
      tenant: claims.tenant,
      service: claims.service,
      method: claims.method,
      upstreamPath: claims.upstream_path,
      publicPath: claims.public_path,
      bodySha256: claims.body_sha256,
    });
    expect(verified).toEqual(claims);
    expect(verified!.exp - verified!.iat).toBe(60);

    expect(
      await verifyCallerAssertion(token, jwks, {
        audience: "finch:tenant-1:wrong-service",
      }),
    ).toBeNull();
    expect(
      await verifyCallerAssertion(token, jwks, { method: "DELETE" }),
    ).toBeNull();
    expect(
      await verifyCallerAssertion(token, jwks, { upstreamPath: "/other" }),
    ).toBeNull();
    expect(
      await verifyCallerAssertion(token, jwks, { bodySha256: "different" }),
    ).toBeNull();
  });

  it("rejects tampering and expiry", async () => {
    const privateKey = await assertionKey("assert-2026-tamper");
    const config = {
      activeKid: privateKey.kid,
      privateJwks: JSON.stringify({ keys: [privateKey] }),
    };
    const claims = callerClaims();
    const token = await signCallerAssertion(claims, config);
    const jwks = callerAssertionJwks(config);
    const [header, payload, signature] = token.split(".");
    const flipped = signature[0] === "A" ? "B" : "A";
    expect(
      await verifyCallerAssertion(
        `${header}.${payload}.${flipped}${signature.slice(1)}`,
        jwks,
      ),
    ).toBeNull();
    expect(
      await verifyCallerAssertion(token, jwks, { now: claims.exp }),
    ).toBeNull();
  });

  it("rotates active kid without dropping verification of the retiring key", async () => {
    const a = await assertionKey("assert-2026-old");
    const b = await assertionKey("assert-2026-new");
    const privateJwks = JSON.stringify({ keys: [a, b] });
    const oldToken = await signCallerAssertion(callerClaims(), {
      activeKid: a.kid,
      privateJwks,
    });
    const newToken = await signCallerAssertion(callerClaims(), {
      activeKid: b.kid,
      privateJwks,
    });
    const jwks = callerAssertionJwks({ privateJwks });

    const decodeHeader = (token: string) =>
      JSON.parse(
        atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")),
      );
    expect(decodeHeader(oldToken).kid).toBe(a.kid);
    expect(decodeHeader(newToken).kid).toBe(b.kid);
    expect(await verifyCallerAssertion(oldToken, jwks)).not.toBeNull();
    expect(await verifyCallerAssertion(newToken, jwks)).not.toBeNull();
  });

  it("self-tests the active private key against the emitted public JWKS", async () => {
    const active = await assertionKey("assert-2026-self-test");
    const config = {
      activeKid: active.kid,
      privateJwks: JSON.stringify({ keys: [active] }),
    };
    await expect(
      selfTestCallerAssertion(config, "https://finch.test"),
    ).resolves.toBe(active.kid);

    const publicOnly = { ...active };
    delete publicOnly.d;
    await expect(
      selfTestCallerAssertion(
        {
          activeKid: "assert-2026-public-only",
          privateJwks: JSON.stringify({
            keys: [{ ...publicOnly, kid: "assert-2026-public-only" }],
          }),
        },
        "https://finch.test",
      ),
    ).rejects.toThrow(/private component/);
    await expect(
      selfTestCallerAssertion(
        { activeKid: "missing", privateJwks: config.privateJwks },
        "https://finch.test",
      ),
    ).rejects.toThrow(/active assertion key not found/);
  });
});
