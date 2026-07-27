import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AreaChart } from "@/components/dash/charts";

describe("AreaChart adversarial inputs", () => {
  it("preserves hook order when a polled series changes from empty to populated", () => {
    const view = render(<AreaChart values={[]} />);
    expect(view.container.querySelector("svg")).toBeNull();

    expect(() => view.rerender(<AreaChart values={[1, 2, 3]} />)).not.toThrow();
    expect(view.container.querySelector("svg")).not.toBeNull();
  });

  it("renders a single sample without NaN or Infinity coordinates", () => {
    const { container } = render(<AreaChart values={[5]} />);
    const markup = container.innerHTML;
    expect(markup).not.toMatch(/NaN|Infinity/);
    expect(container.querySelector("path")?.getAttribute("d")).toContain("M320,");
  });

  it("sanitizes non-finite values and invalid dimensions", () => {
    const { container } = render(
      <AreaChart values={[Number.NaN, Number.POSITIVE_INFINITY, -5, 2]} w={0} h={-1} />,
    );
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 640 150");
  });

  it("bounds SVG work for an unexpectedly large series", () => {
    const values = Array.from({ length: 100_000 }, (_, index) => index);
    const { container } = render(<AreaChart values={values} area={false} grid={false} />);
    const path = container.querySelector("path")?.getAttribute("d") ?? "";
    expect(path.match(/[ML]/g)).toHaveLength(2_048);
    expect(path.length).toBeLessThan(40_000);
  });

  it("returns no chart for malformed non-array data", () => {
    const { container } = render(<AreaChart values={{ length: 3 }} />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
