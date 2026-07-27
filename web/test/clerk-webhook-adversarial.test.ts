import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnv } from "./test-env";

const verifyWebhookMock = vi.fn();
vi.mock("@clerk/nextjs/webhooks", () => ({
  verifyWebhook: (...args: unknown[]) => verifyWebhookMock(...args),
}));
vi.mock("@clerk/nextjs/server", () => ({ clerkClient: vi.fn() }));

setupTestEnv({
  HUB_URL: "https://hub.example.com",
  FINCH_SERVICE_SECRET: "test-service-secret",
  CLERK_WEBHOOK_SECRET: "whsec_test",
});

import { POST } from "@/app/api/webhooks/clerk/route";

function request(body = "{}"): Parameters<typeof POST>[0] {
  return new Request("https://app.example.com/api/webhooks/clerk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }) as Parameters<typeof POST>[0];
}

beforeEach(() => {
  verifyWebhookMock.mockReset();
  vi.restoreAllMocks();
});

describe("Clerk webhook adversarial boundaries", () => {
  it("drops malformed verified email rows without crashing or syncing junk", async () => {
    verifyWebhookMock.mockResolvedValue({
      type: "user.updated",
      data: {
        id: "user_1",
        primary_email_address_id: "email_1",
        email_addresses: [
          { id: "email_1", verification: { status: "verified" } },
          { id: "email_2", email_address: { value: "bad" }, verification: { status: "verified" } },
        ],
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("normalizes and deduplicates verified emails before syncing", async () => {
    verifyWebhookMock.mockResolvedValue({
      type: "user.updated",
      data: {
        id: "user_1",
        primary_email_address_id: "email_2",
        email_addresses: [
          { id: "email_1", email_address: " User@Example.com ", verification: { status: "verified" } },
          { id: "email_2", email_address: "user@example.com", verification: { status: "verified" } },
          { id: "email_3", email_address: "other@example.com", verification: { status: "unverified" } },
        ],
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
    const response = await POST(request());
    expect(response.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      emails: ["user@example.com"],
      primaryEmail: "user@example.com",
    });
  });

  it.each([
    null,
    {},
    { type: "user.created", data: null },
    { type: "user.created", data: { id: "bad/id", email_addresses: [] } },
    { type: "organizationMembership.created", data: { public_user_data: {}, organization: {} } },
  ])("rejects a malformed signed event envelope", async (event) => {
    verifyWebhookMock.mockResolvedValue(event);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an oversized webhook before signature verification", async () => {
    const response = await POST(request("x".repeat(1024 * 1024 + 1)));
    expect(response.status).toBe(413);
    expect(verifyWebhookMock).not.toHaveBeenCalled();
  });
});
