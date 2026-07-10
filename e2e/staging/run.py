#!/usr/bin/env python3
"""Opt-in, destructive smoke test against the dedicated Finch staging hub.

The runner deliberately uses only the Python standard library until the MCP
check.  The selected interpreter must have the public ``aviary-mcp`` package
installed, which also supplies FastMCP for that check.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import subprocess
import sys
import threading
import time
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


DEFAULT_STAGING_HUB = "https://finch-staging.pantainos.workers.dev"
OPT_IN = "FINCH_STAGING_E2E"
MODES = frozenset({"local", "agent"})
APP_RESTART_TIMEOUT = 90


class SmokeFailure(RuntimeError):
    pass


def checked_staging_hub(value: str) -> str:
    hub = value.rstrip("/")
    parsed = urlsplit(hub)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "finch-staging.pantainos.workers.dev"
        or parsed.port is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        raise SmokeFailure(
            "refusing non-staging hub; this suite is hard-bound to "
            f"{DEFAULT_STAGING_HUB}"
        )
    return hub


def require_opt_in(env: dict[str, str]) -> None:
    if env.get(OPT_IN) != "1":
        raise SmokeFailure(f"set {OPT_IN}=1 to authorize staging writes")


def checked_mode(value: str) -> str:
    if value not in MODES:
        raise SmokeFailure("FINCH_E2E_MODE must be local or agent")
    return value


def find_free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def run_cli(binary: Path, home: Path, *args: str, json_output: bool = False) -> Any:
    env = os.environ.copy()
    env["HOME"] = str(home)
    completed = subprocess.run(
        [str(binary), *args],
        env=env,
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=30,
    )
    if json_output:
        return json.loads(completed.stdout)
    return completed.stdout.strip()


def verify_cli_login(home: Path, expected_hub: str) -> None:
    credential = home / ".finch" / "cli.json"
    try:
        mode = stat.S_IMODE(credential.stat().st_mode)
        value = json.loads(credential.read_text())
    except (OSError, ValueError) as exc:
        raise SmokeFailure(
            f"missing isolated staging login at {credential}; run finch login "
            f"--hub {expected_hub} with HOME={home}"
        ) from exc
    if mode & 0o077:
        raise SmokeFailure(f"CLI credential must not be group/world accessible: {credential}")
    if value.get("hub", "").rstrip("/") != expected_hub:
        raise SmokeFailure("isolated CLI credential is not scoped to the staging hub")
    if not value.get("token"):
        raise SmokeFailure("isolated CLI credential has no token")


def request_json(
    method: str,
    url: str,
    *,
    token: str | None = None,
    body: dict[str, Any] | None = None,
    spoof_assertion: bool = False,
) -> tuple[int, Any]:
    headers = {
        "Accept": "application/json",
        "User-Agent": "AviaryMCP-Staging-E2E/1.0",
    }
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if spoof_assertion:
        headers["X-Finch-Assertion"] = "attacker-controlled-value"
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    request = Request(url, method=method, headers=headers, data=data)
    try:
        with urlopen(request, timeout=20) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except HTTPError as exc:
        raw = exc.read()
        try:
            payload = json.loads(raw) if raw else None
        except ValueError:
            payload = raw.decode(errors="replace")
        return exc.code, payload


def result_value(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return None
    structured = payload.get("structured_content")
    if isinstance(structured, dict):
        return structured.get("result")
    return None


def request_after_relay_ready(
    method: str,
    url: str,
    **kwargs: Any,
) -> tuple[int, Any]:
    deadline = time.monotonic() + 20
    while True:
        status, payload = request_json(method, url, **kwargs)
        if status not in {502, 503, 504} or time.monotonic() >= deadline:
            return status, payload
        time.sleep(1)


class AppProcess:
    def __init__(self, env: dict[str, str]) -> None:
        self.events: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("app.py"))],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        assert self.process.stdout is not None and self.process.stderr is not None
        self._threads = [
            threading.Thread(target=self._consume, args=(self.process.stdout,), daemon=True),
            threading.Thread(target=self._consume, args=(self.process.stderr,), daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    def _consume(self, stream: Any) -> None:
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except ValueError:
                # Never mirror process output: dependencies may log sensitive data.
                continue
            if isinstance(value, dict) and value.get("event") == "finch_enrollment":
                with self._lock:
                    self.events.append(value)

    def wait_event(self, state: str, timeout: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise SmokeFailure(f"AviaryMCP exited early ({self.process.returncode})")
            with self._lock:
                found = next((event for event in self.events if event.get("state") == state), None)
            if found is not None:
                return found
            time.sleep(0.2)
        raise SmokeFailure(f"timed out waiting for enrollment state {state!r}")

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


class AgentProcess:
    def __init__(
        self,
        binary: Path,
        hub: str,
        credentials: Path,
        control_socket: Path,
        box: str,
    ) -> None:
        env = os.environ.copy()
        env.update(
            FINCH_HUB=hub,
            FINCH_BOX=box,
            FINCH_CONTROL_SOCKET=str(control_socket),
            FINCH_CONTROL_SOCKET_MODE="0600",
            FINCH_CREDENTIALS_DIR=str(credentials),
            FINCH_AVIARY_VERIFICATION_ORIGINS=(
                "https://finch-web-staging.pantainos.workers.dev"
            ),
        )
        with contextlib.suppress(FileNotFoundError):
            control_socket.unlink()
        self.process = subprocess.Popen(
            [str(binary), "run"],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise SmokeFailure(f"Finch agent exited early ({self.process.returncode})")
            if control_socket.exists() and stat.S_ISSOCK(control_socket.stat().st_mode):
                return
            time.sleep(0.1)
        self.stop()
        raise SmokeFailure("timed out waiting for Finch agent control socket")

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


def approve_aviary_with_retry(binary: Path, home: Path, user_code: str) -> None:
    if not user_code or len(user_code) > 32:
        raise SmokeFailure("enrollment did not return a valid user_code")
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            # This uses the ordinary revocable tenant-admin CLI credential and
            # the same proof-bound transaction as browser approval. Do not use
            # `finch approve <app_path>`: that is the legacy service pending gate.
            run_cli(binary, home, "aviary", "approve", user_code, "--json")
            return
        except subprocess.CalledProcessError:
            time.sleep(1)
    raise SmokeFailure("staging enrollment never became approvable")


def credential_fingerprint(root: Path, app_path: str) -> tuple[Path, str, int]:
    candidates = list(root.rglob(f"{app_path}.json"))
    if len(candidates) != 1:
        raise SmokeFailure(
            f"expected one project-scoped service credential, found {len(candidates)}"
        )
    path = candidates[0]
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise SmokeFailure(f"service credential must be mode 0600: {path}")
    return path, hashlib.sha256(path.read_bytes()).hexdigest(), mode


async def check_mcp(url: str, token: str) -> None:
    from fastmcp import Client

    async with Client(url, auth=token) as client:
        names = {tool.name for tool in await client.list_tools()}
        if not {"add", "package_version"}.issubset(names):
            raise SmokeFailure(f"MCP tools/list missing expected tools: {sorted(names)}")
        result = await client.call_tool("add", {"a": 20, "b": 22})
        if result.data != 42 and result.structured_content != {"result": 42}:
            raise SmokeFailure("MCP add result was not 42")


def main() -> int:
    require_opt_in(os.environ)
    hub = checked_staging_hub(os.environ.get("FINCH_E2E_HUB", DEFAULT_STAGING_HUB))
    mode = checked_mode(os.environ.get("FINCH_E2E_MODE", "local"))
    required_paths = {
        name: os.environ.get(name, "").strip()
        for name in (
            "FINCH_E2E_BINARY",
            "FINCH_E2E_CLI_HOME",
            "FINCH_CREDENTIALS_DIR",
            "FINCH_CONTROL_SOCKET",
        )
    }
    missing = [name for name, value in required_paths.items() if not value]
    if missing:
        raise SmokeFailure(f"missing required environment: {', '.join(missing)}")
    binary = Path(required_paths["FINCH_E2E_BINARY"]).expanduser().resolve()
    cli_home = Path(required_paths["FINCH_E2E_CLI_HOME"]).expanduser().resolve()
    credentials = Path(required_paths["FINCH_CREDENTIALS_DIR"]).expanduser().resolve()
    control_socket = Path(required_paths["FINCH_CONTROL_SOCKET"]).expanduser().resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise SmokeFailure("FINCH_E2E_BINARY must name an executable Finch binary")
    if not cli_home.is_dir():
        raise SmokeFailure("FINCH_E2E_CLI_HOME must name an isolated login HOME")
    if not credentials.is_dir():
        raise SmokeFailure("FINCH_CREDENTIALS_DIR must name the running agent's credential directory")
    control_socket.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    verify_cli_login(cli_home, hub)

    app_path = f"aviary-e2e-{int(time.time())}-{secrets.token_hex(3)}"
    box = f"github-e2e-{secrets.token_hex(4)}"
    project_dir = credentials.parent
    port = find_free_port()
    env = os.environ.copy()
    env.update(
        FINCH_E2E_APP_PATH=app_path,
        FINCH_E2E_HUB=hub,
        FINCH_E2E_PORT=str(port),
        FINCH_E2E_MODE=mode,
        FINCH_E2E_BINARY=str(binary),
        FINCH_E2E_BOX=box,
        FINCH_E2E_PROJECT_DIR=str(project_dir),
        PYTHONUNBUFFERED="1",
    )
    agent: AgentProcess | None = None
    app: AppProcess | None = None
    key_id: str | None = None
    try:
        if mode == "agent":
            agent = AgentProcess(binary, hub, credentials, control_socket, box)
        print(
            f"[1/7] enrolling disposable service {app_path} via Finch.{mode}",
            flush=True,
        )
        app = AppProcess(env)
        pending = app.wait_event("needs_enrollment", 30)
        verification = urlsplit(pending["authorization"]["verification_uri_complete"])
        if verification.scheme != "https" or verification.hostname != "finch-web-staging.pantainos.workers.dev":
            raise SmokeFailure("enrollment verification URL escaped the staging web origin")
        user_code = pending.get("authorization", {}).get("user_code")
        if not isinstance(user_code, str):
            raise SmokeFailure("enrollment authorization omitted user_code")
        approve_aviary_with_retry(binary, cli_home, user_code)
        ready = app.wait_event("ready", 60)
        expected_mcp = f"{hub}/{app_path}/mcp"
        if ready.get("public_url") != expected_mcp:
            raise SmokeFailure(
                f"ready enrollment returned the wrong public URL: {ready.get('public_url')!r}"
            )
        credential_root = project_dir if mode == "local" else credentials
        first_fingerprint = credential_fingerprint(credential_root, app_path)

        print("[2/7] minting a service-scoped caller key", flush=True)
        minted = run_cli(
            binary,
            cli_home,
            "keys",
            "mint",
            f"e2e-{app_path}",
            "--service",
            app_path,
            "--json",
            json_output=True,
        )
        token = minted.get("key")
        key_id = minted.get("id")
        if not isinstance(token, str) or not token.startswith("finch_") or not isinstance(key_id, str):
            raise SmokeFailure("key mint response omitted the key or id")

        rest_url = f"{hub}/{app_path}/api/v1/tools/add"
        print("[3/7] checking default-deny edge auth", flush=True)
        status, _ = request_after_relay_ready(
            "POST", rest_url, body={"a": 20, "b": 22}
        )
        if status not in {401, 403}:
            raise SmokeFailure(
                f"unauthenticated REST request returned {status}, expected 401 or 403"
            )

        print("[4/7] checking bearer REST and assertion-spoof stripping", flush=True)
        status, payload = request_after_relay_ready(
            "POST",
            rest_url,
            token=token,
            body={"a": 20, "b": 22},
            spoof_assertion=True,
        )
        if status != 200 or result_value(payload) != 42:
            raise SmokeFailure(f"authenticated REST request failed with status {status}")
        expected_version = os.environ.get("FINCH_E2E_EXPECTED_AVIARY_VERSION", "").strip()
        status, payload = request_after_relay_ready(
            "POST",
            f"{hub}/{app_path}/api/v1/tools/package_version",
            token=token,
            body={},
        )
        actual_version = result_value(payload)
        if status != 200 or not isinstance(actual_version, str) or not actual_version:
            raise SmokeFailure("public AviaryMCP package version tool failed")
        if expected_version and actual_version != expected_version:
            raise SmokeFailure(
                f"expected aviary-mcp {expected_version}, service runs {actual_version}"
            )

        print("[5/7] checking bearer Streamable HTTP MCP", flush=True)
        asyncio.run(check_mcp(expected_mcp, token))

        print(
            f"[6/7] restarting the application and {mode} Finch lifecycle",
            flush=True,
        )
        app.stop()
        app = None
        if agent is not None:
            agent.stop()
            agent = AgentProcess(binary, hub, credentials, control_socket, box)
        app = AppProcess(env)
        # Finch.local includes binary validation, child startup, and the
        # configured 60-second relay activation window. Give the full public
        # lifecycle contract time to settle rather than imposing a shorter
        # runner-only deadline.
        deadline = time.monotonic() + APP_RESTART_TIMEOUT
        local_status: int | None = None
        while True:
            if app.process.poll() is not None:
                raise SmokeFailure(
                    f"AviaryMCP exited during restart ({app.process.returncode})"
                )
            try:
                local_status, _ = request_json(
                    "GET", f"http://127.0.0.1:{port}/birdz"
                )
            except OSError:
                local_status = None
            status, payload = request_json(
                "POST", rest_url, token=token, body={"a": 19, "b": 23}
            )
            if status == 200 and result_value(payload) == 42:
                break
            if time.monotonic() >= deadline:
                raise SmokeFailure(
                    "service did not resume after application restart "
                    f"(local health status: {local_status})"
                )
            time.sleep(1)
        if credential_fingerprint(credential_root, app_path) != first_fingerprint:
            raise SmokeFailure("saved service credential changed across app restart")
        with app._lock:
            if any(event.get("state") in {"needs_login", "needs_enrollment", "pending"} for event in app.events):
                raise SmokeFailure("restart unexpectedly required enrollment")

        print("[7/7] staging smoke test passed; cleaning up", flush=True)
        return 0
    finally:
        if app is not None:
            app.stop()
        if agent is not None:
            agent.stop()
        if key_id is not None:
            with contextlib.suppress(Exception):
                run_cli(binary, cli_home, "keys", "revoke", key_id)
        with contextlib.suppress(Exception):
            run_cli(binary, cli_home, "rm", app_path)
        # The app path is generated by this process, so this cannot remove a
        # pre-existing service credential from the dedicated E2E directory.
        for path in project_dir.rglob(f"{app_path}.json"):
            with contextlib.suppress(FileNotFoundError):
                path.unlink()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SmokeFailure, subprocess.CalledProcessError, OSError, ValueError) as exc:
        print(f"STAGING E2E FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
