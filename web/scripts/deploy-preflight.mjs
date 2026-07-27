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
//   - the sibling hub source implements the `viewerScoped` echo the member
//     projection fails closed on (deploy-order guard, see below).
//
// Usage: node scripts/deploy-preflight.mjs <env>   (env = production | dev)
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readJsonc } from "./jsonc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const env = process.argv[2];
if (!env) {
  fail("missing --env target. Usage: deploy-preflight <env> (e.g. production)");
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

// Privacy posture is deployment configuration, not a dashboard convention.
// Staging/production persist no Worker logs or traces at all. Local dev may
// retain explicit application logs, but automatic invocation logs and traces
// stay off so request URLs/metadata are never captured implicitly.
if (env === "staging" || env === "production") {
  if (envCfg.observability?.enabled !== false) {
    fail(`[env.${env}].observability.enabled must be false (no persisted Worker telemetry).`);
  }
} else {
  const logs = envCfg.observability?.logs;
  if (
    envCfg.observability?.enabled !== true ||
    logs?.invocation_logs !== false ||
    envCfg.observability?.traces?.enabled !== false
  ) {
    fail(`[env.${env}] must disable automatic invocation logs and traces.`);
  }
}
if (envCfg.logpush !== false) {
  fail(`[env.${env}].logpush must be false.`);
}

if (isProd && envCfg.workers_dev === true) {
  fail("[env.production].workers_dev is true — prod must not expose a workers.dev origin.");
}

// Prod must be built against a Clerk LIVE instance, never a dev (pk_test/sk_test).
if (isProd) {
  const devVarsPath = join(root, ".dev.vars");
  const devVars = existsSync(devVarsPath) ? readDotenv(devVarsPath) : {};
  const pk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? devVars.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (pk && pk.startsWith("pk_test_")) {
    fail("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is a Clerk DEV key (pk_test_) — prod build must use pk_live_.");
  }
  const sk = process.env.CLERK_SECRET_KEY ?? devVars.CLERK_SECRET_KEY;
  if (sk && sk.startsWith("sk_test_")) {
    fail("CLERK_SECRET_KEY in the build env is a Clerk DEV key (sk_test_) — prod must use sk_live_ via `wrangler secret put`.");
  }
}

// Prod must pin the Clerk `azp` audience to this app's exact origin.
// middleware.ts passes NEXT_PUBLIC_APP_ORIGIN to clerkMiddleware as
// authorizedParties; if it is missing or wildcarded, @clerk/backend skips the
// azp assertion (an empty list short-circuits) and a session token minted on a
// tenant's <slug>.finchmcp.com — attacker-controlled HTML on a cookie-sharing
// sibling origin — becomes replayable against /api/finch/*. A wildcard is
// exactly as bad as absent, because every tenant slug matches it.
if (isProd) {
  const appOrigin = envCfg.vars?.NEXT_PUBLIC_APP_ORIGIN;
  if (!appOrigin) {
    fail("[env.production].vars.NEXT_PUBLIC_APP_ORIGIN is missing — prod must pin Clerk authorizedParties to the exact app origin.");
  }
  if (appOrigin.includes("*")) {
    fail(`[env.production].vars.NEXT_PUBLIC_APP_ORIGIN is a wildcard (${appOrigin}) — a wildcard matches every tenant's <slug>.finchmcp.com and defeats the azp check.`);
  }
  let parsed;
  try {
    parsed = new URL(appOrigin);
  } catch {
    fail(`[env.production].vars.NEXT_PUBLIC_APP_ORIGIN is not a URL (${appOrigin}) — it must be an exact https origin.`);
  }
  if (parsed.protocol !== "https:" || parsed.origin !== appOrigin) {
    fail(`[env.production].vars.NEXT_PUBLIC_APP_ORIGIN must be a bare https origin with no path (got ${appOrigin}).`);
  }
}

// Deploy-order guard: hub BEFORE web.
//
// app/api/finch/state/route.ts fails CLOSED for a member when the hub does not
// echo `viewerScoped` — it hands back an empty fleet rather than an unnarrowed
// one. That is the right security choice and stays; the cost is that shipping
// web ahead of the hub blanks every member's dashboard.
//
// CI already orders the two (deploy.yml: the `web` job `needs: hub`). This
// covers the case CI doesn't: a hand-run `npm run deploy` from a checkout whose
// worker/ predates — or has reverted — the narrowing. It is a source check, not
// a probe of the live hub: web and worker deploy from ONE tree, so a tree that
// can't produce the echo can't have deployed a hub that emits it. A live probe
// isn't available here either — /api/state needs tenant credentials this script
// deliberately has no access to.
const hubStatePath = join(root, "..", "worker", "src", "tenant-do.ts");
if (existsSync(hubStatePath)) {
  const hubSource = readFileSync(hubStatePath, "utf8");
  // Match the ECHO itself (`viewerScoped: true`), not the bare identifier — a
  // renamed/negated leftover mentioning the word would otherwise satisfy this.
  if (!/\bviewerScoped\s*:\s*true\b/.test(hubSource)) {
    fail(
      "worker/src/tenant-do.ts does not emit the `viewerScoped` echo. The member " +
        "state projection fails closed without it, so deploying this web build " +
        "would blank every member's dashboard. Deploy the hub first (and from a " +
        "tree that has the ACL narrowing).",
    );
  }
} else {
  // A standalone web checkout can't be checked; say so loudly rather than
  // passing silently, since the fail-closed branch still applies at runtime.
  console.warn(
    "  finch-web deploy-preflight WARNING: worker/src/tenant-do.ts not found — " +
      "cannot verify the hub emits `viewerScoped`. Confirm the hub is deployed FIRST.",
  );
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
