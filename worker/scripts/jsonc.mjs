import { readFileSync } from "node:fs";

// Shared JSONC reader for the worker's deploy gates.
//
// This MUST agree with wrangler's own config loader, because both parse the
// same wrangler.jsonc and any disagreement means the gate inspects a different
// document than the deploy ships. Two properties matter:
//
//   1. A line comment ends at CR *or* LF. wrangler's bundled scanner uses
//      isLineBreak(ch) === (ch === 10 || ch === 13). Ending only at LF would
//      leave everything after a bare CR — up to the next LF — as live config to
//      wrangler but comment text here. Since wrangler's object builder is
//      last-wins on duplicate keys, such content can even override a clean
//      visible value, defeating every assertion in deploy-preflight.mjs and
//      check-privacy-invariants.mjs with nothing a reviewer would notice.
//   2. Comment markers inside quoted strings are not syntax — route
//      documentation legitimately contains wildcards like `finchmcp.com/*`.
//
// Both worker gates import this single copy so the two cannot drift apart, and
// so the behaviour is testable without executing a preflight's top-level code.
// Kept deliberately identical to web/scripts/jsonc.mjs.

/** Strip JSONC comments without treating comment markers inside JSON strings as
 * syntax. Newlines are preserved so JSON.parse locations remain useful. */
export function stripJsoncComments(raw) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (char === "\n" || char === "\r") {
        output += char;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      output += char;
    }
  }

  if (blockComment) throw new SyntaxError("unterminated JSONC block comment");
  return output;
}

export function parseJsonc(raw) {
  return JSON.parse(stripJsoncComments(raw));
}

export function readJsonc(path) {
  return parseJsonc(readFileSync(path, "utf8"));
}
