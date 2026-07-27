import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  hubFetchAs: vi.fn(),
}));

vi.mock("@/lib/hub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hub")>()),
  requireAdmin: mocks.requireAdmin,
  hubFetchAs: mocks.hubFetchAs,
}));

import { DELETE, GET as getHostnames, POST } from "@/app/api/finch/hostnames/route";
import { GET as checkSlug } from "@/app/api/finch/slug-check/route";

const request = (method: string, body: string | unknown) => new Request("https://app.example/api", {
  method,
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ tenant: "org_selected" });
  mocks.hubFetchAs.mockResolvedValue(Response.json({ ok: true }));
});

describe("slug availability bridge", () => {
  it("normalizes one valid DNS label and binds the hub call to the authorized tenant snapshot", async () => {
    mocks.hubFetchAs.mockResolvedValue(Response.json({ slug: "sunny-wren", available: true }));

    const response = await checkSlug(new Request("https://app.example/api?slug=%20Sunny-Wren%20"));

    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.hubFetchAs).toHaveBeenCalledWith(
      "org_selected",
      "/api/slug-available?slug=sunny-wren",
      { method: "GET" },
    );
  });

  it("rejects malformed and boundary-breaking labels without touching the hub", async () => {
    for (const slug of ["", "-bad", "bad-", "a".repeat(64), "two.labels", "bad_underscore"]) {
      const response = await checkSlug(new Request(`https://app.example/api?slug=${encodeURIComponent(slug)}`));
      expect(response.status).toBe(400);
    }
    expect(mocks.hubFetchAs).not.toHaveBeenCalled();
  });

  it("preserves hub status and content type", async () => {
    mocks.hubFetchAs.mockResolvedValue(new Response("busy", {
      status: 429,
      headers: { "content-type": "text/plain" },
    }));

    const response = await checkSlug(new Request("https://app.example/api?slug=valid"));

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("busy");
  });
});

describe("custom hostname bridge", () => {
  it("uses the authorized tenant directly for GET instead of resolving mutable state twice", async () => {
    mocks.hubFetchAs.mockResolvedValue(Response.json({ hostnames: ["mcp.example.com"] }));

    const response = await getHostnames();

    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.hubFetchAs).toHaveBeenCalledWith("org_selected", "/api/hostnames", { method: "GET" });
  });

  it("normalizes and forwards only the hostname field for both mutations", async () => {
    for (const [handler, method] of [[POST, "POST"], [DELETE, "DELETE"]] as const) {
      await handler(request(method, { hostname: " MCP.Example.COM ", ignored: "not-forwarded" }));
      expect(mocks.hubFetchAs).toHaveBeenLastCalledWith("org_selected", "/api/hostnames", {
        method,
        body: JSON.stringify({ hostname: "mcp.example.com" }),
      });
    }
  });

  it("rejects malformed, non-object, invalid, and oversized bodies before the hub", async () => {
    const cases = [
      request("POST", "{"),
      request("POST", "null"),
      request("POST", { hostname: "-bad.example.com" }),
      request("POST", { hostname: `ok.example.com${" ".repeat(4096)}` }),
    ];
    const statuses = [];
    for (const req of cases) statuses.push((await POST(req)).status);
    expect(statuses).toEqual([400, 400, 400, 413]);
    expect(mocks.hubFetchAs).not.toHaveBeenCalled();
  });

  it("accepts the DNS maximum and rejects label and hostname overflow", async () => {
    const maxHostname = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(maxHostname).toHaveLength(253);
    expect((await POST(request("POST", { hostname: maxHostname }))).status).toBe(200);

    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ tenant: "org_selected" });
    for (const hostname of [`${"a".repeat(64)}.example.com`, `${maxHostname}x`]) {
      expect((await POST(request("POST", { hostname }))).status).toBe(400);
    }
    expect(mocks.hubFetchAs).not.toHaveBeenCalled();
  });
});
