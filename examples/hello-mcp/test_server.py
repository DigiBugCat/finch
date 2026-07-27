#!/usr/bin/env python3
# pyright: reportAttributeAccessIssue=false
"""Focused adversarial tests for the dependency-free hello-mcp example."""

import datetime
import http.client
import importlib.util
import json
import pathlib
import socket
import threading
import unittest


HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("hello_mcp_server", HERE / "server.py")
assert SPEC is not None and SPEC.loader is not None
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class QuietHandler(SERVER.Handler):
    def log_message(self, _fmt, *_args):
        pass


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old_timeout = SERVER.READ_TIMEOUT_SECONDS
        SERVER.READ_TIMEOUT_SECONDS = 0.2
        cls.server = SERVER.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.host, cls.port = cls.server.server_address

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        SERVER.READ_TIMEOUT_SECONDS = cls.old_timeout

    def request(self, method, path, body=None):
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body, separators=(",", ":")).encode()
        connection = http.client.HTTPConnection(self.host, self.port, timeout=2)
        try:
            connection.request(method, path, body=body)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def post(self, message):
        return self.request("POST", "/mcp", message)

    def raw(self, request, shutdown_write=True):
        with socket.create_connection((self.host, self.port), timeout=2) as sock:
            sock.settimeout(2)
            sock.sendall(request)
            if shutdown_write:
                sock.shutdown(socket.SHUT_WR)
            chunks = []
            while chunk := sock.recv(65536):
                chunks.append(chunk)
        head, _, body = b"".join(chunks).partition(b"\r\n\r\n")
        status = int(head.split(b"\r\n", 1)[0].split()[1])
        return status, body

    def assert_error(self, status, body, code, request_id=None):
        payload = json.loads(body)
        self.assertEqual(payload["jsonrpc"], "2.0")
        self.assertEqual(payload["id"], request_id)
        self.assertEqual(payload["error"]["code"], code)

    def tool_call(self, request_id, name, arguments):
        return self.post(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }
        )

    def test_health_handshake_and_tools_work(self):
        status, _, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["tools"], ["echo", "add", "now", "roll"])

        requests = [
            ({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}, "protocolVersion"),
            ({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}, "tools"),
        ]
        for request, result_key in requests:
            with self.subTest(method=request["method"]):
                status, _, body = self.post(request)
                self.assertEqual(status, 200)
                result = json.loads(body)["result"]
                if result_key:
                    self.assertIn(result_key, result)

        successes = [
            ("echo", {"text": "hello, 世界"}, "you said: hello, 世界"),
            ("add", {"a": -1.5, "b": 2.25}, "-1.5 + 2.25 = 0.75"),
        ]
        for index, (name, args, expected) in enumerate(successes):
            with self.subTest(tool=name):
                status, _, body = self.tool_call(index, name, args)
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)["result"]["content"][0]["text"], expected)

        status, _, body = self.tool_call("now", "now", {})
        datetime.datetime.fromisoformat(json.loads(body)["result"]["content"][0]["text"])
        for sides in (1, SERVER.MAX_DIE_SIDES):
            status, _, body = self.tool_call(f"roll-{sides}", "roll", {"sides": sides})
            self.assertEqual(status, 200)
            self.assertIn(f"(d{sides})", json.loads(body)["result"]["content"][0]["text"])

    def test_malformed_messages_return_standard_errors_and_do_not_corrupt_state(self):
        malformed = [
            (b"{", -32700),
            ([], -32600),
            ({"jsonrpc": "1.0", "id": 1, "method": "tools/list"}, -32600),
            ({"jsonrpc": "2.0", "id": 2, "method": 7}, -32600),
            ({"jsonrpc": "2.0", "id": [], "method": "tools/list"}, -32600),
            ({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": ["echo"]}, -32602),
        ]
        for message, code in malformed:
            with self.subTest(message=message):
                status, _, body = self.post(message)
                self.assertIn(status, (200, 400))
                request_id = message.get("id") if isinstance(message, dict) and code == -32602 else None
                self.assert_error(status, body, code, request_id)

        status, _, body = self.post({"jsonrpc": "2.0", "id": "after", "method": "tools/list"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["id"], "after")

    def test_invalid_tool_arguments_are_rejected_without_disconnects(self):
        cases = [
            ("echo", ["not-an-object"]),
            ("echo", {}),
            ("echo", {"text": 1}),
            ("add", {"a": 1, "b": "2"}),
            ("add", {"a": True, "b": 2}),
            ("add", {"a": 1e308, "b": 1e308}),
            ("roll", {"sides": 0}),
            ("roll", {"sides": 6.0}),
            ("roll", {"sides": SERVER.MAX_DIE_SIDES + 1}),
            ("missing", {}),
        ]
        for request_id, (name, args) in enumerate(cases):
            with self.subTest(tool=name, args=args):
                status, _, body = self.tool_call(request_id, name, args)
                self.assertEqual(status, 200)
                self.assert_error(status, body, -32602, request_id)

    def test_notifications_have_no_body_and_mcp_get_is_not_a_health_response(self):
        for notification in (
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "method": "unknown/notification"},
            {"jsonrpc": "2.0", "method": "tools/call", "params": ["bad"]},
        ):
            status, headers, body = self.post(notification)
            self.assertEqual(status, 202)
            self.assertEqual(headers["Content-Length"], "0")
            self.assertEqual(body, b"")

        status, headers, body = self.request("GET", "/mcp")
        self.assertEqual((status, headers["Allow"], body), (405, "POST", b""))

    def test_bad_framing_and_oversized_bodies_are_bounded(self):
        cases = [
            (b"", 411),
            (b"Content-Length: nope\r\n", 400),
            (b"Content-Length: +2\r\n", 400),
            (b"Content-Length: 99999999999999999999\r\n", 400),
            (b"Content-Length: -1\r\n", 400),
            (b"Content-Length: 2\r\nContent-Length: 2\r\n", 400),
            (b"Transfer-Encoding: chunked\r\n", 400),
            (f"Content-Length: {SERVER.MAX_BODY_BYTES + 1}\r\n".encode(), 413),
        ]
        for headers, expected in cases:
            request = (
                b"POST /mcp HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
                + headers
                + b"\r\n"
            )
            status, body = self.raw(request)
            self.assertEqual(status, expected)
            self.assert_error(status, body, -32600)

        short = (
            b"POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n"
            b"Connection: close\r\n\r\n{}"
        )
        status, body = self.raw(short)
        self.assertEqual(status, 400)
        self.assert_error(status, body, -32600)

    def test_slow_partial_body_times_out(self):
        request = (
            b"POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 20\r\n"
            b"Connection: close\r\n\r\n{"
        )
        status, body = self.raw(request, shutdown_write=False)
        self.assertEqual(status, 408)
        self.assert_error(status, body, -32600)

    def test_exact_body_limit_is_accepted(self):
        prefix = b'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"text":"'
        suffix = b'"}}}'
        body = prefix + (b"x" * (SERVER.MAX_BODY_BYTES - len(prefix) - len(suffix))) + suffix
        status, _, response = self.post(body)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(response)["result"]["content"][0]["text"].startswith("you said: "))

if __name__ == "__main__":
    unittest.main()
