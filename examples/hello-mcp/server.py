#!/usr/bin/env python3
"""A tiny dependency-free MCP server for testing finch end to end."""

import datetime
import json
import math
import os
import random
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL = "2025-06-18"
MAX_BODY_BYTES = 64 * 1024
MAX_DIE_SIDES = 1_000_000
READ_TIMEOUT_SECONDS = 5

TOOLS = [
    {
        "name": "echo",
        "description": "Echo back whatever text you send.",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "add",
        "description": "Add two finite numbers.",
        "inputSchema": {
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
            "required": ["a", "b"],
        },
    },
    {
        "name": "now",
        "description": "Return the current UTC server time (ISO 8601).",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "roll",
        "description": "Roll an N-sided die (default 6).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "sides": {"type": "integer", "minimum": 1, "maximum": MAX_DIE_SIDES}
            },
        },
    },
]


class InvalidParams(ValueError):
    pass


def call_tool(name, args):
    if not isinstance(args, dict):
        raise InvalidParams("arguments must be an object")
    if name == "echo":
        if not isinstance(args.get("text"), str):
            raise InvalidParams("text must be a string")
        return f"you said: {args['text']}"
    if name == "add":
        a, b = args.get("a"), args.get("b")
        if (
            isinstance(a, bool)
            or not isinstance(a, (int, float))
            or isinstance(b, bool)
            or not isinstance(b, (int, float))
        ):
            raise InvalidParams("a and b must be numbers")
        if any(isinstance(value, float) and not math.isfinite(value) for value in (a, b)):
            raise InvalidParams("a and b must be finite")
        try:
            total = a + b
            if isinstance(total, float) and not math.isfinite(total):
                raise InvalidParams("a + b must be finite")
            return f"{a} + {b} = {total}"
        except (ArithmeticError, ValueError) as exc:
            raise InvalidParams("numbers are outside the supported range") from exc
    if name == "now":
        now = datetime.datetime.now(datetime.timezone.utc)
        return now.isoformat(timespec="seconds").replace("+00:00", "Z")
    if name == "roll":
        sides = args.get("sides", 6)
        if isinstance(sides, bool) or not isinstance(sides, int):
            raise InvalidParams("sides must be an integer")
        if not 1 <= sides <= MAX_DIE_SIDES:
            raise InvalidParams(f"sides must be between 1 and {MAX_DIE_SIDES}")
        return f"🎲 rolled a {random.randint(1, sides)} (d{sides})"
    raise InvalidParams("unknown tool")


def error(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(READ_TIMEOUT_SECONDS)

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _empty(self, code, allow=None):
        self.send_response(code)
        if allow:
            self.send_header("Allow", allow)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _body_error(self, code, message):
        self.close_connection = True
        self._json(error(None, -32600, message), code)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            return self._json(
                {"ok": True, "server": "hello-mcp", "tools": [tool["name"] for tool in TOOLS]}
            )
        if path == "/mcp":
            return self._empty(405, "POST")
        return self._json({"error": "not found"}, 404)

    def _read_body(self):
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) > 1:
            self._body_error(400, "Ambiguous request framing")
            return None
        if not lengths:
            self._body_error(411, "Content-Length is required")
            return None
        raw_length = lengths[0]
        if len(raw_length) > 10 or not raw_length.isascii() or not raw_length.isdecimal():
            self._body_error(400, "Invalid Content-Length")
            return None
        length = int(raw_length)
        if length > MAX_BODY_BYTES:
            self._body_error(413, "Request body is too large")
            return None
        try:
            body = self.rfile.read(length)
        except TimeoutError:
            self._body_error(408, "Request body timed out")
            return None
        if len(body) != length:
            self._body_error(400, "Request body is shorter than Content-Length")
            return None
        return body

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/mcp":
            self.close_connection = True
            return self._json({"error": "not found"}, 404)
        body = self._read_body()
        if body is None:
            return
        try:
            req = json.loads(body)
        except (ValueError, RecursionError):
            return self._json(error(None, -32700, "Parse error"), 400)
        if not isinstance(req, dict) or req.get("jsonrpc") != "2.0":
            return self._json(error(None, -32600, "Invalid Request"), 400)
        method, has_id = req.get("method"), "id" in req
        if not isinstance(method, str):
            return self._json(error(None, -32600, "Invalid Request"), 400)
        request_id, params = req.get("id"), req.get("params")
        valid_id = request_id is None or (
            not isinstance(request_id, bool) and isinstance(request_id, (str, int, float))
        )
        if has_id and (not valid_id or isinstance(request_id, float) and not math.isfinite(request_id)):
            return self._json(error(None, -32600, "Invalid Request"), 400)
        if "params" in req and not isinstance(params, dict):
            return self._empty(202) if not has_id else self._json(error(request_id, -32602, "Invalid params"))
        if not has_id:  # JSON-RPC notifications never receive a response body.
            return self._empty(202)

        if method == "initialize":
            result = {
                "protocolVersion": PROTOCOL,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "hello-mcp", "version": "1.0.0"},
            }
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            if not isinstance(params, dict) or not isinstance(params.get("name"), str):
                return self._json(error(request_id, -32602, "Invalid params"))
            try:
                text = call_tool(params["name"], params.get("arguments", {}))
            except InvalidParams as exc:
                return self._json(error(request_id, -32602, str(exc)))
            result = {"content": [{"type": "text", "text": text}]}
        else:
            return self._json(error(request_id, -32601, "Method not found"))
        return self._json({"jsonrpc": "2.0", "id": request_id, "result": result})

    def log_message(self, format, *args):
        sys.stderr.write("hello-mcp: %s\n" % (format % args))


def main():
    try:
        port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    except ValueError:
        raise SystemExit("usage: server.py [port]") from None
    if not 0 <= port <= 65535:
        raise SystemExit("port must be between 0 and 65535")
    host = os.environ.get("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"hello-mcp listening on http://{host}:{server.server_port}/mcp", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
