import { describe, it, expect } from "vitest";
import { signToken, verifyToken, type TicketPayload } from "../src/auth";

// The /<service>/<box>/_connect handler in index.ts authenticates the
// agent WS dial by verifying the per-box connect-token (?ct=…). The accept
// predicate is exactly:
//
//   payload && payload.kind === "connect" &&
//   payload.tenant === tenant && payload.service === service &&
//   payload.box === box
//
// We mint connect-tokens the same way api.ts does (signToken with kind:"connect"
// + a 120s exp) and assert the FULL reject matrix: wrong box / tenant /
// service / kind / expiry all fail closed, only the exactly-matching token is
// accepted.

const SECRET = "test-ticket-secret";
const nowSec = () => Math.floor(Date.now() / 1000);

// The resolved route the WS dial landed on.
const ROUTE = { tenant: "org_1", service: "scraper", box: "box-1" };

/** Mint a connect-token exactly as api.ts's join handler does. */
async function mintConnect(
  over: Partial<TicketPayload> = {},
  ttl = 120,
): Promise<string> {
  const payload: TicketPayload = {
    tenant: ROUTE.tenant,
    service: ROUTE.service,
    box: ROUTE.box,
    kind: "connect",
    exp: nowSec() + ttl,
    ...over,
  };
  return signToken(payload, SECRET);
}

/** Mirror index.ts's _connect accept predicate against a presented ?ct token. */
async function accepts(
  ct: string,
  route = ROUTE,
  secret = SECRET,
): Promise<boolean> {
  const payload = ct ? await verifyToken(ct, secret) : null;
  return !!(
    payload &&
    payload.kind === "connect" &&
    payload.tenant === route.tenant &&
    payload.service === route.service &&
    payload.box === route.box
  );
}

describe("connect-token verify — accept matrix", () => {
  it("accepts a connect-token that matches the resolved route exactly", async () => {
    expect(await accepts(await mintConnect())).toBe(true);
  });
});

describe("connect-token verify — reject matrix (fail closed)", () => {
  it("rejects a missing token", async () => {
    expect(await accepts("")).toBe(false);
  });

  it("rejects when the box differs", async () => {
    const ct = await mintConnect({ box: "box-2" });
    expect(await accepts(ct)).toBe(false);
  });

  it("rejects when the tenant differs", async () => {
    const ct = await mintConnect({ tenant: "org_evil" });
    expect(await accepts(ct)).toBe(false);
  });

  it("rejects when the service differs", async () => {
    const ct = await mintConnect({ service: "printer" });
    expect(await accepts(ct)).toBe(false);
  });

  it("rejects a join-kind token presented on the _connect dial", async () => {
    // A valid join ticket (no box binding) must NOT authenticate a WS dial.
    const join = await signToken(
      {
        tenant: ROUTE.tenant,
        service: ROUTE.service,
        kind: "join",
        exp: nowSec() + 3600,
      },
      SECRET,
    );
    expect(await accepts(join)).toBe(false);
  });

  it("rejects a connect-token with no kind field", async () => {
    const ct = await mintConnect({ kind: undefined });
    expect(await accepts(ct)).toBe(false);
  });

  it("rejects an expired connect-token", async () => {
    const ct = await mintConnect({}, -1); // already expired
    expect(await accepts(ct)).toBe(false);
  });

  it("rejects a connect-token signed with the wrong secret", async () => {
    const ct = await signToken(
      {
        tenant: ROUTE.tenant,
        service: ROUTE.service,
        box: ROUTE.box,
        kind: "connect",
        exp: nowSec() + 120,
      },
      "attacker-secret",
    );
    expect(await accepts(ct)).toBe(false);
  });

  it("rejects a tampered connect-token signature", async () => {
    const ct = await mintConnect();
    const [body, sig] = ct.split(".");
    const flipped = sig[0] === "A" ? "B" : "A";
    expect(await accepts(`${body}.${flipped}${sig.slice(1)}`)).toBe(false);
  });

  it("accepts only the matching route when the same token is checked against another route", async () => {
    const ct = await mintConnect(); // bound to ROUTE
    // Same token, different resolved route -> reject.
    expect(
      await accepts(ct, {
        tenant: "org_1",
        service: "scraper",
        box: "box-9",
      }),
    ).toBe(false);
  });
});
