import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnv } from "./test-env";

const authMock = vi.fn();
const getUserMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
  clerkClient: async () => ({ users: { getUser: getUserMock } }),
}));

setupTestEnv({ HUB_URL: "https://hub.example.com", FINCH_SERVICE_SECRET: "test-service-secret" });

import { POST as approve } from "@/app/api/finch/cli-approve/route";
import { POST as describeCode } from "@/app/api/finch/cli-describe/route";
import { POST as revoke } from "@/app/api/finch/cli-revoke/route";
import { POST as mint } from "@/app/api/finch/cli-token/route";

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

const FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
const validToken = {
  token: "eyJ0ZW5hbnQiOiJ1c2VyX2NsaV9vd25lciJ9.signature_-",
  hub: "https://hub.example.com",
  expiresAt: FUTURE_EXPIRY,
};

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
    ["revoke", () => revoke()],
    ["mint", () => mint()],
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
    ["revoke", () => revoke()],
    ["mint", () => mint()],
  ])("rejects a non-admin %s request before its privileged action", async (_name, call) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext("member"));

    const response = await call();

    expect(response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the hub returns malformed membership state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ member: { role: "owner", state: "active" } }),
    );

    const response = await describeCode(
      request("/api/finch/cli-describe", { userCode: "ABCD-EFGH" }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
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
      .mockResolvedValueOnce(memberContext());

    const response = await describeCode(request("/api/finch/cli-describe", body));

    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], {}, 7, true])(
    "rejects a non-string userCode without coercing it (%j)",
    async (userCode) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(memberContext());

      const response = await approve(
        request("/api/finch/cli-approve", { userCode }),
      );

      expect(response.status).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(getUserMock).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed JSON and an over-limit body before the action call", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
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
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each(["", "ABC", "ABCI-1234", "ABCD--EFGH", "A".repeat(33)])(
    "rejects a code outside the generated CLI-code language (%s)",
    async (userCode) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(memberContext());

      const response = await describeCode(
        request("/api/finch/cli-describe", { userCode }),
      );

      expect(response.status).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );
});

describe("POST /api/finch/cli-describe", () => {
  it("normalizes a human-entered code, uses one auth snapshot, and strips unexpected fields", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
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
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/cli-describe");
    expect(JSON.parse(init.body as string)).toEqual({ userCode: "ABCD-EFGH" });
    expect(await response.json()).toEqual({
      found: true,
      reqIp: "203.0.113.1",
      reqUa: "finch-cli/1",
      ageSeconds: 4,
      approved: false,
    });
  });

  it.each([
    ["non-JSON", new Response("<html>oops</html>")],
    ["a primitive", Response.json(null)],
    ["a fractional age", Response.json({ found: true, ageSeconds: 1.5 })],
  ])("returns 502 for %s success data", async (_name, actionResponse) => {
    vi.spyOn(globalThis, "fetch")
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
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
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
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const response = await approve(
      request("/api/finch/cli-approve", {
        userCode: "ABCD-EFGH",
        email: clientEmail,
      }),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string).email).toBe("a".repeat(200));
  });

  it.each([`${"a".repeat(201)}`, "owner@example.com\nforged"])(
    "rejects an invalid client label without approving (%j)",
    async (email) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(memberContext());

      const response = await approve(
        request("/api/finch/cli-approve", { userCode: "ABCD-EFGH", email }),
      );

      expect(response.status).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(getUserMock).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], {}, 7, true])(
    "rejects a non-string client email instead of inventing a label (%j)",
    async (email) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(memberContext());

      const response = await approve(
        request("/api/finch/cli-approve", { userCode: "ABCD-EFGH", email }),
      );

      expect(response.status).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(getUserMock).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed success data while preserving a real hub rejection", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(Response.json({ ok: "true" }))
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
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});

describe("POST /api/finch/cli-revoke", () => {
  it("forwards one authorized epoch bump and validates its result", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(Response.json({ ok: true, epoch: 3 }));

    const response = await revoke();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, epoch: 3 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://hub.example.com/api/cli-revoke");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
  });

  it.each([
    ["non-JSON", new Response("bad gateway")],
    ["false ok", Response.json({ ok: false, epoch: 1 })],
    ["fractional epoch", Response.json({ ok: true, epoch: 1.5 })],
  ])("returns 502 for %s success data", async (_name, actionResponse) => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(actionResponse);

    const response = await revoke();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
  });

  it("maps a network failure to 502 without exposing its details", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockRejectedValueOnce(new Error("secret upstream detail"));

    const response = await revoke();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "hub unavailable" });
  });
});

describe("POST /api/finch/cli-token", () => {
  it("returns a validated token contract", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(Response.json(validToken));

    const response = await mint();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(validToken);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["non-JSON", new Response("bad gateway")],
    ["a primitive", Response.json("token")],
    ["a shell-shaped token", Response.json({ ...validToken, token: "good.bad; rm" })],
    ["an expired token", Response.json({ ...validToken, expiresAt: 1 })],
    ["a cleartext remote hub", Response.json({ ...validToken, hub: "http://evil.example.com" })],
    ["a hub URL with a path", Response.json({ ...validToken, hub: "https://hub.example.com/evil" })],
    ["a fractional expiry", Response.json({ ...validToken, expiresAt: 2.5 })],
  ])("returns 502 for %s success data", async (_name, actionResponse) => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(actionResponse);

    const response = await mint();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid response from hub" });
  });

  it("preserves an authenticated upstream status and maps transport failure to 502", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(memberContext())
      .mockResolvedValueOnce(Response.json({ error: "overloaded" }, { status: 503 }))
      .mockResolvedValueOnce(memberContext())
      .mockRejectedValueOnce(new TypeError("connection reset"));

    const rejected = await mint();
    const unavailable = await mint();

    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({ error: "could not mint CLI token" });
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toEqual({ error: "invalid response from hub" });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
