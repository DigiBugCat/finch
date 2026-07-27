#!/usr/bin/env python3
"""Opt-in, destructive smoke test against the dedicated Finch staging hub.

The runner deliberately uses only the Python standard library until the MCP
check.  The selected interpreter must have the public ``aviary-mcp`` package
installed, which also supplies FastMCP for that check.
"""

from __future__ import annotations

import asyncio
from collections import deque
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import subprocess
import sys
import threading
import time
from typing import Any
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen


DEFAULT_STAGING_HUB = "https://finch-staging.pantainos.workers.dev"
STAGING_WEB_ORIGIN = "https://finch-web-staging.pantainos.workers.dev"
OPT_IN = "FINCH_STAGING_E2E"
MODES = frozenset({"local", "agent"})
APP_RESTART_TIMEOUT = 90
MAX_CREDENTIAL_BYTES = 1024 * 1024
MAX_HTTP_RESPONSE_BYTES = 1024 * 1024
MAX_ENROLLMENT_EVENTS = 64
MAX_EVENT_LINE_CHARS = 64 * 1024
MAX_UNIX_SOCKET_PATH_BYTES = 100
RELAY_READY_TIMEOUT = 20
RELAY_RETRY_INTERVAL = 1.0
APP_PATH_RE = re.compile(r"aviary-e2e-[0-9]{10,}-[0-9a-f]{32}")
USER_CODE_RE = re.compile(r"[A-Z2-9]{4}-[A-Z2-9]{4}")


class SmokeFailure(RuntimeError):
    pass


def checked_staging_hub(value: str) -> str:
    # Compare the original string, rather than a parsed/normalized form.
    # ``urlsplit`` silently strips tabs and newlines and cannot distinguish an
    # absent query from a trailing empty ``?``.  A destructive staging gate
    # should accept only the two spellings we deliberately document.
    if not isinstance(value, str) or value not in {
        DEFAULT_STAGING_HUB,
        f"{DEFAULT_STAGING_HUB}/",
    }:
        raise SmokeFailure(
            "refusing non-staging hub; this suite is hard-bound to "
            f"{DEFAULT_STAGING_HUB}"
        )
    return DEFAULT_STAGING_HUB


def require_opt_in(env: dict[str, str]) -> None:
    if env.get(OPT_IN) != "1":
        raise SmokeFailure(f"set {OPT_IN}=1 to authorize staging writes")


def checked_mode(value: str) -> str:
    if value not in MODES:
        raise SmokeFailure("FINCH_E2E_MODE must be local or agent")
    return value


def checked_app_path(value: str) -> str:
    if APP_PATH_RE.fullmatch(value) is None:
        raise SmokeFailure("refusing a non-disposable Finch service path")
    return value


def checked_private_directory(value: str, name: str) -> Path:
    path = Path(value).expanduser()
    try:
        initial = path.lstat()
        resolved = path.resolve(strict=True)
        current = resolved.stat()
    except OSError as exc:
        raise SmokeFailure(f"{name} must name an existing private directory") from exc
    if stat.S_ISLNK(initial.st_mode) or not stat.S_ISDIR(current.st_mode):
        raise SmokeFailure(f"{name} must name a real private directory, not a symlink")
    if stat.S_IMODE(current.st_mode) & 0o077:
        raise SmokeFailure(f"{name} must not be group/world accessible")
    if resolved.parent == resolved:
        raise SmokeFailure(f"{name} must not be the filesystem root")
    return resolved


def checked_control_socket_path(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    if "\x00" in str(path):
        raise SmokeFailure("FINCH_CONTROL_SOCKET contains a NUL byte")
    try:
        encoded = os.fsencode(path)
    except UnicodeError as exc:
        raise SmokeFailure("FINCH_CONTROL_SOCKET is not a valid filesystem path") from exc
    if len(encoded) > MAX_UNIX_SOCKET_PATH_BYTES:
        raise SmokeFailure(
            "FINCH_CONTROL_SOCKET is too long for a portable Unix-domain socket"
        )
    return path


def checked_e2e_layout(cli_home: Path, credentials: Path, control_parent: Path) -> Path:
    root = credentials.parent
    if (
        cli_home.parent != root
        or control_parent.parent != root
        or root in {Path.home().resolve(), Path.cwd().resolve()}
    ):
        raise SmokeFailure(
            "CLI HOME, credentials, and control socket must be siblings in a dedicated root"
        )
    return root


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


def read_private_file(path: Path, description: str) -> tuple[bytes, int]:
    """Read a small mode-0600 regular file without following a final symlink."""

    try:
        initial = path.lstat()
        if not stat.S_ISREG(initial.st_mode):
            raise SmokeFailure(f"{description} must be a regular file, not a symlink or device")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            current = os.fstat(descriptor)
            mode = stat.S_IMODE(current.st_mode)
            if not stat.S_ISREG(current.st_mode):
                raise SmokeFailure(f"{description} changed while it was being opened")
            if mode & 0o077:
                raise SmokeFailure(f"{description} must not be group/world accessible: {path}")
            if current.st_size > MAX_CREDENTIAL_BYTES:
                raise SmokeFailure(f"{description} is unexpectedly large: {path}")
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                data = stream.read(MAX_CREDENTIAL_BYTES + 1)
            if len(data) > MAX_CREDENTIAL_BYTES:
                raise SmokeFailure(f"{description} is unexpectedly large: {path}")
            return data, mode
        finally:
            os.close(descriptor)
    except SmokeFailure:
        raise
    except OSError as exc:
        raise SmokeFailure(f"could not safely read {description}: {path}") from exc


def parse_json_object(data: bytes, description: str) -> dict[str, Any]:
    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate key {key!r}")
            result[key] = value
        return result

    try:
        value = json.loads(data, object_pairs_hook=reject_duplicate_keys)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise SmokeFailure(f"{description} is not valid unambiguous JSON") from exc
    if not isinstance(value, dict):
        raise SmokeFailure(f"{description} must contain a JSON object")
    return value


def checked_secret(value: Any, description: str, *, prefix: str | None = None) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > 16 * 1024
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
        or (prefix is not None and not value.startswith(prefix))
    ):
        raise SmokeFailure(f"{description} is missing or malformed")
    return value


def verify_cli_login(home: Path, expected_hub: str) -> None:
    credential = home / ".finch" / "cli.json"
    try:
        data, _ = read_private_file(credential, "CLI credential")
        value = parse_json_object(data, "CLI credential")
    except SmokeFailure as exc:
        raise SmokeFailure(
            f"invalid isolated staging login at {credential}; run finch login "
            f"--hub {expected_hub} with HOME={home}"
        ) from exc
    try:
        credential_hub = checked_staging_hub(value.get("hub"))
    except (SmokeFailure, TypeError) as exc:
        raise SmokeFailure("isolated CLI credential is not scoped to the staging hub") from exc
    if credential_hub != expected_hub:
        raise SmokeFailure("isolated CLI credential is not scoped to the staging hub")
    checked_secret(value.get("token"), "isolated CLI credential token")


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
            raw = response.read(MAX_HTTP_RESPONSE_BYTES + 1)
            if len(raw) > MAX_HTTP_RESPONSE_BYTES:
                raise SmokeFailure("staging response exceeded the size limit")
            return response.status, json.loads(raw) if raw else None
    except HTTPError as exc:
        raw = exc.read(MAX_HTTP_RESPONSE_BYTES + 1)
        if len(raw) > MAX_HTTP_RESPONSE_BYTES:
            raise SmokeFailure("staging error response exceeded the size limit")
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


def checked_enrollment_authorization(event: Any) -> str:
    if not isinstance(event, dict):
        raise SmokeFailure("enrollment event must be a JSON object")
    authorization = event.get("authorization")
    if not isinstance(authorization, dict):
        raise SmokeFailure("enrollment event omitted authorization details")
    user_code = authorization.get("user_code")
    if not isinstance(user_code, str) or USER_CODE_RE.fullmatch(user_code) is None:
        raise SmokeFailure("enrollment did not return a valid user_code")
    verification_uri = authorization.get("verification_uri_complete")
    if not isinstance(verification_uri, str) or any(
        ord(character) < 0x20 or ord(character) == 0x7F
        for character in verification_uri
    ):
        raise SmokeFailure("enrollment omitted a valid verification URL")
    try:
        verification = urlsplit(verification_uri)
        port = verification.port
    except ValueError as exc:
        raise SmokeFailure("enrollment returned a malformed verification URL") from exc
    if (
        verification.scheme != "https"
        or verification.hostname != "finch-web-staging.pantainos.workers.dev"
        or port is not None
        or verification.username is not None
        or verification.password is not None
        or verification.path != "/aviary/authorize"
        or verification.fragment
    ):
        raise SmokeFailure("enrollment verification URL escaped the staging web endpoint")
    try:
        query = parse_qs(
            verification.query,
            keep_blank_values=True,
            strict_parsing=True,
            max_num_fields=2,
        )
    except ValueError as exc:
        raise SmokeFailure("enrollment verification URL had a malformed query") from exc
    if query != {"code": [user_code]}:
        raise SmokeFailure("enrollment verification URL did not match its user_code")
    return user_code


def terminate_process(process: subprocess.Popen[Any], description: str) -> None:
    if process.poll() is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        process.wait()
        return
    try:
        process.wait(timeout=10)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        process.kill()
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired as exc:
        raise SmokeFailure(f"could not stop {description}") from exc


def request_after_relay_ready(
    method: str,
    url: str,
    *,
    timeout: float = RELAY_READY_TIMEOUT,
    **kwargs: Any,
) -> tuple[int, Any]:
    if timeout < 0:
        raise ValueError("timeout must be non-negative")
    deadline = time.monotonic() + timeout
    while True:
        try:
            status, payload = request_json(method, url, **kwargs)
        except OSError as exc:
            now = time.monotonic()
            if now >= deadline:
                raise SmokeFailure("relay remained unreachable after retries") from exc
            time.sleep(min(RELAY_RETRY_INTERVAL, deadline - now))
            continue
        now = time.monotonic()
        if status not in {502, 503, 504} or now >= deadline:
            return status, payload
        time.sleep(min(RELAY_RETRY_INTERVAL, deadline - now))


class AppProcess:
    def __init__(self, env: dict[str, str]) -> None:
        self.events: deque[dict[str, Any]] = deque(maxlen=MAX_ENROLLMENT_EVENTS)
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
        discarding_oversized_line = False
        while True:
            line = stream.readline(MAX_EVENT_LINE_CHARS + 1)
            if not line:
                return
            ends_line = line.endswith("\n")
            if discarding_oversized_line:
                discarding_oversized_line = not ends_line
                continue
            if len(line) > MAX_EVENT_LINE_CHARS:
                discarding_oversized_line = not ends_line
                continue
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
        terminate_process(self.process, "AviaryMCP")
        for thread in self._threads:
            thread.join(timeout=1)


class AgentProcess:
    def __init__(
        self,
        binary: Path,
        hub: str,
        credentials: Path,
        control_socket: Path,
        box: str,
    ) -> None:
        self.control_socket = control_socket
        self._socket_identity: tuple[int, int] | None = None
        env = os.environ.copy()
        env.update(
            FINCH_HUB=hub,
            FINCH_BOX=box,
            FINCH_CONTROL_SOCKET=str(control_socket),
            FINCH_CONTROL_SOCKET_MODE="0600",
            FINCH_CREDENTIALS_DIR=str(credentials),
            FINCH_AVIARY_VERIFICATION_ORIGINS=(
                STAGING_WEB_ORIGIN
            ),
        )
        try:
            existing = control_socket.lstat()
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise SmokeFailure("could not inspect Finch agent control socket path") from exc
        else:
            kind = "socket" if stat.S_ISSOCK(existing.st_mode) else "non-socket path"
            raise SmokeFailure(
                f"FINCH_CONTROL_SOCKET already exists as a {kind}; refusing to replace it"
            )
        self.process = subprocess.Popen(
            [str(binary), "run"],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise SmokeFailure(f"Finch agent exited early ({self.process.returncode})")
                try:
                    current = control_socket.lstat()
                except FileNotFoundError:
                    time.sleep(0.1)
                    continue
                except OSError as exc:
                    raise SmokeFailure("could not inspect Finch agent control socket") from exc
                if not stat.S_ISSOCK(current.st_mode):
                    raise SmokeFailure("Finch agent created a non-socket control path")
                if stat.S_IMODE(current.st_mode) & 0o077:
                    raise SmokeFailure("Finch agent control socket must be mode 0600")
                self._socket_identity = (current.st_dev, current.st_ino)
                return
            raise SmokeFailure("timed out waiting for Finch agent control socket")
        except BaseException:
            self.stop()
            raise

    def stop(self) -> None:
        terminate_process(self.process, "Finch agent")
        if self._socket_identity is None:
            return
        try:
            current = self.control_socket.lstat()
            if (
                stat.S_ISSOCK(current.st_mode)
                and (current.st_dev, current.st_ino) == self._socket_identity
            ):
                self.control_socket.unlink()
        except FileNotFoundError:
            pass
        finally:
            self._socket_identity = None


def approve_aviary_with_retry(binary: Path, home: Path, user_code: str) -> None:
    if USER_CODE_RE.fullmatch(user_code) is None:
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
    checked_app_path(app_path)
    candidates = list(root.rglob(f"{app_path}.json"))
    if len(candidates) != 1:
        raise SmokeFailure(
            f"expected one project-scoped service credential, found {len(candidates)}"
        )
    path = candidates[0]
    data, mode = read_private_file(path, "service credential")
    return path, hashlib.sha256(data).hexdigest(), mode


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
    cli_home = checked_private_directory(
        required_paths["FINCH_E2E_CLI_HOME"], "FINCH_E2E_CLI_HOME"
    )
    credentials = checked_private_directory(
        required_paths["FINCH_CREDENTIALS_DIR"], "FINCH_CREDENTIALS_DIR"
    )
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise SmokeFailure("FINCH_E2E_BINARY must name an executable Finch binary")
    project_dir = checked_private_directory(
        str(credentials.parent), "FINCH_CREDENTIALS_DIR parent"
    )
    requested_socket = checked_control_socket_path(required_paths["FINCH_CONTROL_SOCKET"])
    requested_socket.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    control_parent = checked_private_directory(
        str(requested_socket.parent), "FINCH_CONTROL_SOCKET parent"
    )
    control_socket = checked_control_socket_path(str(control_parent / requested_socket.name))
    project_dir = checked_e2e_layout(cli_home, credentials, control_parent)
    verify_cli_login(cli_home, hub)

    app_path = checked_app_path(
        f"aviary-e2e-{int(time.time())}-{secrets.token_hex(16)}"
    )
    box = f"github-e2e-{secrets.token_hex(16)}"
    if next(project_dir.rglob(f"{app_path}.json"), None) is not None:
        raise SmokeFailure("generated service path collided with an existing credential")
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
        FINCH_CONTROL_SOCKET=str(control_socket),
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
        user_code = checked_enrollment_authorization(pending)
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
        if not isinstance(minted, dict):
            raise SmokeFailure("key mint response was not a JSON object")
        key_id = checked_secret(minted.get("id"), "key mint id")
        token = checked_secret(minted.get("key"), "key mint key", prefix="finch_")

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
            except (OSError, ValueError):
                local_status = None
            try:
                status, payload = request_json(
                    "POST", rest_url, token=token, body={"a": 19, "b": 23}
                )
            except OSError:
                status, payload = 0, None
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
    except (SmokeFailure, subprocess.SubprocessError, OSError, ValueError) as exc:
        print(f"STAGING E2E FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
