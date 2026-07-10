// Deploy preflight — abort before a prod deploy can ship dev secret values.
//
// `wrangler deploy` never pushes `.dev.vars`, but two real foot-guns remain:
//   1. a prod secret was set (via `wrangler secret put … --env production`) to a
//      copy/pasted DEV value — the same throwaway string committed in
//      `.dev.vars.example` / sitting in a local `.dev.vars`;
//   2. a dev secret value leaks into the wrangler config's `vars` for the env
//      we're about to deploy (vars ARE shipped, plaintext, to the Worker).
//
// We can't read prod secret *values* back (wrangler only lists names), so this
// preflight does what it CAN fully verify from the machine running the deploy:
//   - the target env is explicit and prod-shaped (--env <name>);
//   - the resolved wrangler config's prod `vars` carries no known dev secret
//     value and no DEV/DEFAULT_TENANT fallback (fail-closed tenant invariant);
//   - if a local `.dev.vars` exists, none of its secret VALUES appear in the
//     committed `.dev.vars.example` (i.e. the example still has REPLACE_…
//     stubs, not real dev secrets that someone might `secret put` verbatim).
//
// Usage: node scripts/deploy-preflight.mjs <env>   (env = production | dev)
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const env = process.argv[2];
if (!env) {
  fail("missing --env target. Usage: deploy-preflight <env> (e.g. production)");
}

// Minimal JSONC reader that respects quoted strings and strips line/block
// comments. A regex is not sufficient: route documentation legitimately
// contains wildcard text such as `finchmcp.com/*`, which looks like the start
// of a block comment even though it occurs inside a // comment.
function readJsonc(path) {
  const raw = readFileSync(path, "utf8");
  let out = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        out += ch;
      }
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      } else if (ch === "\n") {
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
    } else if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out);
}

// Parse a dotenv-ish file into { KEY: value } (handles quotes, ignores #/blank).
function readDotenv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function fail(msg) {
  console.error(`\n  finch deploy-preflight FAILED: ${msg}\n`);
  process.exit(1);
}

const cfg = readJsonc(join(root, "wrangler.jsonc"));
const envCfg = cfg.env?.[env];
if (!envCfg) {
  fail(`no [env.${env}] block in wrangler.jsonc — refusing implicit top-level deploy.`);
}

// Static routing contract: the SDK's production default must resolve to a
// route owned by this Worker, never the apex web catch-all.
const prod = cfg.env?.production;
const canonicalIssuer = "https://jwks.finchmcp.com";
const canonicalRoute =
  "jwks.finchmcp.com/.well-known/finch-jwks.json";
if (prod?.vars?.FINCH_ASSERTION_ISSUER !== canonicalIssuer) {
  fail(`[env.production].vars.FINCH_ASSERTION_ISSUER must be ${canonicalIssuer}.`);
}
const prodRoutes = Array.isArray(prod?.routes) ? prod.routes : [];
if (!prodRoutes.some((r) => r?.pattern === canonicalRoute)) {
  fail(`[env.production].routes must include the canonical JWKS route ${canonicalRoute}.`);
}
const aviaryRoute = "finchmcp.com/api/aviary/*";
if (!prodRoutes.some((r) => r?.pattern === aviaryRoute)) {
  fail(`[env.production].routes must include the Aviary enrollment route ${aviaryRoute}.`);
}

// Every named environment must carry the enrollment DO binding and migration;
// Wrangler does not inherit either from the top-level config.
const aviaryBinding = (envCfg.durable_objects?.bindings ?? []).find(
  (binding) => binding?.name === "AVIARY_ENROLLMENT",
);
if (aviaryBinding?.class_name !== "AviaryEnrollmentDO") {
  fail(`[env.${env}] must bind AVIARY_ENROLLMENT to AviaryEnrollmentDO.`);
}
const aviaryMigration = (envCfg.migrations ?? []).some(
  (migration) =>
    Array.isArray(migration?.new_sqlite_classes) &&
    migration.new_sqlite_classes.includes("AviaryEnrollmentDO"),
);
if (!aviaryMigration) {
  fail(`[env.${env}] must include the AviaryEnrollmentDO SQLite migration.`);
}

const isProd = env === "production";

// 1. fail-closed tenant invariant: prod must NOT carry DEV / DEFAULT_TENANT.
if (isProd) {
  const vars = envCfg.vars ?? {};
  for (const banned of ["DEV", "DEFAULT_TENANT"]) {
    if (banned in vars) {
      fail(`[env.production].vars.${banned} is set — prod must fail closed (no dev tenant fallback). Remove it.`);
    }
  }
  if (envCfg.workers_dev === true) {
    fail("[env.production].workers_dev is true — prod must not expose a workers.dev origin.");
  }
}

// 2. Known dev secret values must never leak into shippable `vars`.
//    Collect dev values from .dev.vars.example (always present) + .dev.vars
//    (local, optional). Treat REPLACE_* stubs as non-secret placeholders.
const SECRET_KEYS = [
  "FINCH_SERVICE_SECRET",
  "TICKET_SECRET",
  "SESSION_SECRET",
  "FINCH_ASSERTION_PRIVATE_JWKS",
];
const devValues = new Set();
for (const f of [".dev.vars.example", ".dev.vars"]) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  const vars = readDotenv(p);
  for (const k of SECRET_KEYS) {
    const v = vars[k];
    if (v && !/REPLACE/i.test(v)) devValues.add(v);
  }
}

const shippedVars = JSON.stringify(envCfg.vars ?? {});
for (const v of devValues) {
  if (shippedVars.includes(v)) {
    fail(`a known dev secret value leaked into [env.${env}].vars — never ship dev secrets as plaintext vars.`);
  }
}

// 3. Guard the obvious seeding mistake: a real (non-stub) dev secret sitting in
//    the COMMITTED .dev.vars.example, which someone might `secret put` verbatim.
const examplePath = join(root, ".dev.vars.example");
if (existsSync(examplePath)) {
  const ex = readDotenv(examplePath);
  for (const k of SECRET_KEYS) {
    const v = ex[k];
    if (v && !/REPLACE/i.test(v)) {
      fail(`.dev.vars.example carries a non-stub value for ${k} — it must stay a REPLACE_… placeholder so prod secrets are minted fresh.`);
    }
  }
}

// 4. Assertion signing is a two-part deployment binding: ACTIVE_KID is a
//    public var, PRIVATE_JWKS is a Worker secret. For internet environments,
//    require both. `secret list` returns names only, never secret values.
if (env === "staging" || env === "production") {
  const activeKid = envCfg.vars?.FINCH_ASSERTION_ACTIVE_KID;
  if (!activeKid) {
    fail(`[env.${env}].vars.FINCH_ASSERTION_ACTIVE_KID is required for signed caller assertions.`);
  }
  const wrangler = join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const listed = spawnSync(
    wrangler,
    ["secret", "list", "--env", env, "--format", "json"],
    { cwd: root, encoding: "utf8" },
  );
  if (listed.status !== 0) {
    fail(`could not list [env.${env}] Worker secrets; authenticate Wrangler before deploying.`);
  }
  let names;
  try {
    names = new Set(JSON.parse(listed.stdout).map((s) => s.name));
  } catch {
    fail(`wrangler returned an unreadable secret list for [env.${env}].`);
  }
  if (!names.has("FINCH_ASSERTION_PRIVATE_JWKS")) {
    fail(
      `FINCH_ASSERTION_PRIVATE_JWKS is not set for [env.${env}]; ` +
        `generate it and pipe it through scripts/validate-assertion-jwks.mjs ` +
        `before uploading and deploying.`,
    );
  }
}

console.log(`finch deploy-preflight OK for --env ${env} (no dev-secret/vars leak, fail-closed invariants hold).`);
