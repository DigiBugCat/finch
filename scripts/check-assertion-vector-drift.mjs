import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(scriptPath), "..");
export const workerPath = join(
  repoRoot,
  "worker",
  "test",
  "assertion-vectors.json",
);
export const sdkCheckoutPath = join(repoRoot, "..", "AviarySDK");
export const defaultSdkPath = join(
  sdkCheckoutPath,
  "tests",
  "fixtures",
  "assertion-vectors.json",
);
export const MAX_ASSERTION_VECTOR_BYTES = 1024 * 1024;

// This digest is the independent consumer checkpoint for AviarySDK's vendored
// public verification vector. Updating the Worker vector requires intentionally
// updating the SDK fixture and this checkpoint in the same fleet change.
export const sdkConsumerSha256 =
  "2077e95500e239f0799510fe7cbd69f91653c2b4bb418058d00dd6007fd614cb";

export class AssertionVectorCheckError extends Error {
  constructor(message, { code, exitCode = 1 } = {}) {
    super(message);
    this.name = "AssertionVectorCheckError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function displayPath(filePath) {
  return JSON.stringify(filePath);
}

// Open once, inspect that same descriptor, and perform a bounded read. Besides
// bounding memory, O_NONBLOCK makes FIFOs/devices fail rather than hang CI.
export function readAssertionVector(
  filePath,
  label,
  maxBytes = MAX_ASSERTION_VECTOR_BYTES,
) {
  let fd;
  try {
    fd = openSync(
      filePath,
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) {
      throw new AssertionVectorCheckError(
        `${label} ${displayPath(filePath)} is not a regular file`,
      );
    }
    if (stat.size > BigInt(maxBytes)) {
      throw new AssertionVectorCheckError(
        `${label} ${displayPath(filePath)} exceeds the ${maxBytes}-byte limit`,
      );
    }

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
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
    if (length > maxBytes) {
      throw new AssertionVectorCheckError(
        `${label} ${displayPath(filePath)} exceeds the ${maxBytes}-byte limit`,
      );
    }

    return {
      bytes: Buffer.from(buffer.subarray(0, length)),
      identity: { device: stat.dev, inode: stat.ino },
    };
  } catch (error) {
    if (error instanceof AssertionVectorCheckError) throw error;
    const detail = error?.code ?? error?.message ?? "unknown read error";
    throw new AssertionVectorCheckError(
      `${label} ${displayPath(filePath)} could not be read (${detail})`,
      { code: error?.code },
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function checkoutExists(checkoutPath) {
  try {
    statSync(checkoutPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    const detail = error?.code ?? error?.message ?? "unknown stat error";
    throw new AssertionVectorCheckError(
      `AviarySDK checkout ${displayPath(checkoutPath)} could not be inspected (${detail})`,
      { code: error?.code },
    );
  }
}

export function resolveSdkConfiguration({
  root = repoRoot,
  override = process.env.AVIARY_ASSERTION_VECTOR,
} = {}) {
  if (override !== undefined) {
    if (typeof override !== "string" || override.trim() === "") {
      throw new AssertionVectorCheckError(
        "AVIARY_ASSERTION_VECTOR must name a non-empty file path when set",
        { exitCode: 2 },
      );
    }
    return {
      path: resolve(root, override),
      required: true,
      checkoutPath: undefined,
    };
  }

  const checkoutPath = join(resolve(root), "..", "AviarySDK");
  return {
    path: join(checkoutPath, "tests", "fixtures", "assertion-vectors.json"),
    required: false,
    checkoutPath,
  };
}

function sameFile(left, right) {
  return (
    left.identity.device === right.identity.device &&
    left.identity.inode === right.identity.inode
  );
}

export function checkAssertionVectorDrift({
  workerVectorPath = workerPath,
  sdkVectorPath = defaultSdkPath,
  sdkRequired = false,
  sdkRootPath = sdkCheckoutPath,
  expectedDigest = sdkConsumerSha256,
} = {}) {
  const worker = readAssertionVector(workerVectorPath, "Worker assertion vector");
  const digest = createHash("sha256").update(worker.bytes).digest("hex");
  if (digest !== expectedDigest) {
    throw new AssertionVectorCheckError(
      `Worker assertion vector ${digest} differs from the AviarySDK consumer ` +
        `checkpoint ${expectedDigest}. Copy worker/test/assertion-vectors.json ` +
        `to AviarySDK/tests/fixtures/assertion-vectors.json and update this digest.`,
    );
  }

  let sdk;
  try {
    sdk = readAssertionVector(sdkVectorPath, "AviarySDK assertion vector");
  } catch (error) {
    const optionalCheckoutIsAbsent =
      !sdkRequired &&
      error.code === "ENOENT" &&
      sdkRootPath !== undefined &&
      !checkoutExists(sdkRootPath);
    if (optionalCheckoutIsAbsent) {
      return {
        digest,
        sdkCompared: false,
        message:
          "AviarySDK sibling checkout not present; Worker vector matches the pinned " +
          "SDK consumer checksum.",
      };
    }
    throw error;
  }

  if (sameFile(worker, sdk)) {
    throw new AssertionVectorCheckError(
      `AviarySDK assertion vector ${displayPath(sdkVectorPath)} aliases the Worker fixture; provide the independent SDK fixture.`,
    );
  }
  if (!worker.bytes.equals(sdk.bytes)) {
    throw new AssertionVectorCheckError(
      `AviarySDK assertion vector is out of sync: ${displayPath(sdkVectorPath)}`,
    );
  }

  return {
    digest,
    sdkCompared: true,
    message: "Finch Worker and AviarySDK assertion vectors match.",
  };
}

export function main(args = process.argv.slice(2)) {
  try {
    if (args.length !== 0) {
      throw new AssertionVectorCheckError(
        "Usage: node scripts/check-assertion-vector-drift.mjs",
        { exitCode: 2 },
      );
    }
    const sdk = resolveSdkConfiguration();
    const result = checkAssertionVectorDrift({
      sdkVectorPath: sdk.path,
      sdkRequired: sdk.required,
      sdkRootPath: sdk.checkoutPath,
    });
    console.log(result.message);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main();
}
