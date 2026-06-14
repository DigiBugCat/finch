// Version-sync assert — the agent version lives in three independent files that
// must agree, or the dashboard's "update available" tooltip shows a stale
// version on drift. There's no shared build artifact across Go + two TS workers,
// so instead of a single import we make the three literals a CI invariant.
//
//   agent/main.go             var agentVersion = "x.y.z"   (canonical default)
//   worker/src/types.ts       export const LATEST_AGENT = "x.y.z"
//   web/components/dash/data.ts export const LATEST_AGENT = "x.y.z"
//
// Exit non-zero (with a diff) if they don't all match.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const sources = [
  {
    label: "agent/main.go (agentVersion)",
    file: "agent/main.go",
    re: /agentVersion\s*=\s*"([^"]+)"/,
  },
  {
    label: "worker/src/types.ts (LATEST_AGENT)",
    file: "worker/src/types.ts",
    re: /LATEST_AGENT\s*=\s*"([^"]+)"/,
  },
  {
    label: "web/components/dash/data.ts (LATEST_AGENT)",
    file: "web/components/dash/data.ts",
    re: /export const LATEST_AGENT\s*=\s*"([^"]+)"/,
  },
];

const found = sources.map((s) => {
  const txt = readFileSync(join(root, s.file), "utf8");
  const m = txt.match(s.re);
  if (!m) {
    console.error(`check-versions: could not find a version literal in ${s.file}`);
    process.exit(2);
  }
  return { ...s, version: m[1] };
});

const versions = new Set(found.map((f) => f.version));
if (versions.size === 1) {
  console.log(`check-versions OK: all three agent-version literals are ${[...versions][0]}.`);
  process.exit(0);
}

console.error("\n  check-versions FAILED: agent version literals are out of sync:\n");
for (const f of found) console.error(`    ${f.version.padEnd(10)}  ${f.label}`);
console.error("\n  Update all three to the same value.\n");
process.exit(1);
