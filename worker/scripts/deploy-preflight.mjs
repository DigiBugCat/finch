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

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const env = process.argv[2];
if (!env) {
  fail("missing --env target. Usage: deploy-preflight <env> (e.g. production)");
}

// Minimal JSONC reader — strip // and /* */ comments, then JSON.parse. Good
// enough for our hand-written wrangler.jsonc (no comment-like strings in it).
function readJsonc(path) {
  const raw = readFileSync(path, "utf8");
  const noComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(noComments);
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
const SECRET_KEYS = ["FINCH_SERVICE_SECRET", "TICKET_SECRET"];
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

console.log(`finch deploy-preflight OK for --env ${env} (no dev-secret/vars leak, fail-closed invariants hold).`);
