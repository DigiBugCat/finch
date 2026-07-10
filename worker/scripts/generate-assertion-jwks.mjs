// Generate one ES256 private JWKS for FINCH_ASSERTION_PRIVATE_JWKS.
//
// The private JSON is printed to stdout so it can be piped directly into
// `wrangler secret put`; the script never writes key material to disk.
// Usage:
//   node scripts/generate-assertion-jwks.mjs finch-prod-2026-07 \
//     | node scripts/validate-assertion-jwks.mjs finch-prod-2026-07 --passthrough \
//     | npx wrangler secret put FINCH_ASSERTION_PRIVATE_JWKS --env production
import { generateKeyPairSync } from "node:crypto";

const kid = process.argv[2];
if (!kid || !/^[A-Za-z0-9._-]{1,80}$/.test(kid)) {
  console.error("usage: generate-assertion-jwks.mjs <kid: A-Za-z0-9._->");
  process.exit(2);
}

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const jwk = privateKey.export({ format: "jwk" });
process.stdout.write(
  JSON.stringify({
    keys: [{ ...jwk, kid, alg: "ES256", use: "sig" }],
  }),
);
