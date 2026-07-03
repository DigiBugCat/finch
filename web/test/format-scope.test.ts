// Unit tests for formatScope (components/dash/data.ts) — the fix for the
// "[object Object]" scope-render bug. The hub returns a STRUCTURED KeyScope
// object; the Keys table must show a human label, not the stringified object.
import { describe, it, expect } from "vitest";
import { formatScope, type KeyScope } from "@/components/dash/data";

describe("formatScope", () => {
  it('renders {all:true} as "all services"', () => {
    expect(formatScope({ all: true })).toBe("all services");
  });

  it("renders a service allow-list as a comma-joined id list", () => {
    const scope: KeyScope = { appliances: ["calendar-sync", "printer"] };
    expect(formatScope(scope)).toBe("calendar-sync, printer");
  });

  it('renders an empty allow-list as "no services"', () => {
    expect(formatScope({ appliances: [] })).toBe("no services");
  });

  it("never returns the stringified object (the bug it fixes)", () => {
    const out = formatScope({ all: true });
    expect(out).not.toContain("[object Object]");
  });

  it("tolerates null / undefined / malformed scope", () => {
    expect(formatScope(null)).toBe("—");
    expect(formatScope(undefined)).toBe("—");
    // A legacy/garbage value with no `all` and no array falls back safely.
    expect(formatScope({} as unknown as KeyScope)).toBe("no services");
  });
});
