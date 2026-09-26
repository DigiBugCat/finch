import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// workerd implements only redirect "follow" and "manual" — `redirect: "error"`
// throws a TypeError at call time. That took every web→hub bridge route down in
// production (#37) while the unit tests, whose fetch mocks accepted any value,
// stayed green. Both the web (OpenNext on workerd) and the hub (worker/src) run
// on workerd, so refuse the literal anywhere in their shipped source. Use
// redirect: "manual" and reject the 3xx instead (see fetchHubNoRedirect).

const webRoot = path.resolve(import.meta.dirname, "..");
const SCANNED = [
  path.join(webRoot, "app"),
  path.join(webRoot, "lib"),
  path.join(webRoot, "components"),
  path.join(webRoot, "middleware.ts"),
  path.resolve(webRoot, "../worker/src"),
];
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const REDIRECT_ERROR = /\bredirect\s*:\s*["'`]error["'`]/;

function sourceFiles(entry: string): string[] {
  if (!statSync(entry).isDirectory()) return SOURCE.test(entry) ? [entry] : [];
  return readdirSync(entry).flatMap((name) => sourceFiles(path.join(entry, name)));
}

/** `file:line` for every non-comment line passing redirect: "error". */
function offenders(files: string[]): string[] {
  return files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) => {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return [];
        return REDIRECT_ERROR.test(line) ? [`${path.relative(webRoot, file)}:${i + 1}`] : [];
      }),
  );
}

describe('no fetch passes redirect: "error" (workerd throws on it)', () => {
  it("finds no offender in web/ or worker/src", () => {
    const files = SCANNED.flatMap(sourceFiles);
    // A scan that silently matched nothing would pass forever; make sure it
    // actually covers the modules that fetch.
    expect(files.some((f) => f.endsWith(path.join("lib", "hub.ts")))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join("worker", "src", "index.ts")))).toBe(true);
    expect(offenders(files)).toEqual([]);
  });

  it("recognizes the spellings it guards against", () => {
    for (const line of [
      'fetch(url, { redirect: "error" })',
      "fetch(url, {redirect:'error'})",
      "new Request(url, { method, redirect : `error` })",
    ]) {
      expect(REDIRECT_ERROR.test(line)).toBe(true);
    }
    expect(REDIRECT_ERROR.test('fetch(url, { redirect: "manual" })')).toBe(false);
  });
});
