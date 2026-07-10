// Live DNS/TLS/routing probe for the canonical Finch caller-assertion JWKS.
const url =
  process.argv[2] ||
  "https://jwks.finchmcp.com/.well-known/finch-jwks.json";
const expectedActiveKid = process.argv[3] || "finch-prod-2026-07";
if (!url.startsWith("https://")) {
  throw new Error("caller-assertion JWKS smoke target must use HTTPS");
}
const smokeUrl = new URL(url);
// Rotation deliberately gives normal JWKS consumers a five-minute cache. A
// unique query makes this deployment probe observe the newly activated Worker
// and active kid instead of a valid-but-stale pre-rotation response.
smokeUrl.searchParams.set("_finch_smoke", Date.now().toString(36));

const response = await fetch(smokeUrl, {
  headers: { accept: "application/jwk-set+json" },
  redirect: "error",
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) {
  throw new Error(`JWKS ${url} returned HTTP ${response.status}`);
}
if (!(response.headers.get("content-type") || "").includes("application/jwk-set+json")) {
  throw new Error("JWKS response did not use application/jwk-set+json");
}
const contentLength = Number(response.headers.get("content-length") || "0");
if (contentLength > 1024 * 1024) {
  throw new Error("JWKS response exceeded the 1 MiB smoke limit");
}
const raw = await response.text();
if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
  throw new Error("JWKS response exceeded the 1 MiB smoke limit");
}
let body;
try {
  body = JSON.parse(raw);
} catch {
  throw new Error("JWKS response was not valid JSON");
}
if (!Array.isArray(body?.keys) || body.keys.length === 0) {
  throw new Error("JWKS did not contain a non-empty keys array");
}
for (const key of body.keys) {
  if (
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    key.alg !== "ES256" ||
    typeof key.kid !== "string" ||
    !key.kid
  ) {
    throw new Error(`invalid Finch assertion public JWK: ${JSON.stringify(key)}`);
  }
  if ("d" in key) throw new Error(`JWKS leaked private material for kid ${key.kid}`);
}
const activeKid = response.headers.get("x-finch-active-kid");
if (activeKid !== expectedActiveKid) {
  throw new Error(
    `JWKS signer self-test reported active kid ${JSON.stringify(activeKid)}; ` +
      `expected ${JSON.stringify(expectedActiveKid)}`,
  );
}
if (!body.keys.some((key) => key.kid === activeKid)) {
  throw new Error(`active assertion kid ${activeKid} is absent from the public JWKS`);
}
console.log(
  `finch caller-assertion signer OK: ${url} ` +
    `(${body.keys.length} keys; active ${activeKid})`,
);
