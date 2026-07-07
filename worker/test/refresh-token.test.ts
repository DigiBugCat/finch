import { describe, it, expect } from "vitest";
import { signToken, verifyToken, type TicketPayload } from "../src/auth";

// /refresh trades a long-lived per-box REFRESH token for a fresh
// connect-token, so the box never re-uses the one-shot join ticket (the bug
// that dropped a freshly-joined box ~2min in: the agent re-joined with the
// burned ticket and 409'd forever).
//
// handleRefresh's accept predicate is exactly:
//   payload && payload.kind === "refresh" && payload.box
// and the _connect handler still requires kind === "connect". These tests pin
// the kind-separation so a token minted for one plane can never be replayed on
// another (cross-grant confusion), which is the whole security property.

const SECRET = "test-ticket-secret";
const nowSec = () => Math.floor(Date.now() / 1000);
const ROUTE = { tenant: "org_1", service: "scraper", box: "box-1" };

async function mint(
  over: Partial<TicketPayload> = {},
  ttl = 30 * 24 * 60 * 60,
): Promise<string> {
  const payload: TicketPayload = {
    tenant: ROUTE.tenant,
    service: ROUTE.service,
    box: ROUTE.box,
    kind: "refresh",
    exp: nowSec() + ttl,
    ...over,
  };
  return signToken(payload, SECRET);
}

/** Mirror handleRefresh's accept predicate. */
async function acceptsRefresh(token: string): Promise<boolean> {
  const p = await verifyToken(token, SECRET);
  return !!(p && p.kind === "refresh" && p.box);
}

/** Mirror index.ts's _connect accept predicate. */
async function acceptsConnect(token: string): Promise<boolean> {
  const p = await verifyToken(token, SECRET);
  return !!(
    p &&
    p.kind === "connect" &&
    p.tenant === ROUTE.tenant &&
    p.service === ROUTE.service &&
    p.box === ROUTE.box
  );
}

describe("refresh-token verify — accept + kind separation", () => {
  it("accepts a well-formed refresh token", async () => {
    expect(await acceptsRefresh(await mint())).toBe(true);
  });

  it("rejects an expired refresh token", async () => {
    expect(await acceptsRefresh(await mint({}, -1))).toBe(false);
  });

  it("rejects a refresh token with no box binding", async () => {
    expect(await acceptsRefresh(await mint({ box: undefined }))).toBe(false);
  });

  it("does NOT accept a connect-token as a refresh token", async () => {
    const connect = await mint({ kind: "connect", exp: nowSec() + 120 });
    expect(await acceptsRefresh(connect)).toBe(false);
  });

  it("does NOT accept a join ticket as a refresh token", async () => {
    const join = await signToken(
      { tenant: ROUTE.tenant, service: ROUTE.service, kind: "join", exp: nowSec() + 900 },
      SECRET,
    );
    expect(await acceptsRefresh(join)).toBe(false);
  });

  it("does NOT accept a refresh token on the _connect plane", async () => {
    // A refresh token must never be replayable as the WS-dial connect-token.
    expect(await acceptsConnect(await mint())).toBe(false);
  });

  it("rejects a refresh token signed with the wrong secret", async () => {
    const p = await verifyToken(await mint(), "wrong-secret");
    expect(p).toBeNull();
  });
});
