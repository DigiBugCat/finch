import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const getUserMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
  clerkClient: async () => ({ users: { getUser: getUserMock } }),
}));

import { verifyAssertion } from "@worker-auth";
import { hubFetchAs, HttpError, resolveTenant } from "@/lib/hub";

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
  return Response.json({
    member: {
      id: "mem_1",
      email: "owner@example.com",
      role: "owner",
      state: "active",
      ...overrides,
    },
    tenantMeta: { id: "user_1", kind: "personal" },
  });
}

// A fake hub that only answers what the web may ask during tenant
// resolution: POST /api/member-context, authenticated with the service secret
// and an assertion for the signed-in user's OWN tenant, about that same user.
// Anything else — another path, another tenant, another user, a missing or
// wrong secret — is a test failure, not a silent 200.
let memberContext: (body: Record<string, unknown>) => Response;

async function fakeHub(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (headers.get("x-finch-service") !== "service-secret") throw new Error(`bad service secret for ${url}`);
  const tenant = await verifyAssertion(headers.get("x-finch-auth") ?? "", "service-secret");
  if (tenant !== "user_1") throw new Error(`assertion for ${tenant} on ${url}`);
  if (url !== "https://hub.example.test/api/member-context" || init.method !== "POST") {
    throw new Error(`unexpected hub call ${init.method} ${url}`);
  }
  if (init.redirect !== "manual") throw new Error("redirects must not be followed");
  const body = JSON.parse(String(init.body));
  if (body.clerkUserId !== "user_1") throw new Error(`member-context for ${body.clerkUserId}`);
  const extra = Object.keys(body).filter((k) => k !== "clerkUserId" && k !== "email");
  if (extra.length) throw new Error(`unexpected member-context fields ${extra}`);
  return memberContext(body);
}

describe("single-user tenant resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HUB_URL = "https://hub.example.test";
    process.env.FINCH_SERVICE_SECRET = "service-secret";
    authMock.mockResolvedValue({ userId: "user_1" });
    memberContext = () => memberResponse();
    fetchMock.mockImplementation(fakeHub);
    vi.stubGlobal("fetch", fetchMock);
  });

  it("rejects unauthenticated requests without consulting organization claims", async () => {
    authMock.mockResolvedValue({ userId: null, orgId: "org_ignored", orgRole: "org:admin" });

    await expect(resolveTenant()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("acts as the user's own tenant — their Clerk user id — with one hub call", async () => {
    await expect(resolveTenant()).resolves.toEqual({
      tenant: "user_1",
      userId: "user_1",
      memberId: "mem_1",
      email: "owner@example.com",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ clerkUserId: "user_1" });
  });

  it("ignores an active Clerk organization: the tenant is still the user", async () => {
    authMock.mockResolvedValue({ userId: "user_1", orgId: "org_1", orgRole: "org:admin" });

    await expect(resolveTenant()).resolves.toMatchObject({ tenant: "user_1" });
  });

  it("bootstraps a new tenant with the verified primary email", async () => {
    const contexts = [
      Response.json({ member: null, tenantMeta: null, needsBootstrap: true }),
      memberResponse(),
    ];
    const bodies: Record<string, unknown>[] = [];
    memberContext = (body) => {
      bodies.push(body);
      return contexts.shift()!;
    };
    getUserMock.mockResolvedValue({
      primaryEmailAddressId: "em_2",
      emailAddresses: [
        { id: "em_1", emailAddress: "unverified@example.com", verification: { status: "unverified" } },
        { id: "em_2", emailAddress: "owner@example.com", verification: { status: "verified" } },
      ],
    });

    await expect(resolveTenant()).resolves.toMatchObject({ tenant: "user_1", memberId: "mem_1" });
    expect(bodies).toEqual([
      { clerkUserId: "user_1" },
      { clerkUserId: "user_1", email: "owner@example.com" },
    ]);
    expect(getUserMock).toHaveBeenCalledWith("user_1");
  });

  it("refuses to bootstrap without a verified email", async () => {
    memberContext = () => Response.json({ member: null, tenantMeta: null, needsBootstrap: true });
    getUserMock.mockResolvedValue({
      primaryEmailAddressId: "em_1",
      emailAddresses: [
        { id: "em_1", emailAddress: "x@example.com", verification: { status: "unverified" } },
      ],
    });

    await expect(resolveTenant()).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses when the hub does not report the user as the owner", async () => {
    memberContext = () => Response.json({ member: null, tenantMeta: null });

    await expect(resolveTenant()).rejects.toMatchObject({ status: 403 });
  });

  it("fails closed on any member that is not the active owner", async () => {
    for (const overrides of [
      { role: "admin" },
      { role: "member" },
      { role: "super-admin" },
      { state: "invited" },
      { state: "disabled" },
      { id: "" },
      { email: 7 },
    ]) {
      memberContext = () => memberResponse(overrides);
      await expect(resolveTenant(), JSON.stringify(overrides)).rejects.toMatchObject({
        status: 502,
        message: "invalid response from hub",
      });
    }
  });

  it("maps a null hub authorization payload to a controlled bad-gateway response", async () => {
    memberContext = () => new Response("null", {
      headers: { "content-type": "application/json" },
    });

    await expect(resolveTenant()).rejects.toMatchObject({
      status: 502,
      message: "invalid response from hub",
    });
  });

  it("distinguishes a malformed member shape from a well-formed denial", async () => {
    for (const body of [{ member: "owner" }, { member: [] }, {}]) {
      memberContext = () => Response.json(body);
      await expect(resolveTenant()).rejects.toMatchObject({
        status: 502,
        message: "invalid response from hub",
      });
    }
  });

  it("passes a hub rejection status through", async () => {
    memberContext = () => Response.json({ error: "nope" }, { status: 401 });

    await expect(resolveTenant()).rejects.toBeInstanceOf(HttpError);
    await expect(resolveTenant()).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a Clerk user id the hub could not accept as a tenant, before any call", async () => {
    authMock.mockResolvedValue({ userId: "user.with.dots" });

    await expect(resolveTenant()).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).not.toHaveBeenCalled();
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
