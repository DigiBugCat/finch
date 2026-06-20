#!/usr/bin/env python3
"""hello-mcp — a tiny, dependency-free MCP server to test finch end to end.

It speaks just enough of MCP's Streamable-HTTP transport (POST /mcp with JSON-RPC)
to handshake and serve a handful of real tools. No pip install — just:

    python3 server.py            # serves on http://127.0.0.1:8000

then expose it with finch (see README.md):

    finch login --hub https://finchmcp.com <token>
    finch add hello --service http://127.0.0.1:8000 --name "Hello MCP"
    finch run

Tools: echo, add, now, roll.
"""
import datetime
import json
import random
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL = "2025-06-18"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

# ---- the tools this server exposes -----------------------------------------
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
        "description": "Add two numbers.",
        "inputSchema": {
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
            "required": ["a", "b"],
        },
    },
    {
        "name": "now",
        "description": "Return the current server time (ISO 8601).",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "roll",
        "description": "Roll an N-sided die (default 6).",
        "inputSchema": {
            "type": "object",
            "properties": {"sides": {"type": "integer"}},
        },
    },
]


def call_tool(name, args):
    """Run a tool, return its text result."""
    if name == "echo":
        return f"you said: {args.get('text', '')}"
    if name == "add":
        return f"{args.get('a', 0)} + {args.get('b', 0)} = {args.get('a', 0) + args.get('b', 0)}"
    if name == "now":
        return datetime.datetime.now().isoformat(timespec="seconds")
    if name == "roll":
        sides = int(args.get("sides", 6))
        return f"🎲 rolled a {random.randint(1, max(1, sides))} (d{sides})"
    raise KeyError(name)


# ---- the MCP/JSON-RPC plumbing (you'd normally use a real SDK like FastMCP) -
class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # simple health check
        self._json({"ok": True, "server": "hello-mcp", "tools": [t["name"] for t in TOOLS]})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json({"error": "bad json"}, 400)

        method, rid = req.get("method"), req.get("id")

        if method == "initialize":
            return self._json({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": PROTOCOL,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "hello-mcp", "version": "1.0.0"},
            }})
        if method == "notifications/initialized":
            self.send_response(202)
            self.end_headers()
            return
        if method == "tools/list":
            return self._json({"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}})
        if method == "tools/call":
            params = req.get("params") or {}
            try:
                text = call_tool(params.get("name"), params.get("arguments") or {})
            except KeyError as e:
                return self._json({"jsonrpc": "2.0", "id": rid,
                                   "error": {"code": -32602, "message": f"unknown tool {e}"}})
            return self._json({"jsonrpc": "2.0", "id": rid,
                               "result": {"content": [{"type": "text", "text": text}]}})
        return self._json({"jsonrpc": "2.0", "id": rid,
                           "error": {"code": -32601, "message": f"unknown method {method}"}})

    def log_message(self, fmt, *args):  # one tidy line per request
        sys.stderr.write("hello-mcp: %s\n" % (fmt % args))


if __name__ == "__main__":
    print(f"hello-mcp listening on http://127.0.0.1:{PORT}  (tools: echo, add, now, roll)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
