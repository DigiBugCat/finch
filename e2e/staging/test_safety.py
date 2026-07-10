"""Offline tests for the staging smoke suite's production safety gates."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


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


if __name__ == "__main__":
    unittest.main()
