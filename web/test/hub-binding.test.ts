import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  clerkClient: vi.fn(),
}));

import { verifyAssertion } from "@worker-auth";
import { hubFetchAs, userFetch } from "@/lib/hub";
import { installCloudflareContext, workerdFetch } from "./cloudflare-context";

// The web→hub bridge must ride the FINCH_HUB service binding whenever the
// Cloudflare env provides one (every deployed env binds it in wrangler.jsonc),
// and fall back to a public fetch of HUB_URL only when it doesn't (`next dev`,
// unit tests). Either way the request must be byte-for-byte the same one: same
// URL, same service secret + signed assertion, same refusal to follow redirects.

const SECRET = "binding-secret";
const HUB_URL = "https://hub.example.test";

let restoreContext: (() => void) | undefined;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = { HUB_URL: process.env.HUB_URL, FINCH_SERVICE_SECRET: process.env.FINCH_SERVICE_SECRET };
  // Deployed, vars and secrets live on the Cloudflare env, not process.env.
  delete process.env.HUB_URL;
  delete process.env.FINCH_SERVICE_SECRET;
});

afterEach(() => {
  restoreContext?.();
  restoreContext = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

function deployedEnv(extra: Record<string, unknown> = {}) {
  return { HUB_URL, FINCH_SERVICE_SECRET: SECRET, ...extra };
}

describe("hub bridge transport", () => {
  it("calls the FINCH_HUB binding, not the public internet, when it is bound", async () => {
    const binding = { fetch: workerdFetch(() => Response.json({ ok: true })) };
    const publicFetch = workerdFetch(() => Response.json({ ok: true }));
    vi.stubGlobal("fetch", publicFetch);
    restoreContext = installCloudflareContext(deployedEnv({ FINCH_HUB: binding }));

    const res = await hubFetchAs("org_1", "/api/state?viewer=mem_1", { method: "POST", body: "{}" });

    expect(res.status).toBe(200);
    expect(publicFetch).not.toHaveBeenCalled();
    expect(binding.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = binding.fetch.mock.calls[0] as [string, RequestInit];
    // Same URL the public path uses: the hub derives its own host from it.
    expect(url).toBe("https://hub.example.test/api/state?viewer=mem_1");
    expect(init.redirect).toBe("manual");
    const headers = new Headers(init.headers);
    expect(headers.get("x-finch-service")).toBe(SECRET);
    expect(await verifyAssertion(headers.get("x-finch-auth")!, SECRET)).toBe("org_1");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("overwrites caller-supplied auth headers on the binding path too", async () => {
    const binding = { fetch: workerdFetch(() => Response.json({ ok: true })) };
    vi.stubGlobal("fetch", workerdFetch(() => Response.json({ ok: true })));
    restoreContext = installCloudflareContext(deployedEnv({ FINCH_HUB: binding }));

    await hubFetchAs("user_1", "/api/member-context", {
      method: "POST",
      body: "{}",
      headers: { "X-Finch-Service": "attacker", "X-Finch-Auth": "attacker" },
    });

    expect(fetch).not.toHaveBeenCalled();
    const [url, init] = binding.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.test/api/member-context");
    expect(init.redirect).toBe("manual");
    const headers = new Headers(init.headers);
    expect(headers.get("x-finch-service")).toBe(SECRET);
    expect(await verifyAssertion(headers.get("x-finch-auth")!, SECRET)).toBe("user_1");
  });

  it("sends user-scoped assertions over the binding too", async () => {
    const binding = { fetch: workerdFetch(() => Response.json({ ok: true })) };
    vi.stubGlobal("fetch", workerdFetch(() => Response.json({ ok: true })));
    restoreContext = installCloudflareContext(deployedEnv({ FINCH_HUB: binding }));

    await userFetch("user_1", "/api/user/sync", {
      method: "POST",
      body: "{}",
      headers: { "X-Finch-Service": "attacker", "X-Finch-Auth": "attacker" },
    });

    expect(fetch).not.toHaveBeenCalled();
    const [url, init] = binding.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.test/api/user/sync");
    expect(init.redirect).toBe("manual");
    const headers = new Headers(init.headers);
    expect(headers.get("x-finch-service")).toBe(SECRET);
    const verifyWithKind = verifyAssertion as unknown as (
      token: string,
      secret: string,
      expectedKind: string,
    ) => Promise<string | null>;
    expect(await verifyWithKind(headers.get("x-finch-auth")!, SECRET, "user")).toBe("user_1");
  });

  it("refuses a 3xx the hub returns over the binding", async () => {
    const binding = {
      fetch: workerdFetch(
        () => new Response(null, { status: 307, headers: { location: "https://elsewhere.test/" } }),
      ),
    };
    restoreContext = installCloudflareContext(deployedEnv({ FINCH_HUB: binding }));

    await expect(hubFetchAs("org_1", "/api/state")).rejects.toMatchObject({
      status: 502,
      message: "hub returned a redirect",
    });
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });

  it("validates the request before anything reaches the binding", async () => {
    const binding = { fetch: workerdFetch(() => Response.json({})) };
    restoreContext = installCloudflareContext(deployedEnv({ FINCH_HUB: binding }));

    await expect(hubFetchAs("org_1", "/api/../admin")).rejects.toMatchObject({ status: 500 });
    await expect(hubFetchAs("bad tenant", "/api/state")).rejects.toMatchObject({ status: 500 });
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it("still requires HUB_URL with a binding, since it names the hub's host", async () => {
    const binding = { fetch: workerdFetch(() => Response.json({})) };
    restoreContext = installCloudflareContext({ FINCH_SERVICE_SECRET: SECRET, FINCH_HUB: binding });

    await expect(hubFetchAs("org_1", "/api/state")).rejects.toMatchObject({ status: 500 });
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it("falls back to a public fetch of HUB_URL when the env has no binding", async () => {
    const publicFetch = workerdFetch(() => Response.json({ ok: true }));
    vi.stubGlobal("fetch", publicFetch);
    restoreContext = installCloudflareContext(deployedEnv());

    await hubFetchAs("org_1", "/api/state");

    expect(publicFetch).toHaveBeenCalledTimes(1);
    const [url, init] = publicFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hub.example.test/api/state");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("x-finch-service")).toBe(SECRET);
  });

  it("falls back to a public fetch outside the Cloudflare adapter entirely", async () => {
    const publicFetch = workerdFetch(() => Response.json({ ok: true }));
    vi.stubGlobal("fetch", publicFetch);
    process.env.HUB_URL = "http://localhost:8787";
    process.env.FINCH_SERVICE_SECRET = SECRET;

    await hubFetchAs("org_1", "/api/state");

    expect(publicFetch.mock.calls[0][0]).toBe("http://localhost:8787/api/state");
  });

  it("ignores a FINCH_HUB env value that is not a Fetcher", async () => {
    const publicFetch = workerdFetch(() => Response.json({ ok: true }));
    vi.stubGlobal("fetch", publicFetch);
    restoreContext = installCloudflareContext(deployedEnv({ FINCH_HUB: "finch-prod" }));

    await hubFetchAs("org_1", "/api/state");

    expect(publicFetch).toHaveBeenCalledTimes(1);
  });
});

describe("workerd fetch double", () => {
  // Guard the guard: if the double ever accepted redirect: "error" again, the
  // transport tests above would pass against code that throws in production.
  it("rejects the redirect modes workerd rejects, and relative URLs", async () => {
    const f = workerdFetch(() => new Response(null));
    await expect(f("https://hub.example.test/", { redirect: "error" })).rejects.toBeInstanceOf(TypeError);
    await expect(f("/api/state", {})).rejects.toBeInstanceOf(TypeError);
    await expect(f("https://hub.example.test/", { redirect: "manual" })).resolves.toBeInstanceOf(Response);
  });
});
