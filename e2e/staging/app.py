"""Disposable AviaryMCP application used by the Finch staging smoke test."""

from __future__ import annotations

import os
from importlib.metadata import version

from aviary_mcp import AviaryMCP, Finch


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


app_path = required("FINCH_E2E_APP_PATH")
hub = required("FINCH_E2E_HUB").rstrip("/")
port = int(required("FINCH_E2E_PORT"))
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
            "https://finch-web-staging.pantainos.workers.dev",
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
