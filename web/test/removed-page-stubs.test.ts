import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GET as dashboard } from "@/app/dashboard/route";

const appDir = resolve(import.meta.dirname, "../app");

describe("pages removed with the CLI cut", () => {
  // Released agents' tray still opens /dashboard[?service=<id>], and people
  // have it bookmarked.
  it("sends the old dashboard (tray links, bookmarks) to the fleet page", () => {
    const response = dashboard();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/fleet");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  // The hub stopped linking to these once the cut deployed, so their
  // temporary stubs are gone too: they 404 like any unknown page.
  it("serves no login-wall or Aviary approval stub any more", () => {
    for (const route of ["portal/start/route.ts", "aviary/authorize/route.ts", "portal", "aviary"]) {
      expect(existsSync(resolve(appDir, route)), route).toBe(false);
    }
  });
});
