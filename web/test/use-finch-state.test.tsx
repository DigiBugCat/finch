import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useFinchState } from "@/components/dash/useFinchState";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function Probe() {
  const { state, refetch } = useFinchState();
  return (
    <div>
      <span data-testid="workspace">{state?.workspace?.name ?? "none"}</span>
      <button type="button" onClick={() => void refetch()}>refresh</button>
    </div>
  );
}

const tenants = {
  tenants: [{ tenantId: "user_1", kind: "personal", role: "owner", state: "active" }],
  claimable: [],
  activeTenant: "user_1",
};

function state(name: string) {
  return { workspace: { id: "user_1", name }, callerRole: "owner" };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("useFinchState request ordering", () => {
  it("does not let an older polling response overwrite newer state", async () => {
    const oldState = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(tenants))
      .mockReturnValueOnce(oldState.promise)
      .mockResolvedValueOnce(Response.json(state("new")));

    render(<Probe />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(await screen.findByText("new")).toBeInTheDocument();

    await act(async () => {
      oldState.resolve(Response.json(state("stale")));
      await oldState.promise;
    });

    expect(screen.getByTestId("workspace")).toHaveTextContent("new");
    expect(screen.queryByText("stale")).toBeNull();
  });
});
