// BFF route-handler test: GET /portal/start is the service login-wall bounce.
// The worker 302's an unauthenticated browser here; middleware has already
// forced Clerk sign-in. The handler resolves the tenant, asks the hub for a
// single-use portal grant (POST /api/portal-grant {slug,userId}), and 302's the
// browser to <slug>.finchmcp.com/__finch/cb?g=…&rd=….
//
// We mock Clerk's auth() and global fetch so no network/session is required.
import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
}));

// lib/hub reads these (runtimeEnv falls back to process.env under test).
process.env.HUB_URL = "https://hub.example.com";
process.env.FINCH_SERVICE_SECRET = "test-service-secret";

import { GET } from "@/app/portal/start/route";

beforeEach(() => {
  authMock.mockReset();
  vi.restoreAllMocks();
  authMock.mockResolvedValue({
    userId: "user_42",
    orgId: null,
    orgRole: null,
  });
});

function startReq(query: string): Request {
  return new Request(`https://finchmcp.com/portal/start${query}`);
}

describe("GET /portal/start", () => {
  it("mints a grant and 302's to <slug>.finchmcp.com/__finch/cb with grant+rd", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ grant: "GRANT_TOKEN" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const res = await GET(startReq("?slug=printer&rd=%2Fjobs%3Fa%3D1"));

    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc).toBe(
      "https://printer.finchmcp.com/__finch/cb" +
        "?g=GRANT_TOKEN&rd=" +
        encodeURIComponent("/jobs?a=1"),
    );

    // The hub was asked for a grant with the slug + signed-in userId.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [hubUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(hubUrl).toBe("https://hub.example.com/api/portal-grant");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ slug: "printer" });
    // Tenant is bound cryptographically by the assertion header.
    const headers = new Headers(init.headers);
    expect(headers.get("X-Finch-Service")).toBe("test-service-secret");
    expect(headers.get("X-Finch-Auth")).toBeTruthy();
  });

  it("collapses a protocol-relative rd to / (open-redirect guard)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ grant: "G" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await GET(startReq("?slug=printer&rd=%2F%2Fevil.com%2Fx"));

    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc).toBe(
      "https://printer.finchmcp.com/__finch/cb?g=G&rd=" +
        encodeURIComponent("/"),
    );
  });

  it("collapses an absolute-URL rd to / (open-redirect guard)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ grant: "G" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await GET(
      startReq("?slug=printer&rd=" + encodeURIComponent("https://evil.com/x")),
    );

    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("&rd=" + encodeURIComponent("/"));
  });

  it("rejects a slug that isn't a valid host key (host-injection guard)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Custom domains mean full hostnames are now syntactically allowed, but
    // anything that isn't clean lowercase DNS labels is refused before any
    // network call: path/scheme junk, empty labels, uppercase.
    for (const bad of [
      "evil.com/x",
      "https://evil.com",
      "evil..com",
      ".evil.com",
      "evil.com.",
      "evil_underscore.com",
      "",
    ]) {
      const res = await GET(
        startReq("?slug=" + encodeURIComponent(bad) + "&rd=%2F"),
      );
      expect(res.status, `slug=${JSON.stringify(bad)}`).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a full custom hostname only via the hub ownership check", async () => {
    // A syntactically valid full hostname is no longer rejected up front —
    // the hub verifies routerLookup(key) === tenant and 403s otherwise.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ grant: "G" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await GET(
      startReq("?slug=" + encodeURIComponent("mcp.customer.com") + "&rd=%2F"),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://mcp.customer.com/__finch/cb?g=G&rd=" + encodeURIComponent("/"),
    );
    // The grant request carried the full hostname as the slug/host key.
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).slug).toBe("mcp.customer.com");
  });

  it("surfaces a clean 403 when the tenant doesn't own the service", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not owner" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await GET(startReq("?slug=printer&rd=%2F"));

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toMatch(/not a member|ask its admin/i);
  });

  it("returns a clean 502 (not a 500) when the hub's 200 body isn't JSON", async () => {
    // A 200 with an empty/non-JSON body would throw in res.json(); the handler
    // must catch it and surface the same clean 502 as the missing-grant case
    // rather than letting the throw become an opaque 500.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await GET(startReq("?slug=printer&rd=%2F"));

    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/could not start the service session/i);
  });

  it("returns a clean 502 when the hub's 200 body omits the grant", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await GET(startReq("?slug=printer&rd=%2F"));

    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/could not start the service session/i);
  });

  it("redirects to /sign-in when unauthenticated", async () => {
    authMock.mockResolvedValue({ userId: null, orgId: null, orgRole: null });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await GET(startReq("?slug=printer&rd=%2F"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/sign-in");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
