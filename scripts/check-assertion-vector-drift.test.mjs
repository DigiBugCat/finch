import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  checkAssertionVectorDrift,
  MAX_ASSERTION_VECTOR_BYTES,
  repoRoot,
  resolveSdkConfiguration,
  workerPath,
} from "./check-assertion-vector-drift.mjs";

const scriptPath = fileURLToPath(
  new URL("./check-assertion-vector-drift.mjs", import.meta.url),
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeVectors(t, workerBytes = Buffer.from('{"vector":true}\n')) {
  const root = mkdtempSync(join(tmpdir(), "finch-assertion-vectors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerVectorPath = join(root, "worker", "assertion-vectors.json");
  const sdkRootPath = join(root, "AviarySDK");
  const sdkVectorPath = join(
    sdkRootPath,
    "tests",
    "fixtures",
    "assertion-vectors.json",
  );
  mkdirSync(dirname(workerVectorPath), { recursive: true });
  mkdirSync(dirname(sdkVectorPath), { recursive: true });
  writeFileSync(workerVectorPath, workerBytes);
  writeFileSync(sdkVectorPath, workerBytes);
  return {
    root,
    workerBytes,
    workerVectorPath,
    sdkRootPath,
    sdkVectorPath,
    expectedDigest: sha256(workerBytes),
  };
}

test("compares distinct Worker and SDK files byte-for-byte", (t) => {
  const vectors = makeVectors(t);
  const result = checkAssertionVectorDrift(vectors);
  assert.equal(result.sdkCompared, true);
  assert.equal(result.digest, vectors.expectedDigest);
});

test("fails on Worker checkpoint drift before trusting the SDK copy", (t) => {
  const vectors = makeVectors(t);
  writeFileSync(vectors.workerVectorPath, "malformed or corrupted");
  assert.throws(
    () => checkAssertionVectorDrift(vectors),
    /differs from the AviarySDK consumer checkpoint/,
  );
});

test("rejects even one-byte SDK drift", (t) => {
  const vectors = makeVectors(t);
  writeFileSync(
    vectors.sdkVectorPath,
    Buffer.concat([vectors.workerBytes, Buffer.from("\n")]),
  );
  assert.throws(
    () => checkAssertionVectorDrift(vectors),
    /AviarySDK assertion vector is out of sync/,
  );
});

test("explicit SDK overrides are required and resolve from the repository", (t) => {
  const vectors = makeVectors(t);
  assert.equal(
    resolveSdkConfiguration({ root: vectors.root, override: "sdk/vector.json" })
      .path,
    join(vectors.root, "sdk", "vector.json"),
  );
  for (const override of ["", " ", "\t\n"]) {
    assert.throws(
      () => resolveSdkConfiguration({ root: vectors.root, override }),
      /must name a non-empty file path/,
    );
  }
  assert.throws(
    () =>
      checkAssertionVectorDrift({
        ...vectors,
        sdkVectorPath: join(vectors.root, "missing.json"),
        sdkRequired: true,
      }),
    /missing\.json.*ENOENT/,
  );
});

test("a missing checkout is optional, but a damaged checkout is not", async (t) => {
  await t.test("checkout absent", (t) => {
    const vectors = makeVectors(t);
    rmSync(vectors.sdkRootPath, { recursive: true });
    const result = checkAssertionVectorDrift({
      ...vectors,
      sdkRequired: false,
    });
    assert.equal(result.sdkCompared, false);
  });

  await t.test("checkout present with fixture missing", (t) => {
    const vectors = makeVectors(t);
    rmSync(vectors.sdkVectorPath);
    assert.throws(
      () =>
        checkAssertionVectorDrift({
          ...vectors,
          sdkRequired: false,
        }),
      /AviarySDK assertion vector.*ENOENT/,
    );
  });
});

test("refuses a hard-linked Worker fixture as an independent SDK copy", (t) => {
  const vectors = makeVectors(t);
  rmSync(vectors.sdkVectorPath);
  linkSync(vectors.workerVectorPath, vectors.sdkVectorPath);
  assert.throws(
    () => checkAssertionVectorDrift(vectors),
    /aliases the Worker fixture/,
  );
});

test("bounds vector reads and rejects non-regular path tricks", async (t) => {
  await t.test("missing Worker fixture", (t) => {
    const vectors = makeVectors(t);
    rmSync(vectors.workerVectorPath);
    assert.throws(
      () => checkAssertionVectorDrift(vectors),
      /Worker assertion vector.*ENOENT/,
    );
  });

  await t.test("oversized SDK fixture", (t) => {
    const vectors = makeVectors(t);
    writeFileSync(
      vectors.sdkVectorPath,
      Buffer.alloc(MAX_ASSERTION_VECTOR_BYTES + 1, 0x20),
    );
    assert.throws(
      () => checkAssertionVectorDrift(vectors),
      /exceeds the .*byte limit/,
    );
  });

  await t.test(
    "symlink escape",
    { skip: constants.O_NOFOLLOW === undefined },
    (t) => {
      const vectors = makeVectors(t);
      const outside = join(vectors.root, "outside.json");
      writeFileSync(outside, vectors.workerBytes);
      rmSync(vectors.sdkVectorPath);
      symlinkSync(outside, vectors.sdkVectorPath);
      assert.throws(
        () => checkAssertionVectorDrift(vectors),
        /AviarySDK assertion vector.*ELOOP/,
      );
    },
  );

  await t.test("FIFO cannot block the CLI", (t) => {
    const root = mkdtempSync(join(tmpdir(), "finch-vector-fifo-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fifo = join(root, "vector.fifo");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    if (made.status !== 0) {
      t.skip("mkfifo is unavailable on this platform");
      return;
    }
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: tmpdir(),
      encoding: "utf8",
      env: { ...process.env, AVIARY_ASSERTION_VECTOR: fifo },
      timeout: 2_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a regular file/);
  });
});

test("CLI relative overrides are CWD-independent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "finch-vector-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdkCopy = join(root, "assertion-vectors.json");
  writeFileSync(sdkCopy, readFileSync(workerPath));
  const override = relative(repoRoot, sdkCopy);

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: { ...process.env, AVIARY_ASSERTION_VECTOR: override },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Finch Worker and AviarySDK assertion vectors match/);
});
