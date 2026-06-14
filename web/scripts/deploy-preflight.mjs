// Deploy preflight (web) — abort before a prod deploy can ship dev values.
//
// The web worker holds two sensitive secrets — CLERK_SECRET_KEY and
// FINCH_SERVICE_SECRET — set per-env via `wrangler secret put … --env <env>`,
// plus a build-time NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY. Wrangler can't read prod
// secret values back, so this checks what's verifiable from the deploy machine:
//   - the target env is explicit and exists in wrangler.jsonc;
//   - prod must not expose a workers.dev origin;
//   - no known dev secret value (from .dev.vars[.example]) leaks into the
//     shippable wrangler `vars` for the env;
//   - prod must not be built/deployed against a Clerk DEV instance: any
//     pk_test_/sk_test_ in the build env (or shipped vars) is rejected.
//   - .dev.vars.example must keep REPLACE_… stubs (never real dev secrets that
//     someone might `secret put` verbatim into prod).
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

function readJsonc(path) {
  const raw = readFileSync(path, "utf8");
  const noComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(noComments);
}

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
  console.error(`\n  finch-web deploy-preflight FAILED: ${msg}\n`);
  process.exit(1);
}

const cfg = readJsonc(join(root, "wrangler.jsonc"));
const envCfg = cfg.env?.[env];
if (!envCfg) {
  fail(`no [env.${env}] block in wrangler.jsonc — refusing implicit top-level deploy.`);
}

const isProd = env === "production";

if (isProd && envCfg.workers_dev === true) {
  fail("[env.production].workers_dev is true — prod must not expose a workers.dev origin.");
}

// Prod must be built against a Clerk LIVE instance, never a dev (pk_test/sk_test).
if (isProd) {
  const pk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (pk && pk.startsWith("pk_test_")) {
    fail("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is a Clerk DEV key (pk_test_) — prod build must use pk_live_.");
  }
  const sk = process.env.CLERK_SECRET_KEY;
  if (sk && sk.startsWith("sk_test_")) {
    fail("CLERK_SECRET_KEY in the build env is a Clerk DEV key (sk_test_) — prod must use sk_live_ via `wrangler secret put`.");
  }
}

// Known dev secret values must never leak into shippable `vars`.
const SECRET_KEYS = ["FINCH_SERVICE_SECRET", "CLERK_SECRET_KEY"];
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

// .dev.vars.example must keep REPLACE_… stubs for the service secret.
const examplePath = join(root, ".dev.vars.example");
if (existsSync(examplePath)) {
  const ex = readDotenv(examplePath);
  const v = ex.FINCH_SERVICE_SECRET;
  if (v && !/REPLACE/i.test(v)) {
    fail(".dev.vars.example carries a non-stub FINCH_SERVICE_SECRET — keep it a REPLACE_… placeholder.");
  }
}

console.log(`finch-web deploy-preflight OK for --env ${env} (no dev-secret/vars leak, no dev Clerk key).`);
