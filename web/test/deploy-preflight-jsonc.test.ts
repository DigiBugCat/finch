import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseJsonc, stripJsoncComments } from "@/scripts/jsonc.mjs";

describe("deploy preflight JSONC parser", () => {
  it("preserves comment markers inside quoted values while removing real comments", () => {
    const parsed = parseJsonc(`{
      // line comment
      "url": "https://example.com/a//b",
      "note": "keep // this /* too */ after text",
      "escaped": "quote: \\\" // still quoted",
      /* block
         comment */
      "enabled": true
    }`);
    expect(parsed).toEqual({
      url: "https://example.com/a//b",
      note: "keep // this /* too */ after text",
      escaped: 'quote: " // still quoted',
      enabled: true,
    });
  });

  it("rejects an unterminated block comment", () => {
    expect(() => stripJsoncComments('{"ok":true} /*')).toThrow(/unterminated/i);
  });

  it("keeps production telemetry and workers.dev deployment invariants pinned", () => {
    const config = parseJsonc(readFileSync(resolve(import.meta.dirname, "../wrangler.jsonc"), "utf8"));
    const production = config.env.production;
    expect(production.observability.enabled).toBe(false);
    expect(production.logpush).toBe(false);
    expect(production.workers_dev).toBe(false);
  });
});
