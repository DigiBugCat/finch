import { describe, expect, it } from "vitest";
import { GET as portalStart } from "@/app/portal/start/route";
import { GET as aviaryAuthorize } from "@/app/aviary/authorize/route";
import { GET as dashboard } from "@/app/dashboard/route";

// A hub that predates the CLI cut still links browsers to these removed pages;
// until it is redeployed they must answer plainly rather than 404.
describe("stubs for pages an older hub still links to", () => {
  it("answers the old login-wall redirect with a plain-text 401", async () => {
    const response = portalStart();
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toMatch(/finch_ key/);
  });

  it("answers the old Aviary approval link with 410 Gone", async () => {
    const response = aviaryAuthorize();
    expect(response.status).toBe(410);
    expect(await response.text()).toMatch(/removed/);
  });

  // Released agents' tray still opens /dashboard[?service=<id>].
  it("sends the old dashboard (tray links, bookmarks) to the docs", () => {
    const response = dashboard();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/docs");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
