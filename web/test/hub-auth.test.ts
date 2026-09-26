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
  userFetch,
} from "@/lib/hub";

const verifyWithKind = verifyAssertion as unknown as (
  token: string,
  secret: string,
  expectedKind: string,
) => Promise<string | null>;

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

// The hub is asked /api/user/sync (which tenants this user owns), then, only
// when they own more than their personal tenant, /api/state of each candidate
// (does it hold services or keys?), and finally /api/member-context (their
// membership in the chosen tenant). Route by path.
let syncResponse: () => Response;
let memberContext: () => Response;
// What each tenant's /api/state holds; a tenant not listed is empty.
let fleets: Record<string, { services?: unknown[]; keys?: unknown[] }>;
let stateResponse: (tenant: string) => Response;

function owns(...tenantIds: string[]): () => Response {
  return () =>
    Response.json({
      tenants: [
        { tenantId: "user_1", role: "owner", state: "active", name: "user_1", kind: "personal" },
        ...tenantIds.map((tenantId) => ({
          tenantId,
          role: "owner",
          state: "active",
          name: `Team ${tenantId}`,
          kind: "team",
        })),
      ],
      claimable: [],
    });
}

function callsTo(path: string): [string, RequestInit][] {
  return (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) =>
    String(url).endsWith(path),
  );
}

async function signedAs(init: RequestInit, kind?: "user"): Promise<string | null> {
  const token = new Headers(init.headers).get("x-finch-auth")!;
  return kind ? verifyWithKind(token, "service-secret", kind) : verifyAssertion(token, "service-secret");
}

describe("single-user tenant resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HUB_URL = "https://hub.example.test";
    process.env.FINCH_SERVICE_SECRET = "service-secret";
    authMock.mockResolvedValue({ userId: "user_1" });
    syncResponse = () => Response.json({ tenants: [], claimable: [] });
    memberContext = () => memberResponse();
    fleets = {};
    stateResponse = (tenant) =>
      Response.json({ services: [], keys: [], ...fleets[tenant] });
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/api/user/sync")) return syncResponse();
      if (String(url).endsWith("/api/state")) return stateResponse((await signedAs(init))!);
      return memberContext();
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("rejects unauthenticated requests without consulting organization claims", async () => {
    authMock.mockResolvedValue({ userId: null, orgId: "org_ignored", orgRole: "org:admin" });

    await expect(resolveTenant()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks the owner up as the user, then checks membership as the personal tenant", async () => {
    await resolveTenant();

    const [[, sync]] = callsTo("/api/user/sync");
    expect(sync.method).toBe("POST");
    expect(JSON.parse(String(sync.body))).toEqual({ emails: [] });
    expect(await signedAs(sync, "user")).toBe("user_1");
    // A user-scoped assertion is never a tenant credential.
    expect(await signedAs(sync)).toBeNull();

    const [[url, member]] = callsTo("/api/member-context");
    expect(url).toBe("https://hub.example.test/api/member-context");
    expect(member.method).toBe("POST");
    expect(JSON.parse(String(member.body))).toEqual({ clerkUserId: "user_1" });
    expect(await signedAs(member)).toBe("user_1");
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

  it("stays on the personal tenant, without probing, when the user owns nothing else", async () => {
    syncResponse = () =>
      Response.json({
        tenants: [
          { tenantId: "ft_team", role: "member", state: "active" },
          { tenantId: "ft_admin_only", role: "admin", state: "active" },
          { tenantId: "ft_disabled", role: "owner", state: "disabled" },
          { tenantId: "../../attacker", role: "owner", state: "active" },
        ],
        claimable: [],
      });
    memberContext = () => memberResponse({ role: "owner", email: "owner@example.com" });

    await expect(resolveTenant()).resolves.toMatchObject({
      tenant: "user_1",
      role: "owner",
      account: { name: "owner@example.com", kind: "personal" },
    });
    expect(callsTo("/api/state")).toHaveLength(0);
  });

  it("keeps the personal tenant that holds the fleet over an empty owned team", async () => {
    // The user made an empty team during the beta, or co-owns someone's team.
    syncResponse = owns("ft_empty_team");
    fleets = { user_1: { services: [{ id: "printer" }] } };
    memberContext = () => memberResponse({ role: "owner" });

    await expect(resolveTenant()).resolves.toMatchObject({ tenant: "user_1" });
    const probed = await Promise.all(callsTo("/api/state").map(([, init]) => signedAs(init)));
    expect(probed).toEqual(["user_1", "ft_empty_team"]);
    const [[, member]] = callsTo("/api/member-context");
    expect(await signedAs(member)).toBe("user_1");
  });

  it("acts as an owned team that holds the fleet when the personal tenant is empty", async () => {
    syncResponse = owns("ft_empty", "ft_fleet");
    fleets = { ft_fleet: { services: [{ id: "printer" }] } };
    memberContext = () => memberResponse({ role: "owner" });

    await expect(requireAdmin()).resolves.toMatchObject({
      tenant: "ft_fleet",
      userId: "user_1",
      role: "owner",
      isAdmin: true,
      account: { name: "Team ft_fleet", kind: "team" },
    });
    const [[, member]] = callsTo("/api/member-context");
    expect(await signedAs(member)).toBe("ft_fleet");
  });

  it("counts finch_ keys as holding a fleet", async () => {
    syncResponse = owns("ft_keys");
    fleets = { ft_keys: { keys: [{ id: "k_1" }] } };
    memberContext = () => memberResponse({ role: "owner" });

    await expect(resolveTenant()).resolves.toMatchObject({ tenant: "ft_keys" });
  });

  it("stays on the personal tenant when no candidate holds anything", async () => {
    syncResponse = owns("ft_a", "ft_b");
    memberContext = () => memberResponse({ role: "owner" });

    await expect(resolveTenant()).resolves.toMatchObject({ tenant: "user_1" });
  });

  it("refuses to choose between two tenants that both hold a fleet", async () => {
    syncResponse = owns("ft_team");
    fleets = {
      user_1: { services: [{ id: "printer" }] },
      ft_team: { services: [{ id: "scanner" }] },
    };

    await expect(resolveTenant()).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('your personal account, "Team ft_team"'),
    });
    expect(callsTo("/api/member-context")).toHaveLength(0);
  });

  it("ignores a hub's own `tenant` pick and chooses from what the tenants hold", async () => {
    // The shape a hub that has cut workspaces answers with: owned first.
    syncResponse = () =>
      Response.json({
        tenant: "ft_empty",
        tenants: [
          { tenantId: "ft_empty", role: "owner", state: "active", name: "Empty", kind: "team" },
          { tenantId: "user_1", role: "owner", state: "invited", name: "user_1", kind: "personal" },
        ],
        claimable: [],
      });
    fleets = { user_1: { services: [{ id: "printer" }] } };
    memberContext = () => memberResponse({ role: "owner" });

    await expect(resolveTenant()).resolves.toMatchObject({ tenant: "user_1" });
  });

  it("fails closed on a failed or malformed state probe", async () => {
    syncResponse = owns("ft_team");
    for (const [response, status] of [
      [() => Response.json({ error: "down" }, { status: 503 }), 503],
      [() => Response.json({ services: "none", keys: [] }), 502],
      [() => new Response("<html>"), 502],
    ] as const) {
      stateResponse = response;
      await expect(resolveTenant()).rejects.toMatchObject({ status });
    }
    expect(callsTo("/api/member-context")).toHaveLength(0);
  });

  it("refuses another tenant when member-context does not report the user as its owner", async () => {
    syncResponse = owns("ft_someone_else");
    fleets = { ft_someone_else: { services: [{ id: "printer" }] } };
    for (const role of ["admin", "member"]) {
      memberContext = () => memberResponse({ role });
      await expect(resolveTenant()).rejects.toMatchObject({ status: 403 });
    }
  });

  it("fails closed on a malformed owner lookup", async () => {
    for (const body of [
      { tenant: "user_1" },
      { tenants: "user_1" },
      {},
      [],
      null,
    ]) {
      syncResponse = () => Response.json(body);
      await expect(resolveTenant()).rejects.toMatchObject({ status: 502 });
    }
    expect(callsTo("/api/member-context")).toHaveLength(0);
  });

  it("passes an owner-lookup rejection through without guessing a tenant", async () => {
    syncResponse = () => Response.json({ error: "directory unavailable" }, { status: 503 });

    await expect(resolveTenant()).rejects.toMatchObject({ status: 503 });
    expect(callsTo("/api/member-context")).toHaveLength(0);
  });

  it("bootstraps a new personal tenant with the verified primary email", async () => {
    const contexts = [
      Response.json({ member: null, tenantMeta: null, needsBootstrap: true }),
      memberResponse({ role: "owner", email: "owner@example.com" }),
    ];
    memberContext = () => contexts.shift()!;
    getUserMock.mockResolvedValue({
      primaryEmailAddressId: "em_2",
      emailAddresses: [
        { id: "em_1", emailAddress: "unverified@example.com", verification: { status: "unverified" } },
        { id: "em_2", emailAddress: "owner@example.com", verification: { status: "verified" } },
      ],
    });

    await expect(resolveTenant()).resolves.toMatchObject({ tenant: "user_1", role: "owner" });
    const calls = callsTo("/api/member-context");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1][1].body))).toEqual({
      clerkUserId: "user_1",
      email: "owner@example.com",
    });
    expect(await signedAs(calls[1][1])).toBe("user_1");
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
    expect(callsTo("/api/member-context")).toHaveLength(1);
  });

  it("never bootstraps a tenant other than the personal one", async () => {
    syncResponse = owns("ft_owned");
    fleets = { ft_owned: { services: [{ id: "printer" }] } };
    memberContext = () => Response.json({ member: null, tenantMeta: null, needsBootstrap: true });

    await expect(resolveTenant()).rejects.toMatchObject({ status: 403 });
    expect(getUserMock).not.toHaveBeenCalled();
    expect(callsTo("/api/member-context")).toHaveLength(1);
  });

  it("refuses a membership that is not active", async () => {
    for (const state of ["invited", "disabled"]) {
      memberContext = () => memberResponse({ role: "owner", state });
      await expect(resolveTenant()).rejects.toMatchObject({ status: 403 });
    }
    memberContext = () => Response.json({ member: null, tenantMeta: { id: "user_1" } });
    await expect(resolveTenant()).rejects.toMatchObject({ status: 403 });
  });

  it("fails closed when an active hub member carries an unknown role", async () => {
    memberContext = () => memberResponse({ role: "super-admin" });

    await expect(resolveTenant()).rejects.toMatchObject({ status: 502 });
    await expect(requireAdmin()).rejects.toMatchObject({ status: 502 });
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

  it("distinguishes a malformed member shape from a well-formed membership denial", async () => {
    memberContext = () => Response.json({ member: "owner" });

    await expect(resolveTenant()).rejects.toMatchObject({
      status: 502,
      message: "invalid response from hub",
    });
  });

  it("passes a hub rejection status through", async () => {
    memberContext = () => Response.json({ error: "nope" }, { status: 401 });

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

  it("mints user-scoped assertions that cannot authorize tenant-scoped calls", async () => {
    await userFetch("user_1", "/api/user/sync");

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const token = new Headers(init.headers).get("x-finch-auth")!;
    expect(await verifyAssertion(token, "service-secret")).toBeNull();
    expect(await verifyWithKind(token, "service-secret", "user")).toBe("user_1");
    expect(init.redirect).toBe("manual");
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
