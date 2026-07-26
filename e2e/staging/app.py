"""Disposable AviaryMCP application used by the Finch staging smoke test."""

from __future__ import annotations

import os
from importlib.metadata import version
import re

from aviary_mcp import AviaryMCP, Finch


STAGING_HUB = "https://finch-staging.pantainos.workers.dev"
STAGING_WEB_ORIGIN = "https://finch-web-staging.pantainos.workers.dev"
APP_PATH_RE = re.compile(r"aviary-e2e-[0-9]{10,}-[0-9a-f]{32}")


def required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value or value != value.strip():
        raise RuntimeError(f"{name} is required")
    return value


def staging_hub() -> str:
    value = required("FINCH_E2E_HUB")
    if value not in {STAGING_HUB, f"{STAGING_HUB}/"}:
        raise RuntimeError("FINCH_E2E_HUB must be the dedicated Finch staging hub")
    return STAGING_HUB


def disposable_path() -> str:
    value = required("FINCH_E2E_APP_PATH")
    if APP_PATH_RE.fullmatch(value) is None:
        raise RuntimeError("FINCH_E2E_APP_PATH must be a generated disposable path")
    return value


def loopback_port() -> int:
    value = required("FINCH_E2E_PORT")
    if re.fullmatch(r"[0-9]{1,5}", value) is None:
        raise RuntimeError("FINCH_E2E_PORT must be a decimal TCP port")
    port = int(value)
    if not 1 <= port <= 65535:
        raise RuntimeError("FINCH_E2E_PORT must be between 1 and 65535")
    return port


app_path = disposable_path()
hub = staging_hub()
port = loopback_port()
mode = required("FINCH_E2E_MODE")

exposure = {
    "path": app_path,
    "bind_host": "127.0.0.1",
    "port": port,
    "edge_auth": "key",
    "public_base_url": hub,
    "enrollment_output": "json",
    "activation_timeout": 60,
    "issuer": hub,
    "jwks_url": f"{hub}/.well-known/finch-jwks.json",
}

if mode == "local":
    connector = Finch.local(
        hub=hub,
        box=required("FINCH_E2E_BOX"),
        binary=required("FINCH_E2E_BINARY"),
        project_dir=required("FINCH_E2E_PROJECT_DIR"),
        credentials_dir=os.path.join(
            required("FINCH_E2E_PROJECT_DIR"), "managed-credentials"
        ),
        verification_origins=(
            STAGING_WEB_ORIGIN,
        ),
        **exposure,
    )
elif mode == "agent":
    connector = Finch.agent(
        socket=required("FINCH_CONTROL_SOCKET"),
        hub=hub,
        **exposure,
    )
else:
    raise RuntimeError("FINCH_E2E_MODE must be local or agent")

app = AviaryMCP(
    "Finch staging smoke test",
    finch=connector,
)


@app.tool
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


@app.tool
def package_version() -> str:
    """Return the public AviaryMCP distribution version under test."""
    return version("aviary-mcp")


if __name__ == "__main__":
    # Constructor configuration is the complete contract. Finch.local owns
    # the explicit binary; Finch.agent connects to the runner-owned daemon.
    app.run()
