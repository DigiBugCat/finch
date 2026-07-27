#!/usr/bin/env python3
"""Semantic validation for the Docker Compose example."""

import json
import pathlib
import shutil
import subprocess
import unittest


HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
COMPOSE_FILE = HERE / "docker-compose.yml"


class ComposeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("docker"):
            raise unittest.SkipTest("docker CLI is not installed")
        process = subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE_FILE), "config", "--format", "json"],
            cwd=HERE,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
        )
        if process.returncode:
            raise AssertionError(f"docker compose config failed:\n{process.stderr}")
        cls.config = json.loads(process.stdout)

    def test_services_are_confined_to_the_compose_network(self):
        services = self.config["services"]
        self.assertEqual(set(services), {"finch", "hello-mcp"})
        for name, service in services.items():
            with self.subTest(service=name):
                self.assertFalse(service.get("ports"), "the example must not publish host ports")
                self.assertNotEqual(service.get("network_mode"), "host")
                self.assertFalse(service.get("privileged", False))

        hello = services["hello-mcp"]
        self.assertEqual(hello["environment"]["HOST"], "0.0.0.0")
        server_mounts = [
            mount for mount in hello["volumes"] if mount["target"] == "/app/server.py"
        ]
        self.assertEqual(len(server_mounts), 1)
        self.assertEqual(server_mounts[0]["type"], "bind")
        self.assertTrue(server_mounts[0]["read_only"])
        self.assertEqual(
            pathlib.Path(server_mounts[0]["source"]).resolve(),
            ROOT / "examples" / "hello-mcp" / "server.py",
        )

        finch = services["finch"]
        self.assertEqual(pathlib.Path(finch["build"]["context"]).resolve(), ROOT / "agent")
        data_mounts = [mount for mount in finch["volumes"] if mount["target"] == "/data"]
        self.assertEqual(len(data_mounts), 1)
        self.assertEqual(data_mounts[0]["type"], "volume")

    def test_finch_waits_for_a_healthy_example_server(self):
        services = self.config["services"]
        healthcheck = services["hello-mcp"].get("healthcheck")
        self.assertIsInstance(healthcheck, dict)
        self.assertGreaterEqual(healthcheck.get("retries", 0), 3)
        self.assertEqual(
            services["finch"]["depends_on"]["hello-mcp"]["condition"],
            "service_healthy",
        )


if __name__ == "__main__":
    unittest.main()
