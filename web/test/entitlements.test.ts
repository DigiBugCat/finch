import { describe, expect, it } from "vitest";

import { hasFeature } from "@/lib/entitlements";

describe("beta entitlements", () => {
  it("grants sharing to every valid tenant", async () => {
    await expect(hasFeature("tenant_123", "sharing")).resolves.toBe(true);
    await expect(hasFeature("a".repeat(128), "sharing")).resolves.toBe(true);
  });

  it("fails closed for malformed runtime values", async () => {
    await expect(hasFeature("../tenant", "sharing")).resolves.toBe(false);
    await expect(hasFeature("tenant_123", "billing" as never)).resolves.toBe(false);
  });
});
