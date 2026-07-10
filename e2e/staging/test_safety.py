"""Offline tests for the staging smoke suite's production safety gates."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import runpy
import sys
import types
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("finch_staging_e2e", Path(__file__).with_name("run.py"))
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class SafetyTests(unittest.TestCase):
    def test_rejects_every_non_staging_origin(self) -> None:
        urls = [
        "https://finchmcp.com",
        "https://aviary.finchmcp.com",
        "http://finch-staging.pantainos.workers.dev",
        "https://finch-staging.pantainos.workers.dev.evil.example",
        "https://finch-staging.pantainos.workers.dev/path",
        "https://user@finch-staging.pantainos.workers.dev",
        ]
        for url in urls:
            with self.subTest(url=url), self.assertRaisesRegex(
                runner.SmokeFailure, "refusing non-staging hub"
            ):
                runner.checked_staging_hub(url)

    def test_accepts_only_exact_staging_origin(self) -> None:
        self.assertEqual(
            runner.checked_staging_hub(runner.DEFAULT_STAGING_HUB + "/"),
            runner.DEFAULT_STAGING_HUB,
        )

    def test_requires_explicit_write_opt_in(self) -> None:
        with self.assertRaisesRegex(runner.SmokeFailure, "authorize staging writes"):
            runner.require_opt_in({})
        runner.require_opt_in({runner.OPT_IN: "1"})

    def test_accepts_only_known_runtime_modes(self) -> None:
        self.assertEqual(runner.checked_mode("local"), "local")
        self.assertEqual(runner.checked_mode("agent"), "agent")
        for value in ("", "embedded", "production"):
            with self.subTest(value=value), self.assertRaisesRegex(
                runner.SmokeFailure, "must be local or agent"
            ):
                runner.checked_mode(value)

    def test_retries_only_transient_relay_statuses(self) -> None:
        responses = iter([(503, None), (401, {"error": "missing key"})])
        with mock.patch.object(runner, "request_json", side_effect=responses) as request:
            with mock.patch.object(runner.time, "sleep"):
                self.assertEqual(
                    runner.request_after_relay_ready("POST", "https://staging.invalid"),
                    (401, {"error": "missing key"}),
                )
        self.assertEqual(request.call_count, 2)

    def test_local_connector_receives_explicit_binary(self) -> None:
        calls: list[tuple[str, dict[str, object]]] = []

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

        fake_module = types.SimpleNamespace(
            AviaryMCP=FakeApp,
            Finch=FakeFinch,
            FinchAssertionAuth=lambda **kwargs: object(),
        )
        env = {
            "FINCH_E2E_APP_PATH": "test-service",
            "FINCH_E2E_HUB": runner.DEFAULT_STAGING_HUB,
            "FINCH_E2E_PORT": "18080",
            "FINCH_E2E_MODE": "local",
            "FINCH_E2E_BOX": "test-box",
            "FINCH_E2E_BINARY": "/tmp/explicit-finch",
            "FINCH_E2E_PROJECT_DIR": "/tmp/project",
        }
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.dict(
            sys.modules, {"aviary_mcp": fake_module}
        ):
            runpy.run_path(str(Path(__file__).with_name("app.py")), run_name="staging_app")

        self.assertEqual(calls[0][0], "local")
        self.assertEqual(calls[0][1]["binary"], "/tmp/explicit-finch")
        self.assertEqual(calls[0][1]["path"], "test-service")


if __name__ == "__main__":
    unittest.main()
