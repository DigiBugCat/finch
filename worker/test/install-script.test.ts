import { describe, expect, it } from "vitest";
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import { installScript } from "../src/install-script";

// The installer's behaviour under a real shell (no sudo, ~/.local/bin fallback,
// FINCH_INSTALL_DIR, checksum check) is exercised in scripts/install-script.test.mjs;
// workerd cannot spawn a shell. Here: the route serves exactly that script,
// bound to the host it was fetched from.
async function get(host: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://${host}/install`, { headers: { host } }),
    env as any,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("GET /install", () => {
  it("serves the installer for the requesting hub, uncached", async () => {
    const res = await get("finchmcp.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toBe(installScript("https://finchmcp.com"));
    expect(body).toContain('HUB="https://finchmcp.com"');
  });

  it("uses plain http only for a loopback hub", async () => {
    expect(await (await get("localhost:8787")).text()).toContain('HUB="http://localhost:8787"');
    expect(await (await get("hub.test")).text()).toContain('HUB="https://hub.test"');
    expect(await (await get("[::1]:8787")).text()).toContain('HUB="http://[::1]:8787"');
    expect(await (await get("localhost.example.com")).text()).toContain('HUB="https://localhost.example.com"');
    expect(await (await get("127.0.0.1.nip.io")).text()).toContain('HUB="https://127.0.0.1.nip.io"');
  });

  it("never escalates privileges and honours FINCH_INSTALL_DIR", () => {
    const script = installScript("https://finchmcp.com");
    // No sudo/su/doas invocation anywhere: an agent runs this unattended.
    expect(script).not.toMatch(/(^|[\s;&|(])(sudo|doas|su)\s/m);
    expect(script).toContain("FINCH_INSTALL_DIR");
    expect(script).toContain('BIN_DIR="$HOME/.local/bin"');
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("creates its temporary files with mktemp in the install dir, never at PID-derived paths", () => {
    const script = installScript("https://finchmcp.com");
    expect(script).toContain('mktemp "$BIN_DIR/.finch-$1.XXXXXXXX"');
    expect(script).toContain('trap \'rm -f ${tmp:+"$tmp"} ${sums:+"$sums"}\' EXIT');
    expect(script).not.toContain("$$");
  });
});
