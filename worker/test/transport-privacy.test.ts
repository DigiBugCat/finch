import { describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker, { secureTransport } from "../src/index";

describe("public transport privacy boundary", () => {
  it("accepts HTTPS and local HTTP but rejects public plaintext HTTP", () => {
    const locked = { DEV: undefined, ALLOW_INSECURE_HTTP: undefined } as any;

    expect(secureTransport(new Request("https://tenant.finchmcp.com/app/mcp"), locked)).toBe(true);
    expect(secureTransport(new Request("http://localhost:8787/app/mcp"), locked)).toBe(true);
    expect(secureTransport(new Request("http://127.0.0.1:8787/app/mcp"), locked)).toBe(true);
    expect(secureTransport(new Request("http://tenant.finchmcp.com/app/mcp"), locked)).toBe(false);
    expect(
      secureTransport(new Request("http://tenant.finchmcp.com/app/mcp"), {
        DEV: undefined,
        ALLOW_INSECURE_HTTP: "1",
      } as any),
    ).toBe(false);
    expect(
      secureTransport(new Request("http://tenant.finchmcp.com/app/mcp"), {
        DEV: "1",
        ALLOW_INSECURE_HTTP: "1",
      } as any),
    ).toBe(true);
  });

  it("ignores the insecure escape hatch in a production-shaped environment", async () => {
    const lockedEnv = {
      ...(env as any),
      // A stray or injected escape-hatch value must not weaken a deployment
      // whose DEV marker is absent.
      ALLOW_INSECURE_HTTP: "1",
      DEV: undefined,
      DEFAULT_TENANT: undefined,
    };
    const response = await worker.fetch(
      new Request("http://tenant.finchmcp.com/app/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret_marker: "must-not-be-processed" }),
      }),
      lockedEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(426);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "HTTPS is required" });
  });
});
