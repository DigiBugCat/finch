"""Offline adversarial tests for the staging smoke suite's safety contracts."""

from __future__ import annotations

from collections import deque
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import socket
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock
from urllib.error import HTTPError


SPEC = importlib.util.spec_from_file_location(
    "finch_staging_e2e", Path(__file__).with_name("run.py")
)
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)

APP_PATH = "aviary-e2e-1760000000-0123456789abcdef0123456789abcdef"
BOX = "github-e2e-0123456789abcdef0123456789abcdef"
CODE = "WXYZ-2K7Q"
VERIFY_URL = f"{runner.STAGING_WEB_ORIGIN}/aviary/authorize?code={CODE}"


def app_env(mode: str = "local") -> dict[str, str]:
    return {
        "FINCH_E2E_APP_PATH": APP_PATH,
        "FINCH_E2E_HUB": runner.DEFAULT_STAGING_HUB,
        "FINCH_E2E_PORT": "18080",
        "FINCH_E2E_MODE": mode,
        "FINCH_E2E_BOX": BOX,
        "FINCH_E2E_BINARY": "/tmp/explicit-finch",
        "FINCH_E2E_PROJECT_DIR": "/tmp/project",
        "FINCH_CONTROL_SOCKET": "/tmp/finch-e2e.sock",
    }


def run_app(env: dict[str, str], calls: list[tuple[str, dict[str, object]]]) -> None:
    class FakeFinch:
        @staticmethod
        def local(**kwargs: object) -> object:
            calls.append(("local", kwargs))
            return object()

        @staticmethod
        def agent(**kwargs: object) -> object:
            calls.append(("agent", kwargs))
            return object()

    class FakeApp:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def tool(self, function: object) -> object:
            return function

    module = types.SimpleNamespace(AviaryMCP=FakeApp, Finch=FakeFinch)
    with mock.patch.dict(os.environ, env, clear=True), mock.patch.dict(
        sys.modules, {"aviary_mcp": module}
    ):
        runpy.run_path(str(Path(__file__).with_name("app.py")), run_name="staging_app")


def write_login(home: Path, payload: bytes) -> Path:
    directory = home / ".finch"
    directory.mkdir(mode=0o700)
    path = directory / "cli.json"
    path.write_bytes(payload)
    path.chmod(0o600)
    return path


class StagingSafetyTests(unittest.TestCase):
    def test_destructive_hub_opt_in_and_mode_gates_are_exact(self) -> None:
        for value in (runner.DEFAULT_STAGING_HUB, runner.DEFAULT_STAGING_HUB + "/"):
            self.assertEqual(runner.checked_staging_hub(value), runner.DEFAULT_STAGING_HUB)
        for value in (
            "https://finchmcp.com",
            "http://finch-staging.pantainos.workers.dev",
            runner.DEFAULT_STAGING_HUB + "?",
            runner.DEFAULT_STAGING_HUB + "#",
            runner.DEFAULT_STAGING_HUB + "////",
            runner.DEFAULT_STAGING_HUB + "\n",
            "https://finch-staging.pantai\tnos.workers.dev",
            "https://user@finch-staging.pantainos.workers.dev",
        ):
            with self.subTest(hub=value), self.assertRaises(runner.SmokeFailure):
                runner.checked_staging_hub(value)

        for value in (None, "true", "01", "1 "):
            env = {} if value is None else {runner.OPT_IN: value}
            with self.subTest(opt_in=value), self.assertRaises(runner.SmokeFailure):
                runner.require_opt_in(env)
        runner.require_opt_in({runner.OPT_IN: "1"})
        for mode in runner.MODES:
            self.assertEqual(runner.checked_mode(mode), mode)
        for mode in ("", "LOCAL", "production", "local "):
            with self.subTest(mode=mode), self.assertRaises(runner.SmokeFailure):
                runner.checked_mode(mode)

    def test_enrollment_event_binds_exact_staging_endpoint_to_user_code(self) -> None:
        valid = {
            "authorization": {
                "user_code": CODE,
                "verification_uri_complete": VERIFY_URL,
            }
        }
        self.assertEqual(runner.checked_enrollment_authorization(valid), CODE)
        bad_urls = (
            VERIFY_URL + "\n",
            VERIFY_URL.replace("https://", "http://"),
            VERIFY_URL.replace("finch-web-staging", "user@finch-web-staging"),
            VERIFY_URL.replace(".workers.dev/", ".workers.dev:443/"),
            VERIFY_URL.replace(CODE, "ABCD-EFGH"),
            VERIFY_URL + "&code=" + CODE,
        )
        malformed = [None, {}, {"authorization": []}]
        malformed += [
            {"authorization": {"user_code": CODE, "verification_uri_complete": url}}
            for url in bad_urls
        ]
        malformed.append(
            {"authorization": {"user_code": "lowercase", "verification_uri_complete": VERIFY_URL}}
        )
        for event in malformed:
            with self.subTest(event=event), self.assertRaises(runner.SmokeFailure):
                runner.checked_enrollment_authorization(event)

    def test_disposable_app_is_staging_bound_in_both_connector_modes(self) -> None:
        calls: list[tuple[str, dict[str, object]]] = []
        run_app(app_env("local"), calls)
        run_app(app_env("agent"), calls)
        self.assertEqual([item[0] for item in calls], ["local", "agent"])
        self.assertEqual(calls[0][1]["binary"], "/tmp/explicit-finch")
        self.assertEqual(calls[0][1]["path"], APP_PATH)
        self.assertEqual(calls[1][1]["socket"], "/tmp/finch-e2e.sock")

        for name, value in (
            ("FINCH_E2E_HUB", "https://finchmcp.com"),
            ("FINCH_E2E_HUB", runner.DEFAULT_STAGING_HUB + "?"),
            ("FINCH_E2E_APP_PATH", "existing-service"),
            ("FINCH_E2E_PORT", "0"),
            ("FINCH_E2E_PORT", "65536"),
            ("FINCH_E2E_PORT", "+1234"),
        ):
            env = app_env()
            env[name] = value
            unsafe_calls: list[tuple[str, dict[str, object]]] = []
            with self.subTest(name=name, value=value), self.assertRaises(RuntimeError):
                run_app(env, unsafe_calls)
            self.assertEqual(unsafe_calls, [])

    def test_private_directory_rejects_public_modes_and_final_symlinks(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            path = root / "private"
            path.mkdir(mode=0o700)
            self.assertEqual(
                runner.checked_private_directory(str(path), "test"), path.resolve()
            )
            path.chmod(0o755)
            with self.assertRaisesRegex(runner.SmokeFailure, "group/world"):
                runner.checked_private_directory(str(path), "test")
            path.chmod(0o700)
            link = root / "link"
            link.symlink_to(path, target_is_directory=True)
            with self.assertRaisesRegex(runner.SmokeFailure, "symlink"):
                runner.checked_private_directory(str(link), "test")
            with self.assertRaisesRegex(runner.SmokeFailure, "too long"):
                runner.checked_control_socket_path("/tmp/" + "x" * 101)

            home, credentials, control = (root / name for name in ("home", "credentials", "run"))
            self.assertEqual(
                runner.checked_e2e_layout(home, credentials, control), root
            )
            with self.assertRaisesRegex(runner.SmokeFailure, "dedicated root"):
                runner.checked_e2e_layout(home / "nested", credentials, control)

    def test_login_file_is_private_regular_bounded_and_unambiguous_json(self) -> None:
        valid = json.dumps(
            {"hub": runner.DEFAULT_STAGING_HUB, "token": "session-token"}
        ).encode()
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            home = root / "valid"
            home.mkdir()
            credential = write_login(home, valid)
            runner.verify_cli_login(home, runner.DEFAULT_STAGING_HUB)
            credential.chmod(0o640)
            with self.assertRaises(runner.SmokeFailure):
                runner.verify_cli_login(home, runner.DEFAULT_STAGING_HUB)

            payloads = (
                b"[]",
                b'{"hub":"https://finch-staging.pantainos.workers.dev","hub":"https://finchmcp.com","token":"x"}',
                json.dumps({"hub": 7, "token": "x"}).encode(),
                json.dumps({"hub": runner.DEFAULT_STAGING_HUB, "token": "x\nheader"}).encode(),
            )
            for index, payload in enumerate(payloads):
                malformed_home = root / f"malformed-{index}"
                malformed_home.mkdir()
                write_login(malformed_home, payload)
                with self.subTest(payload=payload), self.assertRaises(runner.SmokeFailure):
                    runner.verify_cli_login(malformed_home, runner.DEFAULT_STAGING_HUB)

            for kind in ("symlink", "fifo", "oversized"):
                special_home = root / kind
                directory = special_home / ".finch"
                directory.mkdir(parents=True)
                special = directory / "cli.json"
                if kind == "symlink":
                    target = root / "target.json"
                    target.write_bytes(valid)
                    target.chmod(0o600)
                    special.symlink_to(target)
                elif kind == "fifo":
                    os.mkfifo(special, mode=0o600)
                else:
                    special.write_bytes(b"x" * (runner.MAX_CREDENTIAL_BYTES + 1))
                    special.chmod(0o600)
                with self.subTest(kind=kind), self.assertRaises(runner.SmokeFailure):
                    runner.verify_cli_login(special_home, runner.DEFAULT_STAGING_HUB)

    def test_service_credential_fingerprint_rejects_ambiguous_matches(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            first = root / "one" / f"{APP_PATH}.json"
            first.parent.mkdir()
            first.write_bytes(b"credential")
            first.chmod(0o600)
            self.assertEqual(
                runner.credential_fingerprint(root, APP_PATH),
                (first, hashlib.sha256(b"credential").hexdigest(), 0o600),
            )
            second = root / "two" / first.name
            second.parent.mkdir()
            second.write_bytes(b"other")
            second.chmod(0o600)
            with self.assertRaisesRegex(runner.SmokeFailure, "found 2"):
                runner.credential_fingerprint(root, APP_PATH)

    def test_response_bodies_and_event_history_are_bounded(self) -> None:
        class Response(io.BytesIO):
            status = 200

            def __enter__(self) -> "Response":
                return self

            def __exit__(self, *args: object) -> None:
                self.close()

        with mock.patch.object(runner, "urlopen", return_value=Response(b'{"ok":true}')):
            self.assertEqual(
                runner.request_json("GET", "https://staging.invalid"),
                (200, {"ok": True}),
            )
        oversized = b"x" * (runner.MAX_HTTP_RESPONSE_BYTES + 1)
        with mock.patch.object(runner, "urlopen", return_value=Response(oversized)):
            with self.assertRaisesRegex(runner.SmokeFailure, "size limit"):
                runner.request_json("GET", "https://staging.invalid")
        error = HTTPError("https://staging.invalid", 503, "bad", {}, io.BytesIO(oversized))
        try:
            with mock.patch.object(runner, "urlopen", side_effect=error):
                with self.assertRaisesRegex(runner.SmokeFailure, "size limit"):
                    runner.request_json("GET", "https://staging.invalid")
        finally:
            error.close()

        app = object.__new__(runner.AppProcess)
        app.events = deque(maxlen=runner.MAX_ENROLLMENT_EVENTS)
        app._lock = threading.Lock()
        lines = [
            json.dumps({"event": "finch_enrollment", "state": str(index)})
            for index in range(runner.MAX_ENROLLMENT_EVENTS + 2)
        ]
        lines.insert(0, "x" * (runner.MAX_EVENT_LINE_CHARS + 1))
        app._consume(io.StringIO("\n".join(lines)))
        self.assertEqual(len(app.events), runner.MAX_ENROLLMENT_EVENTS)
        self.assertEqual(app.events[0]["state"], "2")

    def test_relay_retries_transport_and_gateway_races_with_a_hard_deadline(self) -> None:
        clock = [0.0]

        def advance(seconds: float) -> None:
            clock[0] += seconds

        responses = [OSError("offline"), (503, None), (401, None)]
        with mock.patch.object(runner, "request_json", side_effect=responses) as request:
            with mock.patch.object(runner.time, "monotonic", side_effect=lambda: clock[0]):
                with mock.patch.object(runner.time, "sleep", side_effect=advance):
                    self.assertEqual(
                        runner.request_after_relay_ready("POST", "unused", timeout=5),
                        (401, None),
                    )
        self.assertEqual(request.call_count, 3)

        clock[0] = 0
        with mock.patch.object(runner, "request_json", side_effect=OSError("offline")):
            with mock.patch.object(runner.time, "monotonic", side_effect=lambda: clock[0]):
                with mock.patch.object(runner.time, "sleep", side_effect=advance):
                    with self.assertRaisesRegex(runner.SmokeFailure, "unreachable"):
                        runner.request_after_relay_ready("POST", "unused", timeout=2)
        self.assertEqual(clock[0], 2)

    def test_agent_never_replaces_an_existing_control_path(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            path = Path(temporary) / "control.sock"
            path.write_text("preserve me")
            with mock.patch.object(runner.subprocess, "Popen") as popen:
                with self.assertRaisesRegex(runner.SmokeFailure, "refusing to replace"):
                    runner.AgentProcess(
                        Path("/fake/finch"), runner.DEFAULT_STAGING_HUB,
                        Path(temporary), path, BOX,
                    )
            popen.assert_not_called()
            self.assertEqual(path.read_text(), "preserve me")

    def test_agent_stops_failed_child_and_removes_only_its_owned_socket(self) -> None:
        class Process:
            returncode: int | None = None
            terminated = False

            def poll(self) -> int | None:
                return self.returncode

            def terminate(self) -> None:
                self.terminated = True
                self.returncode = 0

            def wait(self, timeout: float | None = None) -> int:
                return 0

        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            path = Path(temporary) / "control.sock"
            process = Process()

            def start_invalid(*args: object, **kwargs: object) -> Process:
                path.write_text("not a socket")
                return process

            with mock.patch.object(runner.subprocess, "Popen", side_effect=start_invalid):
                with self.assertRaisesRegex(runner.SmokeFailure, "non-socket"):
                    runner.AgentProcess(
                        Path("/fake/finch"), runner.DEFAULT_STAGING_HUB,
                        Path(temporary), path, BOX,
                    )
            self.assertTrue(process.terminated)
            path.unlink()

            process = Process()
            listener = socket.socket(socket.AF_UNIX)

            def start(*args: object, **kwargs: object) -> Process:
                listener.bind(str(path))
                path.chmod(0o600)
                return process

            try:
                with mock.patch.object(runner.subprocess, "Popen", side_effect=start):
                    agent = runner.AgentProcess(
                        Path("/fake/finch"), runner.DEFAULT_STAGING_HUB,
                        Path(temporary), path, BOX,
                    )
                listener.close()
                agent.stop()
            finally:
                listener.close()
            self.assertTrue(process.terminated)
            self.assertFalse(path.exists())

    def test_workflow_secret_is_visible_only_to_credential_preparation_step(self) -> None:
        workflow = (
            Path(__file__).resolve().parents[2] / ".github/workflows/staging-e2e.yml"
        ).read_text()
        lines = workflow.splitlines()
        indexes = [
            index for index, line in enumerate(lines)
            if "secrets.FINCH_STAGING_E2E_CLI_JSON" in line
        ]
        references = [lines[index] for index in indexes]
        self.assertEqual(len(references), 1)
        self.assertRegex(references[0], r"^ {10}FINCH_CLI_JSON:")
        self.assertIn("- name: Prepare isolated credentials", "\n".join(lines[indexes[0] - 3:indexes[0]]))


if __name__ == "__main__":
    unittest.main()
