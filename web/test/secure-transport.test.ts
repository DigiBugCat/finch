import { describe, expect, it } from "vitest";

import { isSecurePublicRequest } from "@/lib/secure-transport";

describe("web transport boundary", () => {
  it("accepts production HTTPS and loopback HTTP", () => {
    expect(isSecurePublicRequest("https://finchmcp.com/cli")).toBe(true);
    expect(isSecurePublicRequest("https://tenant.finchmcp.com/service/mcp")).toBe(true);
    expect(isSecurePublicRequest("http://localhost:3000/cli")).toBe(true);
    expect(isSecurePublicRequest("http://127.0.0.2:3000/cli")).toBe(true);
    expect(isSecurePublicRequest("http://[::1]:3000/cli")).toBe(true);
  });

  it("rejects plaintext or non-HTTP public transports", () => {
    expect(isSecurePublicRequest("http://finchmcp.com/cli")).toBe(false);
    expect(isSecurePublicRequest("http://192.168.1.20:3000/cli")).toBe(false);
    expect(isSecurePublicRequest("http://localhost.example/cli")).toBe(false);
    expect(isSecurePublicRequest("ftp://finchmcp.com/cli")).toBe(false);
  });

  it("fails closed for malformed and misleading URLs", () => {
    expect(isSecurePublicRequest("not a URL")).toBe(false);
    expect(isSecurePublicRequest("http://127.0.0.999/cli")).toBe(false);
    expect(isSecurePublicRequest("https://finchmcp.com@evil.example/cli")).toBe(false);
    expect(isSecurePublicRequest("https://user:secret@finchmcp.com/cli")).toBe(false);
    expect(isSecurePublicRequest(null as never)).toBe(false);
    expect(isSecurePublicRequest(new URL("https://finchmcp.com") as never)).toBe(false);
  });
});
