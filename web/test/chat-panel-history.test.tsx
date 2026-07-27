import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/dash/ChatPanel";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ChatPanel bounded history", () => {
  it("submits the 16th turn without exceeding the BFF history limit", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ reply: `reply ${fetchSpy.mock.calls.length}`, trace: [] }),
    );
    render(<ChatPanel service="calendar" online={true} />);

    for (let turn = 1; turn <= 16; turn += 1) {
      fireEvent.change(screen.getByPlaceholderText("Message calendar…"), {
        target: { value: `question ${turn}` },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(await screen.findByText(`reply ${turn}`)).toBeInTheDocument();
    }

    expect(fetchSpy).toHaveBeenCalledTimes(16);
    const [, init] = fetchSpy.mock.calls[15] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages.length).toBeLessThanOrEqual(30);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "question 16" });
  });
});
