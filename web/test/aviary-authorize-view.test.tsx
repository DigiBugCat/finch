import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const navigation = vi.hoisted(() => ({ code: "WXYZ-2K7Q" }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(`code=${navigation.code}`),
}));

vi.mock("@clerk/nextjs", () => ({
  UserButton: () => <span data-testid="user-button" />,
}));

import AviaryAuthorize from "@/components/AviaryAuthorize";

const privateDescription = {
  found: true,
  status: "pending",
  manifest: {
    service: "Media search",
    app_path: "media",
    routes: ["/api/v1", "/birdz", "/mcp"],
    edge_auth: "key",
    machine: "aviary-01",
    machine_fingerprint: "SHA256:aa:bb:cc:device",
  },
  manifest_sha256: "07398c9e825977ddc90f8b1eebbeefcafe123456789abc",
  req_ip: "203.0.113.8",
  req_ua: "finch/1.6.0 linux/amd64",
  age_seconds: 14,
  expires_at: "2026-07-10T02:10:00Z",
  public_approval_required: false,
  public_approved: false,
};

beforeEach(() => {
  navigation.code = "WXYZ-2K7Q";
  vi.restoreAllMocks();
});

describe("AviaryAuthorize", () => {
  it("renders every immutable manifest and initiator field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(privateDescription));

    render(<AviaryAuthorize />);

    expect(await screen.findByText("Media search")).toBeInTheDocument();
    expect(screen.getByText("/media")).toBeInTheDocument();
    expect(screen.getByText("aviary-01")).toBeInTheDocument();
    expect(screen.getByText("SHA256:aa:bb:cc:device")).toBeInTheDocument();
    expect(screen.getByText("/api/v1")).toBeInTheDocument();
    expect(screen.getByText("/birdz")).toBeInTheDocument();
    expect(screen.getByText("/mcp")).toBeInTheDocument();
    expect(screen.getByText("203.0.113.8")).toBeInTheDocument();
    expect(screen.getByText("finch/1.6.0 linux/amd64")).toBeInTheDocument();
    expect(screen.getByText("14s ago")).toBeInTheDocument();
    expect(screen.getByText("…123456789abc")).toBeInTheDocument();
    expect(screen.getByText("2026-07-10T02:10:00Z")).toBeInTheDocument();
    expect(screen.getByText("Finch authenticated")).toBeInTheDocument();
  });

  it("requires a separate unchecked confirmation before public approval", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        ...privateDescription,
        manifest: { ...privateDescription.manifest, edge_auth: "public" },
        public_approval_required: true,
      }))
      .mockResolvedValueOnce(Response.json({ ok: true, status: "approved" }));

    render(<AviaryAuthorize />);

    const checkbox = await screen.findByRole("checkbox", {
      name: /allow unauthenticated public internet access/i,
    });
    const approve = screen.getByRole("button", { name: /approve exact manifest/i });
    expect(checkbox).not.toBeChecked();
    expect(approve).toBeDisabled();

    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(approve).toBeEnabled();
    fireEvent.click(approve);

    expect(await screen.findByText("✓ Service approved")).toBeInTheDocument();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      user_code: "WXYZ-2K7Q",
      public_approved: true,
    });
  });

  it("offers an explicit denial and reports that no credential was issued", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(privateDescription))
      .mockResolvedValueOnce(Response.json({ ok: true, status: "denied" }));

    render(<AviaryAuthorize />);

    const deny = await screen.findByRole("button", { name: /deny request/i });
    fireEvent.click(deny);

    expect(await screen.findByText("Request denied")).toBeInTheDocument();
    expect(screen.getByText(/no service credential was issued/i)).toBeInTheDocument();
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/finch/aviary-deny");
    expect(JSON.parse(init.body as string)).toEqual({ user_code: "WXYZ-2K7Q" });
  });

  it("shows expiry and app-path collisions as terminal, non-success states", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json(
        { error: { code: "expired", message: "expired" } },
        { status: 410 },
      ),
    );
    const { unmount } = render(<AviaryAuthorize />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/authorization has expired/i);
    expect(screen.queryByText("✓ Service approved")).not.toBeInTheDocument();
    unmount();

    fetchSpy
      .mockResolvedValueOnce(Response.json(privateDescription))
      .mockResolvedValueOnce(Response.json(
        { error: { code: "app_path_collision", message: "owned" } },
        { status: 409 },
      ));
    render(<AviaryAuthorize />);
    const approve = await screen.findByRole("button", { name: /approve exact manifest/i });
    fireEvent.click(approve);

    expect(await screen.findByRole("alert")).toHaveTextContent(/app path is already owned/i);
    expect(screen.queryByText("✓ Service approved")).not.toBeInTheDocument();
  });
});
