import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import {
  activeTenantCookieName,
  clearActiveTenant,
  readActiveTenant,
  validTenantId,
  writeActiveTenant,
} from "@/lib/tenant-cookie";

type CookieStore = NonNullable<Parameters<typeof readActiveTenant>[0]>;

function cookieStore(value?: string) {
  return {
    get: vi.fn(() => value === undefined ? undefined : { value }),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as CookieStore;
}

describe("active tenant cookie", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts only bounded opaque tenant IDs", () => {
    expect(validTenantId("a_B-9")).toBe(true);
    expect(validTenantId("a".repeat(128))).toBe(true);
    for (const invalid of [
      "",
      "a".repeat(129),
      "tenant.id",
      "tenant/id",
      " tenant",
      "tenant\nSet-Cookie:x=y",
      "ténant",
      null,
      42,
    ]) {
      expect(validTenantId(invalid)).toBe(false);
    }
  });

  it("ignores a malformed stored value", async () => {
    const store = cookieStore("../other-tenant");
    await expect(readActiveTenant(store)).resolves.toBeNull();
  });

  it("writes the production __Host cookie with defensive attributes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const store = cookieStore();
    await writeActiveTenant("tenant_123", store);
    expect(activeTenantCookieName()).toBe("__Host-finch_active_tenant");
    expect(store.set).toHaveBeenCalledWith(
      "__Host-finch_active_tenant",
      "tenant_123",
      {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 31_536_000,
      },
    );
  });

  it("rejects invalid IDs before mutating cookie state", async () => {
    const store = cookieStore();
    await expect(writeActiveTenant("tenant/id", store)).rejects.toThrow("invalid tenant id");
    expect(store.set).not.toHaveBeenCalled();
  });

  it("clears the environment-specific cookie", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const store = cookieStore();
    await clearActiveTenant(store);
    expect(store.delete).toHaveBeenCalledWith("finch_active_tenant");
  });
});
