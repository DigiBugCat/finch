import assert from "node:assert/strict";
import { test } from "node:test";

import { assertReviewedConsoleSource } from "./check-privacy-invariants.mjs";
import { parseJsonc } from "./jsonc.mjs";

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
        console.error("tenant directory index failed", { tenantId, error }),
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

// REGRESSION: the deploy gates parse wrangler.jsonc with their own reader, and
// it MUST agree with wrangler's on where a line comment ends. wrangler's scanner
// uses isLineBreak(ch) === (ch === 10 || ch === 13), so a bare CR terminates a
// comment there. When these gates ended a comment only at LF, everything after a
// CR up to the next LF was live config to wrangler and invisible here — and
// because wrangler's object builder is last-wins on duplicate keys, it could
// override a clean visible value. That silently defeats every assertion in both
// gates (the prod DEV/DEFAULT_TENANT ban, workers_dev, the route contract, the
// DO bindings, the shipped-vars secret scan) with no artifact in a diff.
test("a bare CR ends a line comment, matching wrangler's parser", () => {
  // One physical line: comment text, CR, then config, then a real newline.
  const raw = '{\n  "vars": { // note\r "DEV": "1" }\n}\n';
  const parsed = parseJsonc(raw);
  assert.equal(
    parsed.vars.DEV,
    "1",
    "config after a bare CR must be visible to the gate, as it is to wrangler",
  );
});

test("last-wins on a duplicate key hidden after a CR", () => {
  // The dangerous shape: a clean value on the visible line, overridden after CR.
  const raw = '{\n  "workers_dev": false, // ok\r "workers_dev": true\n}\n';
  assert.equal(parseJsonc(raw).workers_dev, true);
});

test("comment markers inside strings are still not treated as syntax", () => {
  const raw = '{\n  "routes": ["finchmcp.com/*"] // trailing\n}\n';
  assert.deepEqual(parseJsonc(raw).routes, ["finchmcp.com/*"]);
});
