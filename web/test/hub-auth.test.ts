import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const getUserMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
  clerkClient: async () => ({ users: { getUser: getUserMock } }),
}));

import { verifyAssertion } from "@worker-auth";
import {
  hubFetchAs,
  HttpError,
  requireAdmin,
  resolveTenant,
} from "@/lib/hub";

const originalHubUrl = process.env.HUB_URL;
const originalServiceSecret = process.env.FINCH_SERVICE_SECRET;

afterAll(() => {
  if (originalHubUrl === undefined) delete process.env.HUB_URL;
  else process.env.HUB_URL = originalHubUrl;
  if (originalServiceSecret === undefined) delete process.env.FINCH_SERVICE_SECRET;
  else process.env.FINCH_SERVICE_SECRET = originalServiceSecret;
  vi.unstubAllGlobals();
});

function memberResponse(
  overrides: Record<string, unknown> = {},
  tenantMeta: unknown = undefined,
) {
  return new Response(
    JSON.stringify({
      member: {
        id: "mem_1",
        email: "member@example.com",
        role: "member",
        state: "active",
        ...overrides,
      },
      ...(tenantMeta === undefined ? {} : { tenantMeta }),
    }),
    { headers: { "content-type": "application/json" } },
  );
}

async function signedTenant(call: number): Promise<string | null> {
  const [, init] = fetchMock.mock.calls[call] as [URL, RequestInit];
  const token = new Headers(init.headers).get("x-finch-auth")!;
  return verifyAssertion(token, "service-secret");
}

describe("single-user tenant resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HUB_URL = "https://hub.example.test";
    process.env.FINCH_SERVICE_SECRET = "service-secret";
    authMock.mockResolvedValue({ userId: "user_1" });
    fetchMock.mockImplementation(async () => memberResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  it("rejects unauthenticated requests without consulting organization claims", async () => {
    authMock.mockResolvedValue({ userId: null, orgId: "org_ignored", orgRole: "org:admin" });

    await expect(resolveTenant()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the hub as the user's personal tenant and keeps the unchanged request shape", async () => {
    await resolveTenant();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.test/api/member-context");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ clerkUserId: "user_1" });
    expect(await signedTenant(0)).toBe("user_1");
  });

  it("resolves a valid active member without granting ordinary members admin access", async () => {
    const context = await resolveTenant();

    expect(context).toMatchObject({
      tenant: "user_1",
      userId: "user_1",
      memberId: "mem_1",
      email: "member@example.com",
      role: "member",
      isAdmin: false,
    });
    await expect(requireAdmin()).rejects.toMatchObject({ status: 403 });
  });

  it("resolves the personal tenant the hub names for its owner", async () => {
    fetchMock.mockImplementation(async () =>
      memberResponse({ role: "owner" }, { id: "user_1", kind: "personal" }),
    );

    await expect(requireAdmin()).resolves.toMatchObject({
      tenant: "user_1",
      role: "owner",
      isAdmin: true,
    });
  });

  it("follows the hub to another tenant the user owns", async () => {
    fetchMock.mockImplementation(async () =>
      memberResponse({ role: "owner" }, { id: "org_legacy", kind: "team" }),
    );

    await expect(requireAdmin()).resolves.toMatchObject({
      tenant: "org_legacy",
      userId: "user_1",
      role: "owner",
    });
  });

  it("refuses another tenant when the hub does not report the user as its owner", async () => {
    for (const role of ["admin", "member"]) {
      fetchMock.mockImplementation(async () =>
        memberResponse({ role }, { id: "ft_someone_else" }),
      );
      await expect(resolveTenant()).rejects.toMatchObject({ status: 403 });
    }
  });

  it("fails closed on a malformed tenant id from the hub", async () => {
    for (const tenantMeta of [{ id: "../../attacker" }, { id: 42 }, "user_1", []]) {
      fetchMock.mockImplementation(async () => memberResponse({ role: "owner" }, tenantMeta));
      await expect(resolveTenant()).rejects.toMatchObject({ status: 502 });
    }
  });

  it("bootstraps a new personal tenant with the verified primary email", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ member: null, tenantMeta: null, needsBootstrap: true }))
      .mockResolvedValueOnce(
        memberResponse({ role: "owner", email: "owner@example.com" }, { id: "user_1" }),
      );
    getUserMock.mockResolvedValue({
      primaryEmailAddressId: "em_2",
      emailAddresses: [
        { id: "em_1", emailAddress: "unverified@example.com", verification: { status: "unverified" } },
        { id: "em_2", emailAddress: "owner@example.com", verification: { status: "verified" } },
      ],
    });

    await expect(resolveTenant()).resolves.toMatchObject({ tenant: "user_1", role: "owner" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      clerkUserId: "user_1",
      email: "owner@example.com",
    });
    expect(await signedTenant(1)).toBe("user_1");
  });

  it("refuses to bootstrap without a verified email", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ member: null, tenantMeta: null, needsBootstrap: true }),
    );
    getUserMock.mockResolvedValue({
      primaryEmailAddressId: "em_1",
      emailAddresses: [
        { id: "em_1", emailAddress: "x@example.com", verification: { status: "unverified" } },
      ],
    });

    await expect(resolveTenant()).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a membership that is not active", async () => {
    for (const state of ["invited", "disabled"]) {
      fetchMock.mockImplementation(async () => memberResponse({ role: "owner", state }));
      await expect(resolveTenant()).rejects.toMatchObject({ status: 403 });
    }
    fetchMock.mockResolvedValue(Response.json({ member: null, tenantMeta: { id: "user_1" } }));
    await expect(resolveTenant()).rejects.toMatchObject({ status: 403 });
  });

  it("fails closed when an active hub member carries an unknown role", async () => {
    fetchMock.mockImplementation(async () => memberResponse({ role: "super-admin" }));

    await expect(resolveTenant()).rejects.toMatchObject({ status: 502 });
    await expect(requireAdmin()).rejects.toMatchObject({ status: 502 });
  });

  it("maps a null hub authorization payload to a controlled bad-gateway response", async () => {
    fetchMock.mockResolvedValue(new Response("null", {
      headers: { "content-type": "application/json" },
    }));

    await expect(resolveTenant()).rejects.toMatchObject({
      status: 502,
      message: "invalid response from hub",
    });
  });

  it("distinguishes a malformed member shape from a well-formed membership denial", async () => {
    fetchMock.mockResolvedValue(Response.json({ member: "owner" }));

    await expect(resolveTenant()).rejects.toMatchObject({
      status: 502,
      message: "invalid response from hub",
    });
  });

  it("passes a hub rejection status through", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "nope" }, { status: 401 }));

    await expect(resolveTenant()).rejects.toBeInstanceOf(HttpError);
    await expect(resolveTenant()).rejects.toMatchObject({ status: 401 });
  });
});

describe("outbound hub authentication boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HUB_URL = "https://hub.example.test/";
    process.env.FINCH_SERVICE_SECRET = "service-secret";
    fetchMock.mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("overwrites caller-supplied auth headers and refuses redirects", async () => {
    await hubFetchAs("org_1", "/api/state", {
      method: "POST",
      body: "",
      redirect: "follow",
      headers: {
        "X-Finch-Service": "attacker-secret",
        "X-Finch-Auth": "attacker-assertion",
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("https://hub.example.test/api/state");
    expect(headers.get("x-finch-service")).toBe("service-secret");
    expect(headers.get("content-type")).toBe("application/json");
    expect(await verifyAssertion(headers.get("x-finch-auth")!, "service-secret")).toBe("org_1");
    expect(init.redirect).toBe("manual");
  });

  // workerd implements only "follow" and "manual"; `redirect: "error"` throws a
  // TypeError at call time, which silently 502'd every bridge route in prod
  // because this suite's fetch mock accepts any init value.
  it("refuses a redirect the hub actually returns instead of following it", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
    );

    await expect(hubFetchAs("org_1", "/api/state")).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-origin and cleartext remote hub configuration", async () => {
    for (const hubUrl of [
      "http://hub.example.test",
      "https://user:pass@hub.example.test",
      "https://hub.example.test/base",
      "https://hub.example.test?target=other",
      "https://hub.example.test#fragment",
      "not a url",
    ]) {
      process.env.HUB_URL = hubUrl;
      await expect(hubFetchAs("user_1", "/api/state")).rejects.toBeInstanceOf(HttpError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows only local cleartext development origins and canonicalizes them", async () => {
    process.env.HUB_URL = "http://127.0.0.1:8787/";

    await hubFetchAs("user_1", "/api/state");
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:8787/api/state");
  });

  it("rejects malformed authorization identities before fetch", async () => {
    for (const tenant of ["", "tenant.with.dots", "t".repeat(129)]) {
      await expect(hubFetchAs(tenant, "/api/state")).rejects.toMatchObject({ status: 500 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects WHATWG path normalization and separator ambiguities before fetch", async () => {
    for (const path of [
      "api/state",
      "//attacker.example/api/state",
      "/\\attacker.example/api/state",
      "/api/../admin",
      "/api/%2e%2e/admin",
      "/api/.%2E/admin",
      "/api/%5cadmin",
      "/api/state#other-endpoint",
      "/api/%0astate",
      "/api/%not-hex",
    ]) {
      await expect(hubFetchAs("user_1", path)).rejects.toMatchObject({ status: 500 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves intentional query strings after validating only the path component", async () => {
    await hubFetchAs("user_1", "/api/state?cursor=..%2Fnext&filter=a%20b");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://hub.example.test/api/state?cursor=..%2Fnext&filter=a%20b",
    );
  });
});
