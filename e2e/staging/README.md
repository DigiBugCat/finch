# Finch + AviaryMCP staging smoke test

This is an explicit, destructive, staging-only smoke test for the public
`aviary-mcp` package and a real Finch agent. It covers:

- constructor-owned `AviaryMCP(..., finch=Finch.local(binary=...))`, using the
  exact Finch binary built by the test;
- constructor-level `Finch.agent(...)` against an externally managed
  `finch run` daemon as an agent regression;
- first-run app-owned enrollment, approved headlessly through `finch aviary
  approve <user_code>`, and the returned staging URLs;
- a service-scoped `finch_` bearer key over generated REST and MCP;
- unauthenticated default-deny behavior (`401` or edge-level `403`);
- stripping an attacker-supplied `X-Finch-Assertion` at the edge;
- app and Finch-agent restart using the unchanged, mode-`0600` service
  credential; and
- best-effort key revocation, service removal, and local credential deletion,
  even after a failure.

It cannot target production: the runner accepts only the exact staging Worker
and staging dashboard origins. It is intentionally absent from ordinary CI.

## One-time isolated setup

Use a dedicated temporary home and agent credential directory. Log the CLI into
staging once and install the exact public release candidate in a disposable
virtual environment. The runner starts and restarts its own staging-configured
agent, including the dashboard's split-origin allowlist.

```bash
export E2E_ROOT="$(mktemp -d)"
mkdir -m 700 "$E2E_ROOT/home" "$E2E_ROOT/credentials" "$E2E_ROOT/run"

HOME="$E2E_ROOT/home" ./agent/finch login \
  --hub https://finch-staging.pantainos.workers.dev --headless

```

## Run

From the Finch repository:

```bash
python3.12 -m venv "$E2E_ROOT/venv"
"$E2E_ROOT/venv/bin/pip" install --index-url https://pypi.org/simple \
  'aviary-mcp==0.1.0rc4'

FINCH_STAGING_E2E=1 \
FINCH_E2E_BINARY="$PWD/agent/finch" \
FINCH_E2E_CLI_HOME="$E2E_ROOT/home" \
FINCH_CONTROL_SOCKET="$E2E_ROOT/run/control.sock" \
FINCH_CREDENTIALS_DIR="$E2E_ROOT/credentials" \
FINCH_E2E_EXPECTED_AVIARY_VERSION=0.1.0rc4 \
FINCH_E2E_MODE=local \
  "$E2E_ROOT/venv/bin/python" e2e/staging/run.py
```

Run the same command with `FINCH_E2E_MODE=agent` to retain coverage of the
external-agent `Finch.agent(...)` path. The checked-in workflow runs both modes
with identical enrollment, bearer, restart, and cleanup assertions.

The runner never prints CLI credentials or minted caller keys. For scheduled
CI, `.github/workflows/staging-e2e.yml` injects a dedicated login from the
`FINCH_STAGING_E2E_CLI_JSON` repository secret. Finch CLI logins currently
expire after about 30 days, so rotate that isolated secret before expiry. The
workflow runs weekly and can also be dispatched manually. Set the optional
`AVIARY_MCP_E2E_VERSION` repository variable to move the public package version
under test without editing the workflow.

The safety gates have no network or staging dependency:

```bash
python e2e/staging/test_safety.py
```
