// Validate FINCH_ASSERTION_PRIVATE_JWKS before uploading it to Cloudflare.
//
// Reads the private JWKS from stdin and writes nothing sensitive. With
// --passthrough, the exact input is copied to stdout only after validation so
// it can be piped directly into `wrangler secret put` without touching disk.
//
// Usage:
//   generate-or-print-jwks \
//     | node scripts/validate-assertion-jwks.mjs <active-kid> --passthrough \
//     | npx wrangler secret put FINCH_ASSERTION_PRIVATE_JWKS --env production
import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

const activeKid = process.argv[2];
const passthrough = process.argv.includes("--passthrough");
if (!activeKid || !/^[A-Za-z0-9._-]{1,80}$/.test(activeKid)) {
  fail("usage: validate-assertion-jwks.mjs <active-kid> [--passthrough]");
}

const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 1024 * 1024) fail("private JWKS exceeds the 1 MiB validation limit");
  chunks.push(chunk);
}
const rawBuffer = Buffer.concat(chunks);
const raw = rawBuffer.toString("utf8").trim();
if (!raw) fail("private JWKS stdin was empty");

let document;
try {
  document = JSON.parse(raw);
} catch {
  fail("private JWKS is not valid JSON");
}
if (!document || !Array.isArray(document.keys) || document.keys.length === 0) {
  fail("private JWKS must contain a non-empty keys array");
}

const kids = new Set();
let active;
for (const key of document.keys) {
  if (
    !key ||
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    typeof key.x !== "string" ||
    !key.x ||
    typeof key.y !== "string" ||
    !key.y ||
    typeof key.kid !== "string" ||
    !key.kid ||
    (key.alg !== undefined && key.alg !== "ES256") ||
    (key.use !== undefined && key.use !== "sig")
  ) {
    fail("every assertion key must be a named EC P-256 ES256 signing JWK");
  }
  if (kids.has(key.kid)) fail(`duplicate assertion key id: ${key.kid}`);
  kids.add(key.kid);
  if (key.kid === activeKid) active = key;
}
if (!active) fail(`active assertion key not found: ${activeKid}`);
if (typeof active.d !== "string" || !active.d) {
  fail(`active assertion key ${activeKid} has no private component`);
}

try {
  const privateKey = createPrivateKey({ key: active, format: "jwk" });
  const publicKey = createPublicKey(privateKey);
  const message = Buffer.from("finch caller assertion key self-test", "utf8");
  const signature = sign("sha256", message, {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  if (
    signature.length !== 64 ||
    !verify(
      "sha256",
      message,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    )
  ) {
    fail("active assertion key failed its ES256 sign/verify self-test");
  }

  // Validate every published public coordinate, including retiring keys. This
  // mirrors the Worker endpoint's emitted public set and catches malformed
  // rotation entries before the secret is uploaded.
  for (const key of document.keys) {
    createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: key.x,
        y: key.y,
      },
      format: "jwk",
    });
  }
} catch (error) {
  fail(
    `assertion JWKS cryptographic validation failed: ${
      error instanceof Error ? error.message : "unknown error"
    }`,
  );
}

console.error(
  `Finch assertion JWKS validated (${document.keys.length} keys; active ${activeKid}).`,
);
if (passthrough) process.stdout.write(rawBuffer);

function fail(message) {
  console.error(`Finch assertion JWKS validation failed: ${message}`);
  process.exit(1);
}
