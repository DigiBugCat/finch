// Render test for KeysView (components/dash/panels.tsx): a key whose `scope` is
// a STRUCTURED KeyScope object must render a human label in the scope column,
// NOT "[object Object]" (the bug fixed in #2). Exercises the real component +
// formatScope wiring through React.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KeysView } from "@/components/dash/panels";
import type { PublicKey } from "@/components/dash/data";

const keys: PublicKey[] = [
  {
    id: "k_1",
    label: "laptop",
    owner: "you",
    created: "2026-06-14",
    scope: { all: true },
    last4: "ab12",
  },
  {
    id: "k_2",
    label: "scoped",
    owner: "you",
    created: "2026-06-14",
    scope: { appliances: ["calendar-sync"] },
    last4: "cd34",
  },
];

describe("KeysView scope column", () => {
  it("renders structured scopes as labels, never [object Object]", () => {
    render(
      <KeysView
        keys={keys}
        users={[{ name: "you" }]}
        onMint={() => {}}
        onRevoke={() => {}}
      />,
    );
    expect(screen.getByText("all services")).toBeInTheDocument();
    expect(screen.getByText("calendar-sync")).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });
});
