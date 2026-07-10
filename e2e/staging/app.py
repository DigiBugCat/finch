"""Disposable AviaryMCP application used by the Finch staging smoke test."""

from __future__ import annotations

import os
from importlib.metadata import version

from aviary_mcp import AviaryMCP, FinchAssertionAuth


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


app_path = required("FINCH_E2E_APP_PATH")
hub = required("FINCH_E2E_HUB").rstrip("/")
port = int(required("FINCH_E2E_PORT"))

app = AviaryMCP(
    "Finch staging smoke test",
    auth=FinchAssertionAuth(
        service=app_path,
        issuer=hub,
        jwks_url=f"{hub}/.well-known/finch-jwks.json",
    ),
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
    app.run(
        expose="finch",
        app_path=app_path,
        host="127.0.0.1",
        port=port,
        edge_auth="key",
        public_base_url=hub,
        enrollment_output="json",
        activation_timeout=60,
    )
