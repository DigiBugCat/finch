import { describe, it, expect } from "vitest";
import {
  genFinchKey,
  hashKey,
  last4,
  signToken,
  verifyToken,
  signAssertion,
  verifyAssertion,
  type TicketPayload,
} from "../src/auth";

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
    appliance: "web-scraper",
    exp: nowSec() + 3600,
    kind: "join",
  });

  it("happy path: a freshly signed ticket verifies and round-trips", async () => {
    const p = basePayload();
    const tok = await signToken(p, SECRET);
    const got = await verifyToken(tok, SECRET);
    expect(got).not.toBeNull();
    expect(got!.tenant).toBe(p.tenant);
    expect(got!.appliance).toBe(p.appliance);
    expect(got!.exp).toBe(p.exp);
    expect(got!.kind).toBe("join");
  });

  it("round-trips a connect ticket with a machine field", async () => {
    const p: TicketPayload = {
      tenant: "t",
      appliance: "a",
      machine: "m",
      kind: "connect",
      exp: nowSec() + 120,
    };
    const got = await verifyToken(await signToken(p, SECRET), SECRET);
    expect(got).not.toBeNull();
    expect(got!.kind).toBe("connect");
    expect(got!.machine).toBe("m");
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
    const bogus = { tenant: "t", appliance: "a", exp: nowSec() + 60, kind: "x" };
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
