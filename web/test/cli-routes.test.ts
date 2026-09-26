import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnv } from "./test-env";

const authMock = vi.fn();
const getUserMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
  clerkClient: async () => ({ users: { getUser: getUserMock } }),
}));

setupTestEnv({ HUB_URL: "https://hub.example.com", FINCH_SERVICE_SECRET: "test-service-secret" });

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

/** The hub's answer to the owner lookup: nothing owned beyond the personal
 *  tenant, so the routes act as the Clerk user id. */
function ownerLookup(): Response {
  return Response.json({ tenants: [], claimable: [] });
}

function memberContext(role: "owner" | "admin" | "member" = "owner"): Response {
  return Response.json({
    member: {
      id: "member_cli",
      role,
      state: "active",
      email: `${role}@example.com`,
    },
    tenantMeta: { id: userId },
  });
}

beforeEach(() => {
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
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await call();

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["approve", () => approve(request("/api/finch/cli-approve", { userCode: "ABCD-EFGH" }))],
    ["describe", () => describeCode(request("/api/finch/cli-describe", { userCode: "ABCD-EFGH" }))],
  ])("rejects a non-admin %s request before its privileged action", async (_name, call) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerLookup())
      .mockResolvedValueOnce(memberContext("member"));

    const response = await call();

    expect(response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the hub returns malformed membership state", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerLookup())
      .mockResolvedValueOnce(
        Response.json({ member: { role: "owner", state: "active" } }),
      );

    const response = await describeCode(
      request("/api/finch/cli-describe", { userCode: "ABCD-EFGH" }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
    // Refused at membership, before any action call.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("acts as, and names, an owned team that holds the fleet when the personal tenant is empty", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          tenants: [
            { tenantId: "ft_owned_team", role: "owner", state: "active", name: "Acme", kind: "team" },
          ],
          claimable: [],
        }),
      )
      // /api/state of the personal tenant, then of the team.
      .mockResolvedValueOnce(Response.json({ services: [], keys: [] }))
      .mockResolvedValueOnce(Response.json({ services: [{ id: "printer" }], keys: [] }))
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(Response.json({ found: false }));

    const response = await describeCode(
      request("/api/finch/cli-describe", { userCode: "ABCD-EFGH" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      found: false,
      account: { name: "Acme", kind: "team" },
    });
    const [url, init] = fetchSpy.mock.calls[4] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/cli-describe");
    const assertion = new Headers(init.headers).get("x-finch-auth")!;
    expect(await verifyAssertion(assertion, "test-service-secret")).toBe("ft_owned_team");
  });

  it("surfaces a refusal to choose between two populated accounts before any action", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          tenants: [
            { tenantId: "ft_owned_team", role: "owner", state: "active", name: "Acme", kind: "team" },
          ],
          claimable: [],
        }),
      )
      .mockResolvedValueOnce(Response.json({ services: [{ id: "a" }], keys: [] }))
      .mockResolvedValueOnce(Response.json({ services: [{ id: "b" }], keys: [] }));

    const response = await approve(
      request("/api/finch/cli-approve", { userCode: "ABCD-EFGH" }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/more than one Finch account/);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
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
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerLookup())
      .mockResolvedValueOnce(memberContext());

    const response = await describeCode(request("/api/finch/cli-describe", body));

    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([null, [], {}, 7, true])(
    "rejects a non-string userCode without coercing it (%j)",
    async (userCode) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(ownerLookup())
        .mockResolvedValueOnce(memberContext());

      const response = await approve(
        request("/api/finch/cli-approve", { userCode }),
      );

      expect(response.status).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(getUserMock).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed JSON and an over-limit body before the action call", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerLookup())
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(ownerLookup())
      .mockResolvedValueOnce(memberContext());

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
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it.each(["", "ABC", "ABCI-1234", "ABCD--EFGH", "A".repeat(33)])(
    "rejects a code outside the generated CLI-code language (%s)",
    async (userCode) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(ownerLookup())
        .mockResolvedValueOnce(memberContext());

      const response = await describeCode(
        request("/api/finch/cli-describe", { userCode }),
      );

      expect(response.status).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );
});

describe("POST /api/finch/cli-describe", () => {
  it("normalizes a human-entered code, uses one auth snapshot, and strips unexpected fields", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerLookup())
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(
        Response.json({
          found: true,
          reqIp: "203.0.113.1",
          reqUa: "finch-cli/1",
          ageSeconds: 4,
          approved: false,
          token: "must-not-cross-the-bff",
        }),
      );

    const response = await describeCode(
      request("/api/finch/cli-describe", { userCode: " abcd efgh " }),
    );

    expect(response.status).toBe(200);
    expect(authMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const [url, init] = fetchSpy.mock.calls[2] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/cli-describe");
    expect(JSON.parse(init.body as string)).toEqual({ userCode: "ABCD-EFGH" });
    expect(await response.json()).toEqual({
      found: true,
      reqIp: "203.0.113.1",
      reqUa: "finch-cli/1",
      ageSeconds: 4,
      approved: false,
      account: { name: "owner@example.com", kind: "personal" },
    });
  });

  it.each([
    ["non-JSON", new Response("<html>oops</html>")],
    ["a primitive", Response.json(null)],
    ["a fractional age", Response.json({ found: true, ageSeconds: 1.5 })],
  ])("returns 502 for %s success data", async (_name, actionResponse) => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerLookup())
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(actionResponse);

    const response = await describeCode(
      request("/api/finch/cli-describe", { userCode: "ABCD-EFGH" }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
  });

  it("maps an action-plane network failure to an upstream 502", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerLookup())
      .mockResolvedValueOnce(memberContext())
      .mockRejectedValueOnce(new TypeError("connection reset"));

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
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerLookup())
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const response = await approve(
      request("/api/finch/cli-approve", {
        userCode: "abcdefgh",
        email: "attacker@example.com",
      }),
    );

    expect(response.status).toBe(200);
    expect(authMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const [url, init] = fetchSpy.mock.calls[2] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/device-approve");
    const forwarded = JSON.parse(init.body as string);
    expect(forwarded.userCode).toBe("ABCD-EFGH");
    expect(forwarded.email).toBe("attacker@example.com");
  });

  it("accepts a trimmed client label exactly at the limit when Clerk lookup fails", async () => {
    getUserMock.mockRejectedValue(new Error("synthetic staging user"));
    const clientEmail = `  ${"a".repeat(200)}  `;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerLookup())
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const response = await approve(
      request("/api/finch/cli-approve", {
        userCode: "ABCD-EFGH",
        email: clientEmail,
      }),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(init.body as string).email).toBe("a".repeat(200));
  });

  it.each([`${"a".repeat(201)}`, "owner@example.com\nforged"])(
    "rejects an invalid client label without approving (%j)",
    async (email) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(ownerLookup())
        .mockResolvedValueOnce(memberContext());

      const response = await approve(
        request("/api/finch/cli-approve", { userCode: "ABCD-EFGH", email }),
      );

      expect(response.status).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(getUserMock).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], {}, 7, true])(
    "rejects a non-string client email instead of inventing a label (%j)",
    async (email) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(ownerLookup())
        .mockResolvedValueOnce(memberContext());

      const response = await approve(
        request("/api/finch/cli-approve", { userCode: "ABCD-EFGH", email }),
      );

      expect(response.status).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(getUserMock).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed success data while preserving a real hub rejection", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ownerLookup())
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(Response.json({ ok: "true" }))
      .mockResolvedValueOnce(ownerLookup())
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(Response.json({ error: "code expired" }, { status: 409 }));

    const malformed = await approve(
      request("/api/finch/cli-approve", { userCode: "ABCD-EFGH" }),
    );
    const rejected = await approve(
      request("/api/finch/cli-approve", { userCode: "ABCD-EFGH" }),
    );

    expect(malformed.status).toBe(502);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "code expired" });
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });
});
