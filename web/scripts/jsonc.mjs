import { readFileSync } from "node:fs";

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
