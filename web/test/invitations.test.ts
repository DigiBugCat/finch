import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const createInvitation = vi.fn();
  return {
    createInvitation,
    clerkClient: vi.fn(async () => ({ invitations: { createInvitation } })),
  };
});
vi.mock("@clerk/nextjs/server", () => ({ clerkClient: mocks.clerkClient }));

import { deliverApplicationInvite } from "@/lib/invitations";

describe("application invitation delivery", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("sends a notification with a canonical dashboard redirect", async () => {
    mocks.createInvitation.mockResolvedValue({ id: "inv_1" });
    await expect(
      deliverApplicationInvite("user@example.com", "https://finchmcp.com/"),
    ).resolves.toBe("sent");
    expect(mocks.createInvitation).toHaveBeenCalledWith({
      emailAddress: "user@example.com",
      redirectUrl: "https://finchmcp.com/dashboard",
      ignoreExisting: true,
      notify: true,
    });
  });

  it("rejects malformed input before consulting Clerk", async () => {
    for (const [email, origin] of [
      ["not-an-email", "https://finchmcp.com"],
      [`${"a".repeat(65)}@example.com`, "https://finchmcp.com"],
      ["user@example.com\nBcc:evil@example.com", "https://finchmcp.com"],
      ["user@example.com", "http://finchmcp.com"],
      ["user@example.com", "https://finchmcp.com/other"],
      ["user@example.com", "https://finchmcp.com?next=evil"],
      ["user@example.com", "https://finchmcp.com@evil.example"],
      ["user@example.com", "not a URL"],
    ]) {
      await expect(deliverApplicationInvite(email, origin)).resolves.toBe("failed");
    }
    expect(mocks.clerkClient).not.toHaveBeenCalled();
  });

  it("recognizes a known duplicate code anywhere in Clerk's error list", async () => {
    mocks.createInvitation.mockRejectedValue({
      errors: [{ code: "rate_limit_exceeded" }, { code: "already_invited" }],
    });
    await expect(
      deliverApplicationInvite("user@example.com", "https://finchmcp.com"),
    ).resolves.toBe("existing-user");
  });

  it("does not misclassify unrelated codes containing broad keywords", async () => {
    const error = { code: "request_already_rate_limited" };
    mocks.createInvitation.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      deliverApplicationInvite("user@example.com", "https://finchmcp.com"),
    ).resolves.toBe("failed");
    expect(consoleError).toHaveBeenCalledWith("Finch invitation delivery failed", error);
    consoleError.mockRestore();
  });

  it("contains malformed provider errors instead of rejecting", async () => {
    const corruptError = new Proxy({}, {
      get() {
        throw new Error("corrupt provider error");
      },
    });
    mocks.createInvitation.mockRejectedValue(corruptError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      deliverApplicationInvite("user@example.com", "http://localhost:3000"),
    ).resolves.toBe("failed");
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
