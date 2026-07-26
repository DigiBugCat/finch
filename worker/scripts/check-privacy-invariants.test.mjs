import assert from "node:assert/strict";
import { test } from "node:test";

import { assertReviewedConsoleSource } from "./check-privacy-invariants.mjs";

test("accepts only the reviewed metadata-only console shapes", () => {
  assert.doesNotThrow(() =>
    assertReviewedConsoleSource(`
      try { throw new Error("offline"); } catch (error) {
        console.error(
          "caller assertion signing failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      const tenantId = "tenant-1";
      Promise.reject(new Error("offline")).catch((error) =>
        console.error("tenant directory reindex failed", { tenantId, error }),
      );
    `),
  );
});

const evasions = {
  "renamed request data": `
    function leak(req) {
      const error = req;
      console.error(
        "caller assertion signing failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  `,
  "bracket console access": `
    function leak(req) {
      console["error"]("caller assertion signing failed", req);
    }
  `,
  "aliased console method": `
    function leak(req) {
      const log = console.error;
      log("caller assertion signing failed", req);
    }
  `,
};

for (const [name, source] of Object.entries(evasions)) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => assertReviewedConsoleSource(source, `${name}.ts`),
      /privacy invariant failed/,
    );
  });
}
