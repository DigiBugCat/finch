// Version-sync assert — the agent version lives in three independent files that
// must agree, or the dashboard's "update available" tooltip shows a stale
// version on drift. There's no shared build artifact across Go + two TS workers,
// so instead of a single import we make the three literals a CI invariant.
//
//   agent/core/agent.go         var agentVersion = "x.y.z"   (canonical default)
//   worker/src/types.ts         export const LATEST_AGENT = "x.y.z"
//   web/components/dash/data.ts export const LATEST_AGENT = "x.y.z"
//
// A release workflow can additionally bind a tag to these literals with:
//
//   node scripts/check-versions.mjs --expected-tag "$GITHUB_REF_NAME"
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(scriptPath), "..");
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_AGENT_VERSION_LENGTH = 32;

// SemVer 2.0.0, without a leading "v". Check the 32-character runtime limit
// first so even hostile source text never reaches an unbounded regex match.
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const versionSources = [
  {
    label: "agent/core/agent.go (agentVersion)",
    file: "agent/core/agent.go",
    re: /^[ \t]*var[ \t]+agentVersion(?:[ \t]+string)?[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*;?[ \t]*$/gm,
  },
  {
    label: "worker/src/types.ts (LATEST_AGENT)",
    file: "worker/src/types.ts",
    re: /^[ \t]*export[ \t]+const[ \t]+LATEST_AGENT(?:[ \t]*:[ \t]*string)?[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*;?[ \t]*$/gm,
  },
  {
    label: "web/components/dash/data.ts (LATEST_AGENT)",
    file: "web/components/dash/data.ts",
    re: /^[ \t]*export[ \t]+const[ \t]+LATEST_AGENT(?:[ \t]*:[ \t]*string)?[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*;?[ \t]*$/gm,
  },
];

export class VersionCheckError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "VersionCheckError";
    this.exitCode = exitCode;
  }
}

function bounded(value, limit = 80) {
  if (value.length <= limit) return JSON.stringify(value);
  return `${JSON.stringify(value.slice(0, limit))}... (${value.length} characters)`;
}

// Mask comments without changing line boundaries. This prevents commented-out
// declarations from satisfying the invariant while retaining quoted literals.
function maskComments(source) {
  let output = "";
  let state = "code";
  let quote = "";
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (state === "line-comment") {
      if (char === "\n" || char === "\r") {
        output += char;
        state = "code";
      } else {
        output += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        output += "  ";
        i += 1;
        state = "code";
      } else {
        output += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }

    if (state === "string") {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        state = "code";
      } else if ((char === "\n" || char === "\r") && quote !== "`") {
        // Recover on malformed single-line strings so one bad quote cannot
        // hide every declaration that follows it from the checker.
        state = "code";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      output += "  ";
      i += 1;
      state = "line-comment";
    } else if (char === "/" && next === "*") {
      output += "  ";
      i += 1;
      state = "block-comment";
    } else {
      output += char;
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        escaped = false;
        state = "string";
      }
    }
  }

  return output;
}

function readBoundedUtf8(filePath, displayPath) {
  let fd;
  try {
    // O_NONBLOCK prevents a malicious FIFO/device replacement from hanging CI.
    fd = openSync(
      filePath,
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new VersionCheckError(
        `${displayPath}: expected a regular file`,
        2,
      );
    }
    if (stat.size > MAX_SOURCE_BYTES) {
      throw new VersionCheckError(
        `${displayPath}: exceeds the ${MAX_SOURCE_BYTES}-byte source limit`,
        2,
      );
    }

    const buffer = Buffer.allocUnsafe(MAX_SOURCE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SOURCE_BYTES) {
      throw new VersionCheckError(
        `${displayPath}: exceeds the ${MAX_SOURCE_BYTES}-byte source limit`,
        2,
      );
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
    } catch {
      throw new VersionCheckError(`${displayPath}: is not valid UTF-8`, 2);
    }
  } catch (error) {
    if (error instanceof VersionCheckError) throw error;
    const detail = error?.code ?? error?.message ?? "unknown read error";
    throw new VersionCheckError(`${displayPath}: could not be read (${detail})`, 2);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function validateAgentVersion(version) {
  if (version.length > MAX_AGENT_VERSION_LENGTH) {
    return `version ${bounded(version)} exceeds the ${MAX_AGENT_VERSION_LENGTH}-character runtime limit`;
  }
  if (!semverPattern.test(version)) {
    return `version ${bounded(version)} is not valid SemVer`;
  }
  return null;
}

function readVersion(root, source) {
  const text = maskComments(
    readBoundedUtf8(join(root, source.file), source.file),
  );
  source.re.lastIndex = 0;
  const matches = [...text.matchAll(source.re)];
  if (matches.length !== 1) {
    throw new VersionCheckError(
      `${source.file}: expected exactly one canonical version declaration, found ${matches.length}`,
      2,
    );
  }

  const version = matches[0][1];
  const invalid = validateAgentVersion(version);
  if (invalid) {
    throw new VersionCheckError(`${source.file}: ${invalid}`, 2);
  }
  return { ...source, version };
}

export function checkVersions({ root = repoRoot, expectedTag } = {}) {
  const found = [];
  const issues = [];
  for (const source of versionSources) {
    try {
      found.push(readVersion(root, source));
    } catch (error) {
      issues.push(error.message);
    }
  }

  if (issues.length > 0) {
    throw new VersionCheckError(
      `check-versions FAILED: invalid version sources:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
      2,
    );
  }

  const versions = new Set(found.map((entry) => entry.version));
  if (versions.size !== 1) {
    const details = found
      .map((entry) => `    ${entry.version.padEnd(MAX_AGENT_VERSION_LENGTH)}  ${entry.label}`)
      .join("\n");
    throw new VersionCheckError(
      `check-versions FAILED: agent version literals are out of sync:\n${details}\n\n  Update all three to the same value.`,
      1,
    );
  }

  const version = found[0].version;
  if (expectedTag !== undefined && expectedTag !== `v${version}`) {
    throw new VersionCheckError(
      `check-versions FAILED: release tag ${bounded(expectedTag)} does not match synchronized agent version "v${version}".`,
      1,
    );
  }

  return { version, found };
}

function parseArguments(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--expected-tag") {
    return { expectedTag: args[1] };
  }
  throw new VersionCheckError(
    "Usage: node scripts/check-versions.mjs [--expected-tag vX.Y.Z]",
    2,
  );
}

export function main(args = process.argv.slice(2)) {
  try {
    const { expectedTag } = parseArguments(args);
    const result = checkVersions({ expectedTag });
    const tagNote = expectedTag === undefined ? "" : ` and release tag ${expectedTag}`;
    console.log(
      `check-versions OK: all three agent-version literals${tagNote} are ${result.version}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main();
}
