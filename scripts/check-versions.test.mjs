import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  checkVersions,
  MAX_AGENT_VERSION_LENGTH,
  MAX_SOURCE_BYTES,
  validateAgentVersion,
} from "./check-versions.mjs";

const scriptPath = fileURLToPath(
  new URL("./check-versions.mjs", import.meta.url),
);

function makeRepo(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "finch-check-versions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "agent/core/agent.go": 'var agentVersion = "1.2.3"\n',
    "worker/src/types.ts": 'export const LATEST_AGENT = "1.2.3";\n',
    "web/components/dash/data.ts":
      'export const LATEST_AGENT = "1.2.3";\n',
    ...overrides,
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    if (contents !== null) writeFileSync(path, contents);
  }
  return root;
}

test("accepts supported SemVer forms through the runtime length boundary", () => {
  const exactBoundary = `1.2.3-${"a".repeat(26)}`;
  assert.equal(exactBoundary.length, MAX_AGENT_VERSION_LENGTH);
  for (const version of [
    "0.0.0",
    "1.2.3-rc.1+build.5",
    exactBoundary,
  ]) {
    assert.equal(validateAgentVersion(version), null, version);
  }
});

test("rejects malformed SemVer and a version the runtime would truncate", () => {
  const tooLong = `1.2.3-${"a".repeat(27)}`;
  for (const version of [
    "v1.2.3",
    "1.2",
    "01.2.3",
    "1.2.3-01",
    "1.2.3-alpha..1",
    "1.2.3\n",
    tooLong,
  ]) {
    assert.match(validateAgentVersion(version), /not valid SemVer|32-character/);
  }
  assert.match(validateAgentVersion("9".repeat(10_000)), /10000 characters/);
  assert.ok(validateAgentVersion("9".repeat(10_000)).length < 160);
});

test("returns the one synchronized canonical version and reports real drift", (t) => {
  const root = makeRepo(t);
  assert.equal(checkVersions({ root }).version, "1.2.3");

  writeFileSync(
    join(root, "web/components/dash/data.ts"),
    'export const LATEST_AGENT = "1.2.4";\n',
  );
  assert.throws(
    () => checkVersions({ root }),
    (error) => {
      assert.equal(error.exitCode, 1);
      assert.match(error.message, /out of sync/);
      assert.match(error.message, /1\.2\.3/);
      assert.match(error.message, /1\.2\.4/);
      return true;
    },
  );
});

test("does not let stale comments or look-alike identifiers hide drift", (t) => {
  const root = makeRepo(t, {
    "agent/core/agent.go":
      '// var agentVersion = "1.5.0"\nvar agentVersion = "1.6.0"\n',
    "worker/src/types.ts":
      'export const PREVIOUS_LATEST_AGENT = "1.5.0";\n' +
      'export const LATEST_AGENT = "1.7.0";\n',
    "web/components/dash/data.ts":
      '/*\nexport const LATEST_AGENT = "1.5.0";\n*/\n' +
      'export const LATEST_AGENT = "1.8.0";\n',
  });

  assert.throws(
    () => checkVersions({ root }),
    (error) => {
      assert.equal(error.exitCode, 1);
      assert.match(error.message, /1\.6\.0/);
      assert.match(error.message, /1\.7\.0/);
      assert.match(error.message, /1\.8\.0/);
      assert.doesNotMatch(error.message, /1\.5\.0/);
      return true;
    },
  );
});

test("rejects ambiguous duplicate canonical declarations", (t) => {
  const root = makeRepo(t, {
    "agent/core/agent.go":
      'var agentVersion = "1.2.3"\nvar agentVersion = "1.2.3"\n',
  });
  assert.throws(
    () => checkVersions({ root }),
    /agent\/core\/agent\.go: expected exactly one canonical version declaration, found 2/,
  );
});

test("aggregates missing and malformed sources into one bounded diagnostic", (t) => {
  const root = makeRepo(t, {
    "agent/core/agent.go": null,
    "worker/src/types.ts": 'export const NOT_LATEST_AGENT = "1.2.3";\n',
    "web/components/dash/data.ts":
      'export const LATEST_AGENT = "definitely-not-semver";\n',
  });
  assert.throws(
    () => checkVersions({ root }),
    (error) => {
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /agent\/core\/agent\.go.*ENOENT/);
      assert.match(error.message, /worker\/src\/types\.ts.*found 0/);
      assert.match(error.message, /web\/components\/dash\/data\.ts.*not valid SemVer/);
      assert.ok(error.message.length < 800);
      return true;
    },
  );
});

test("bounds source reads and refuses symlink escapes", async (t) => {
  await t.test("oversized regular file", (t) => {
    const root = makeRepo(t);
    writeFileSync(
      join(root, "agent/core/agent.go"),
      Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x20),
    );
    assert.throws(() => checkVersions({ root }), /source limit/);
  });

  await t.test(
    "symlink",
    { skip: constants.O_NOFOLLOW === undefined },
    (t) => {
      const root = makeRepo(t, { "agent/core/agent.go": null });
      const outside = join(root, "outside.go");
      writeFileSync(outside, 'var agentVersion = "1.2.3"\n');
      symlinkSync(outside, join(root, "agent/core/agent.go"));
      assert.throws(
        () => checkVersions({ root }),
        /agent\/core\/agent\.go.*ELOOP/,
      );
    },
  );
});

test("CLI is CWD-independent and enforces an exact release tag", () => {
  const current = checkVersions().version;
  const matching = spawnSync(
    process.execPath,
    [scriptPath, "--expected-tag", `v${current}`],
    { cwd: tmpdir(), encoding: "utf8" },
  );
  assert.equal(matching.status, 0, matching.stderr);
  assert.match(matching.stdout, /check-versions OK/);

  const mismatched = spawnSync(
    process.execPath,
    [scriptPath, "--expected-tag", `v${current}-wrong`],
    { cwd: tmpdir(), encoding: "utf8" },
  );
  assert.equal(mismatched.status, 1);
  assert.match(mismatched.stderr, /release tag .* does not match/);
});
