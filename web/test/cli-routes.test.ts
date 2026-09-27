import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnv } from "./test-env";

const authMock = vi.fn();
const getUserMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
  clerkClient: async () => ({ users: { getUser: getUserMock } }),
}));

const HUB = "https://hub.example.com";
const SECRET = "test-service-secret";
setupTestEnv({ HUB_URL: HUB, FINCH_SERVICE_SECRET: SECRET });

import { verifyAssertion } from "@worker-auth";
import { POST as approve } from "@/app/api/finch/cli-approve/route";
import { POST as describeCode } from "@/app/api/finch/cli-describe/route";

const userId = "user_cli_owner";

function request(path: string, body: unknown, headers?: HeadersInit): Request {
  return new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function rawRequest(path: string, body: string, headers?: HeadersInit): Request {
  return new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function owner(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    member: { id: "member_cli", role: "owner", state: "active", email: "owner@example.com", ...overrides },
    tenantMeta: { id: userId, kind: "personal" },
  });
}

type Handler = (body: Record<string, unknown>) => Response | Promise<Response>;

// Every malformed hub call the fake hub refused. A route may turn a thrown
// fetch into a 502, so a refusal must also fail the test explicitly.
let violations: string[] = [];
afterEach(() => {
  expect(violations).toEqual([]);
});

/**
 * A fake hub that answers only the calls these routes may make, and only when
 * they are made correctly: POST, the service secret, an assertion for the
 * signed-in user's OWN tenant (their Clerk user id), no redirect following,
 * and a JSON body. `/api/member-context` must ask about that same user.
 * Anything else throws, so a wrong call fails the test instead of getting a
 * canned 200. Returns the recorded calls.
 */
function hub(handlers: { memberContext?: Handler; describe?: Handler; approve?: Handler } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const routes: Record<string, Handler | undefined> = {
    "/api/member-context": handlers.memberContext ?? (() => owner()),
    "/api/cli-describe": handlers.describe,
    "/api/device-approve": handlers.approve,
  };
  const refuse = (why: string): never => {
    violations.push(why);
    throw new Error(why);
  };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith(`${HUB}/api/`)) refuse(`unexpected hub URL ${url}`);
    const path = url.slice(HUB.length);
    const handler = routes[path] ?? refuse(`unexpected hub call ${path}`);
    if (init?.method !== "POST") refuse(`${path} must be a POST`);
    if (init?.redirect !== "manual") refuse(`${path} must not follow redirects`);
    const headers = new Headers(init?.headers);
    if (headers.get("x-finch-service") !== SECRET) refuse(`${path} without the service secret`);
    const tenant = await verifyAssertion(headers.get("x-finch-auth") ?? "", SECRET);
    if (tenant !== userId) refuse(`${path} signed for ${tenant}, not the user's own tenant`);
    const body = JSON.parse(String(init?.body));
    if (path === "/api/member-context" && body.clerkUserId !== userId) {
      refuse(`member-context asked about ${body.clerkUserId}`);
    }
    calls.push({ path, body });
    return handler(body);
  });
  return { spy, calls, paths: () => calls.map((c) => c.path) };
}

beforeEach(() => {
  violations = [];
  authMock.mockReset();
  getUserMock.mockReset();
  vi.restoreAllMocks();
  authMock.mockResolvedValue({ userId });
  getUserMock.mockResolvedValue({
    primaryEmailAddressId: "email_primary",
    emailAddresses: [
      { id: "email_primary", emailAddress: "owner@example.com" },
    ],
  });
});

describe("CLI route authorization boundary", () => {
  it.each([
    ["approve", () => approve(request("/api/finch/cli-approve", { userCode: "ABCD-EFGH" }))],
    ["describe", () => describeCode(request("/api/finch/cli-describe", { userCode: "ABCD-EFGH" }))],
  ])("rejects an unauthenticated %s request before any hub action", async (_name, call) => {
    authMock.mockResolvedValue({ userId: null });
    const { spy } = hub();

    const response = await call();

    expect(response.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["approve", () => approve(request("/api/finch/cli-approve", { userCode: "ABCD-EFGH" }))],
    ["describe", () => describeCode(request("/api/finch/cli-describe", { userCode: "ABCD-EFGH" }))],
  ])("refuses a %s request when the hub does not report the user as owner", async (_name, call) => {
    const { paths } = hub({ memberContext: () => Response.json({ member: null, tenantMeta: null }) });

    const response = await call();

    expect(response.status).toBe(403);
    expect(paths()).toEqual(["/api/member-context"]);
  });

  it("fails closed when the hub returns malformed membership state", async () => {
    const { paths } = hub({
      memberContext: () => Response.json({ member: { role: "owner", state: "active" } }),
    });

    const response = await describeCode(
      request("/api/finch/cli-describe", { userCode: "ABCD-EFGH" }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
    // Refused at membership, before any action call.
    expect(paths()).toEqual(["/api/member-context"]);
  });

  it("always acts as the user's own tenant, whatever Clerk organization is active", async () => {
    authMock.mockResolvedValue({ userId, orgId: "org_acme", orgRole: "org:admin" });
    const { paths } = hub({ describe: () => Response.json({ found: false }) });

    const response = await describeCode(
      request("/api/finch/cli-describe", { userCode: "ABCD-EFGH" }),
    );

    // The fake hub already refused any assertion not signed for userId.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ found: false });
    expect(paths()).toEqual(["/api/member-context", "/api/cli-describe"]);
  });
});

describe("CLI code request validation", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "ABCD-EFGH"],
    ["a number", 42],
    ["a boolean", true],
  ])("rejects valid JSON whose top level is %s", async (_name, body) => {
    const { paths } = hub();

    const response = await describeCode(request("/api/finch/cli-describe", body));

    expect(response.status).toBe(400);
    expect(paths()).toEqual(["/api/member-context"]);
  });

  it.each([null, [], {}, 7, true])(
    "rejects a non-string userCode without coercing it (%j)",
    async (userCode) => {
      const { paths } = hub();

      const response = await approve(
        request("/api/finch/cli-approve", { userCode }),
      );

      expect(response.status).toBe(400);
      expect(paths()).toEqual(["/api/member-context"]);
      expect(getUserMock).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed JSON and an over-limit body before the action call", async () => {
    const { paths } = hub();

    const malformed = await describeCode(
      rawRequest("/api/finch/cli-describe", "{"),
    );
    const oversized = await describeCode(
      request("/api/finch/cli-describe", {
        userCode: "ABCD-EFGH",
        padding: "x".repeat(4096),
      }),
    );

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(paths()).toEqual(["/api/member-context", "/api/member-context"]);
  });

  it.each(["", "ABC", "ABCI-1234", "ABCD--EFGH", "A".repeat(33)])(
    "rejects a code outside the generated CLI-code language (%s)",
    async (userCode) => {
      const { paths } = hub();

      const response = await describeCode(
        request("/api/finch/cli-describe", { userCode }),
      );

      expect(response.status).toBe(400);
      expect(paths()).toEqual(["/api/member-context"]);
    },
  );
});

describe("POST /api/finch/cli-describe", () => {
  it("normalizes a human-entered code, uses one auth snapshot, and strips unexpected fields", async () => {
    const { calls } = hub({
      describe: () =>
        Response.json({
          found: true,
          reqIp: "203.0.113.1",
          reqUa: "finch-cli/1",
          ageSeconds: 4,
          approved: false,
          token: "must-not-cross-the-bff",
          account: { name: "a hub-chosen label", kind: "team" },
        }),
    });

    const response = await describeCode(
      request("/api/finch/cli-describe", { userCode: " abcd efgh " }),
    );

    expect(response.status).toBe(200);
    expect(authMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      { path: "/api/member-context", body: { clerkUserId: userId } },
      { path: "/api/cli-describe", body: { userCode: "ABCD-EFGH" } },
    ]);
    // No account label: the token always acts as the signed-in user's own
    // account, which the page names from their Clerk profile.
    expect(await response.json()).toEqual({
      found: true,
      reqIp: "203.0.113.1",
      reqUa: "finch-cli/1",
      ageSeconds: 4,
      approved: false,
    });
  });

  it.each([
    ["non-JSON", () => new Response("<html>oops</html>")],
    ["a primitive", () => Response.json(null)],
    ["a fractional age", () => Response.json({ found: true, ageSeconds: 1.5 })],
  ])("returns 502 for %s success data", async (_name, describe) => {
    hub({ describe });

    const response = await describeCode(
      request("/api/finch/cli-describe", { userCode: "ABCD-EFGH" }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
  });

  it("maps an action-plane network failure to an upstream 502", async () => {
    hub({
      describe: () => {
        throw new TypeError("connection reset");
      },
    });

    const response = await describeCode(
      request("/api/finch/cli-describe", { userCode: "ABCD-EFGH" }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "hub unavailable" });
  });
});

describe("POST /api/finch/cli-approve", () => {
  it("rejects an overlong Clerk label and uses the original authorization snapshot", async () => {
    const longServerEmail = `owner@${"x".repeat(250)}.example`;
    getUserMock.mockResolvedValue({
      primaryEmailAddressId: "primary",
      emailAddresses: [{ id: "primary", emailAddress: `  ${longServerEmail}  ` }],
    });
    const { calls } = hub({ approve: () => Response.json({ ok: true }) });

    const response = await approve(
      request("/api/finch/cli-approve", {
        userCode: "abcdefgh",
        email: "attacker@example.com",
      }),
    );

    expect(response.status).toBe(200);
    expect(authMock).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.path)).toEqual(["/api/member-context", "/api/device-approve"]);
    expect(calls[1].body).toEqual({ userCode: "ABCD-EFGH", email: "attacker@example.com" });
  });

  it("accepts a trimmed client label exactly at the limit when Clerk lookup fails", async () => {
    getUserMock.mockRejectedValue(new Error("synthetic staging user"));
    const clientEmail = `  ${"a".repeat(200)}  `;
    const { calls } = hub({ approve: () => Response.json({ ok: true }) });

    const response = await approve(
      request("/api/finch/cli-approve", {
        userCode: "ABCD-EFGH",
        email: clientEmail,
      }),
    );

    expect(response.status).toBe(200);
    expect(calls[1].body.email).toBe("a".repeat(200));
  });

  it("labels the token with the server-side Clerk email when it is valid", async () => {
    const { calls } = hub({ approve: () => Response.json({ ok: true }) });

    const response = await approve(
      request("/api/finch/cli-approve", { userCode: "ABCD-EFGH", email: "someone@else.test" }),
    );

    expect(response.status).toBe(200);
    expect(calls[1].body).toEqual({ userCode: "ABCD-EFGH", email: "owner@example.com" });
  });

  it.each([`${"a".repeat(201)}`, "owner@example.com\nforged"])(
    "rejects an invalid client label without approving (%j)",
    async (email) => {
      const { paths } = hub({ approve: () => Response.json({ ok: true }) });

      const response = await approve(
        request("/api/finch/cli-approve", { userCode: "ABCD-EFGH", email }),
      );

      expect(response.status).toBe(400);
      expect(paths()).toEqual(["/api/member-context"]);
      expect(getUserMock).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], {}, 7, true])(
    "rejects a non-string client email instead of inventing a label (%j)",
    async (email) => {
      const { paths } = hub({ approve: () => Response.json({ ok: true }) });

      const response = await approve(
        request("/api/finch/cli-approve", { userCode: "ABCD-EFGH", email }),
      );

      expect(response.status).toBe(400);
      expect(paths()).toEqual(["/api/member-context"]);
      expect(getUserMock).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed success data while preserving a real hub rejection", async () => {
    const answers = [
      Response.json({ ok: "true" }),
      Response.json({ error: "code expired" }, { status: 409 }),
    ];
    const { paths } = hub({ approve: () => answers.shift()! });

    const malformed = await approve(
      request("/api/finch/cli-approve", { userCode: "ABCD-EFGH" }),
    );
    const rejected = await approve(
      request("/api/finch/cli-approve", { userCode: "ABCD-EFGH" }),
    );

    expect(malformed.status).toBe(502);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "code expired" });
    expect(paths()).toEqual([
      "/api/member-context",
      "/api/device-approve",
      "/api/member-context",
      "/api/device-approve",
    ]);
  });
});
