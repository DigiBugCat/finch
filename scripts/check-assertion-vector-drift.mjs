import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = join(repoRoot, "worker", "test", "assertion-vectors.json");
const sdkPath = process.env.AVIARY_ASSERTION_VECTOR
  ? resolve(process.env.AVIARY_ASSERTION_VECTOR)
  : join(repoRoot, "..", "AviarySDK", "tests", "fixtures", "assertion-vectors.json");

// This digest is the independent consumer checkpoint for AviarySDK's vendored
// public verification vector. Updating the Worker vector requires intentionally
// updating the SDK fixture and this checkpoint in the same fleet change.
const sdkConsumerSha256 =
  "2077e95500e239f0799510fe7cbd69f91653c2b4bb418058d00dd6007fd614cb";

const worker = readFileSync(workerPath);
const digest = createHash("sha256").update(worker).digest("hex");
if (digest !== sdkConsumerSha256) {
  throw new Error(
    `Worker assertion vector ${digest} differs from the AviarySDK consumer ` +
      `checkpoint ${sdkConsumerSha256}. Copy worker/test/assertion-vectors.json ` +
      `to AviarySDK/tests/fixtures/assertion-vectors.json and update this digest.`,
  );
}

if (existsSync(sdkPath)) {
  const sdk = readFileSync(sdkPath);
  if (!worker.equals(sdk)) {
    throw new Error(
      `AviarySDK assertion vector is out of sync: ${sdkPath}`,
    );
  }
  console.log("Finch Worker and AviarySDK assertion vectors match.");
} else {
  console.log(
    "AviarySDK sibling checkout not present; Worker vector matches the pinned " +
      "SDK consumer checksum.",
  );
}
