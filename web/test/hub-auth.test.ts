import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const getUserMock = vi.fn();
const cookieGetMock = vi.fn();
const cookieDeleteMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
  clerkClient: async () => ({ users: { getUser: getUserMock } }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: cookieGetMock,
    delete: cookieDeleteMock,
    set: vi.fn(),
  }),
}));

import { verifyAssertion } from "@worker-auth";
import {
  getHubUrl,
  hubFetchAs,
  HttpError,
  requireAdmin,
  resolveTenant,
  userFetch,
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

function memberResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      member: {
        id: "mem_1",
        email: "member@example.com",
        role: "member",
        state: "active",
        ...overrides,
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("native tenant authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HUB_URL = "https://hub.example.test";
    process.env.FINCH_SERVICE_SECRET = "service-secret";
    authMock.mockResolvedValue({ userId: "user_1" });
    cookieGetMock.mockReturnValue(undefined);
    fetchMock.mockImplementation(async () => memberResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  it("rejects unauthenticated requests without consulting organization claims", async () => {
    authMock.mockResolvedValue({ userId: null, orgId: "org_ignored", orgRole: "org:admin" });

    await expect(resolveTenant()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("clears a selected tenant cookie when membership is no longer active", async () => {
    cookieGetMock.mockReturnValue({ value: "org_selected" });
    fetchMock.mockResolvedValue(memberResponse({ state: "disabled" }));

    await expect(resolveTenant()).rejects.toMatchObject({ status: 403 });
    expect(cookieDeleteMock).toHaveBeenCalledWith("finch_active_tenant");
  });

  it("ignores a malformed selected-tenant cookie and signs the personal tenant", async () => {
    cookieGetMock.mockReturnValue({ value: "../../attacker" });

    await resolveTenant();

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const token = new Headers(init.headers).get("x-finch-auth")!;
    expect(await verifyAssertion(token, "service-secret")).toBe("user_1");
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
    expect(init.redirect).toBe("error");
  });

  it("mints user-scoped assertions that cannot authorize tenant-scoped calls", async () => {
    await userFetch("user_1", "/api/user/sync");

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const token = new Headers(init.headers).get("x-finch-auth")!;
    const verifyWithKind = verifyAssertion as unknown as (
      token: string,
      secret: string,
      expectedKind: string,
    ) => Promise<string | null>;
    expect(await verifyAssertion(token, "service-secret")).toBeNull();
    expect(await verifyWithKind(token, "service-secret", "user")).toBe("user_1");
    expect(init.redirect).toBe("error");
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
      await expect(getHubUrl()).rejects.toBeInstanceOf(HttpError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows only local cleartext development origins and canonicalizes them", async () => {
    process.env.HUB_URL = "http://127.0.0.1:8787/";

    await expect(getHubUrl()).resolves.toBe("http://127.0.0.1:8787");
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
