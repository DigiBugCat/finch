// POST /api/cli/call speaks real MCP (cli-call.ts). The fakes below mimic the
// servers `finch test` / `finch call` meet in the wild:
//   - pythonSdkServer: the official Python SDK's stateful Streamable HTTP —
//     406 without `Accept: application/json, text/event-stream`, 400 "Missing
//     session ID" before initialize, SSE-framed replies (CRLF, a priming event
//     with empty data, notifications and a server->client ping before the
//     response), session DELETE.
//   - jsonServer: a JSON-response server (FastMCP json_response) that hands
//     out a session id and answers DELETE with 405.
//   - modernServer: a 2026-07-28-only stateless server: no initialize, no
//     sessions, `_meta` + mirrored Mcp-* headers required, -32020 / -32022.
//   - goSdkServer: the Go SDK (v0.x - v1.1.0) streamable handler, which checks
//     MCP-Protocol-Version on EVERY POST, initialize included, against
//     2025-06-18 / 2025-03-26 / 2024-11-05 and refuses anything else with a
//     text/plain 400.
// Most tests drive cliMcpCall directly; the last block goes through the real
// worker route with a CLI token and a fake SELF binding.
import { describe, it, expect } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import { signAssertion, signToken, genJti } from "../src/auth";
import {
  cliMcpCall,
  encodeHeaderValue,
  paramHeaders,
  type McpSend,
} from "../src/cli-call";

type Json = Record<string, any>;
interface Seen {
  method: string;
  headers: Record<string, string>;
  body?: Json;
}

const SUPPORTED_LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"];
const TOOLS = [
  { name: "echo", description: "echo text", inputSchema: { type: "object" } },
  {
    name: "execute_sql",
    description: "run sql",
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "string", "x-mcp-header": "Region" },
        query: { type: "string" },
      },
    },
  },
  { name: "météo", description: "non-ascii name", inputSchema: { type: "object" } },
];

function headersOf(req: Request): Record<string, string> {
  const h: Record<string, string> = {};
  req.headers.forEach((v, k) => (h[k] = v));
  return h;
}

async function bodyOf(req: Request): Promise<Json | undefined> {
  const t = await req.text();
  return t ? JSON.parse(t) : undefined;
}

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sseEvent(msg: unknown, eol = "\r\n"): string {
  return `event: message${eol}data: ${JSON.stringify(msg)}${eol}${eol}`;
}

function callTool(msg: Json): Json {
  const { name, arguments: args } = msg.params;
  if (!TOOLS.some((t) => t.name === name)) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  return {
    jsonrpc: "2.0",
    id: msg.id,
    result: { content: [{ type: "text", text: `${name}:${JSON.stringify(args ?? {})}` }] },
  };
}

/** Behaves like the Python SDK's stateful StreamableHTTPServerTransport. */
function pythonSdkServer() {
  const seen: Seen[] = [];
  const sessions = new Set<string>();
  const deleted: string[] = [];
  let pingReply: (() => void) | null = null;
  let pinged = false;

  const handle = async (req: Request): Promise<Response> => {
    const headers = headersOf(req);
    if (req.method === "DELETE") {
      seen.push({ method: "DELETE", headers });
      const sid = headers["mcp-session-id"];
      if (!sid) return jsonRes(400, { error: "Bad Request: Missing session ID" });
      sessions.delete(sid);
      deleted.push(sid);
      return new Response(null, { status: 200 });
    }
    const accept = headers["accept"] || "";
    const body = await bodyOf(req);
    seen.push({ method: "POST", headers, body });
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      return jsonRes(406, {
        jsonrpc: "2.0",
        id: "server-error",
        error: {
          code: -32600,
          message: "Not Acceptable: Client must accept both application/json and text/event-stream",
        },
      });
    }
    if (!(headers["content-type"] || "").includes("application/json")) {
      return jsonRes(415, { error: "Unsupported Media Type" });
    }
    if (body?.method === "initialize") {
      const sid = `sid-${crypto.randomUUID()}`;
      sessions.add(sid);
      const res = {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-06-18", // negotiates down from our 2025-11-25
          capabilities: { tools: {} },
          serverInfo: { name: "py", version: "1" },
        },
      };
      return new Response(`id: 0\r\ndata: \r\n\r\n${sseEvent(res)}`, {
        status: 200,
        headers: { "content-type": "text/event-stream", "mcp-session-id": sid },
      });
    }
    const sid = headers["mcp-session-id"];
    if (!sid) return jsonRes(400, { error: "Bad Request: Missing session ID" });
    if (!sessions.has(sid)) return jsonRes(404, { error: "Not Found: Session not found" });
    const pv = headers["mcp-protocol-version"];
    if (pv && !SUPPORTED_LEGACY.includes(pv)) {
      return jsonRes(400, { error: `Bad Request: Unsupported protocol version: ${pv}` });
    }
    if (body && !("id" in body)) return new Response(null, { status: 202 }); // notification
    if (body && "result" in body && body.id === "srv-ping-1") {
      pingReply?.();
      return new Response(null, { status: 202 });
    }
    // A request: open an SSE stream with notifications (and, once, a ping the
    // client must answer) before the response.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    (async () => {
      await w.write(enc.encode(": keep-alive\r\n\r\n"));
      await w.write(
        enc.encode(
          sseEvent({
            jsonrpc: "2.0",
            method: "notifications/message",
            params: { level: "info", data: "working" },
          }),
        ),
      );
      if (!pinged) {
        pinged = true;
        const answered = new Promise<void>((r) => (pingReply = r));
        await w.write(enc.encode(sseEvent({ jsonrpc: "2.0", id: "srv-ping-1", method: "ping" })));
        await answered;
      }
      const res =
        body!.method === "tools/list"
          ? { jsonrpc: "2.0", id: body!.id, result: { tools: TOOLS } }
          : body!.method === "tools/call"
            ? callTool(body!)
            : { jsonrpc: "2.0", id: body!.id, error: { code: -32601, message: "Method not found" } };
      // Split one event across writes to exercise chunk reassembly.
      const ev = sseEvent(res);
      await w.write(enc.encode(ev.slice(0, 17)));
      await w.write(enc.encode(ev.slice(17)));
      await w.close();
    })();
    return new Response(readable, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { handle, seen, sessions, deleted };
}

/** A JSON-response server with a session id and no DELETE support. */
function jsonServer() {
  const seen: Seen[] = [];
  const handle = async (req: Request): Promise<Response> => {
    const headers = headersOf(req);
    if (req.method === "DELETE") {
      seen.push({ method: "DELETE", headers });
      return new Response("Method Not Allowed", { status: 405 });
    }
    const body = await bodyOf(req);
    seen.push({ method: "POST", headers, body });
    if (!(headers["accept"] || "").includes("application/json")) {
      return jsonRes(406, { error: "Not Acceptable" });
    }
    if (body?.method === "initialize") {
      return jsonRes(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: body.params.protocolVersion, capabilities: {}, serverInfo: { name: "j", version: "1" } },
        },
        { "mcp-session-id": "json-session" },
      );
    }
    if (headers["mcp-session-id"] !== "json-session") {
      return jsonRes(400, { error: "Bad Request: Missing session ID" });
    }
    if (!("id" in body!)) return new Response(null, { status: 202 });
    if (body!.method === "tools/list") return jsonRes(200, { jsonrpc: "2.0", id: body!.id, result: { tools: TOOLS } });
    if (body!.method === "tools/call") return jsonRes(200, callTool(body!));
    return jsonRes(200, { jsonrpc: "2.0", id: body!.id, error: { code: -32601, message: "Method not found" } });
  };
  return { handle, seen };
}

function decodeHeader(v: string | undefined): string | undefined {
  const m = v?.match(/^=\?base64\?(.*)\?=$/s);
  if (!m) return v;
  const bin = atob(m[1]);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** A 2026-07-28-only stateless server. `initialize405` makes it answer the
 *  handshake POST with a bare 405 instead of -32022. */
function modernServer(opts: { initialize405?: boolean } = {}) {
  const seen: Seen[] = [];
  const err = (status: number, id: unknown, code: number, message: string, data?: unknown) =>
    jsonRes(status, { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
  const handle = async (req: Request): Promise<Response> => {
    const headers = headersOf(req);
    if (req.method !== "POST") {
      seen.push({ method: req.method, headers });
      return new Response(null, { status: 405 });
    }
    const body = (await bodyOf(req))!;
    seen.push({ method: "POST", headers, body });
    if (opts.initialize405 && body.method === "initialize") {
      return new Response(null, { status: 405 });
    }
    const accept = headers["accept"] || "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      return new Response(null, { status: 406 });
    }
    const pv = headers["mcp-protocol-version"];
    if (pv !== "2026-07-28") {
      return err(400, body.id, -32022, "Unsupported protocol version", {
        supported: ["2026-07-28"],
        requested: pv,
      });
    }
    if (headers["mcp-method"] !== body.method) return err(400, body.id, -32020, "Mcp-Method mismatch");
    const meta = body.params?._meta ?? {};
    if (meta["io.modelcontextprotocol/protocolVersion"] !== pv || !meta["io.modelcontextprotocol/clientCapabilities"]) {
      return err(400, body.id, -32602, "missing _meta");
    }
    if (body.method === "tools/list") {
      return jsonRes(200, { jsonrpc: "2.0", id: body.id, result: { resultType: "complete", tools: TOOLS } });
    }
    if (body.method === "tools/call") {
      if (decodeHeader(headers["mcp-name"]) !== body.params.name) {
        return err(400, body.id, -32020, "Mcp-Name mismatch");
      }
      if (body.params.name === "execute_sql" && headers["mcp-param-region"] !== body.params.arguments?.region) {
        return err(400, body.id, -32020, "Mcp-Param-Region missing or mismatched");
      }
      return new Response(sseEvent({ ...callTool(body), result: { resultType: "complete", ...callTool(body).result } }, "\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return err(404, body.id, -32601, "Method not found");
  };
  return { handle, seen };
}

/** Mirrors go-sdk v0.8.0 mcp/streamable.go ServeHTTP: a missing header counts
 *  as 2025-03-26; an unknown one is http.Error(400) before the body is read. */
function goSdkServer() {
  const seen: Seen[] = [];
  const supported = ["2025-06-18", "2025-03-26", "2024-11-05"];
  const handle = async (req: Request): Promise<Response> => {
    const headers = headersOf(req);
    if (req.method === "DELETE") {
      seen.push({ method: "DELETE", headers });
      return new Response(null, { status: 204 });
    }
    const body = await bodyOf(req);
    seen.push({ method: "POST", headers, body });
    const pv = headers["mcp-protocol-version"] || "2025-03-26";
    if (!supported.includes(pv)) {
      return new Response(
        `Bad Request: Unsupported protocol version (supported versions: ${supported.join(",")})\n`,
        { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    if (body?.method === "initialize") {
      const res = {
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "go", version: "0.8.0" } },
      };
      return new Response(sseEvent(res, "\n"), {
        headers: { "content-type": "text/event-stream", "mcp-session-id": "go-session" },
      });
    }
    if (headers["mcp-session-id"] !== "go-session") return new Response("session not found", { status: 404 });
    if (!("id" in body!)) return new Response(null, { status: 202 });
    const res =
      body!.method === "tools/list"
        ? { jsonrpc: "2.0", id: body!.id, result: { tools: TOOLS } }
        : callTool(body!);
    return new Response(sseEvent(res, "\n"), { headers: { "content-type": "text/event-stream" } });
  };
  return { handle, seen };
}

/** A text/event-stream answer that reaches the reader in exactly
 *  `size`-byte chunks. A plain object rather than a Response: wrapping the
 *  stream in a workerd Response would coalesce the chunks. */
function chunkedSse(text: string, size: number): Response {
  const bytes = new TextEncoder().encode(text);
  let off = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (off >= bytes.length) return ctl.close();
      ctl.enqueue(bytes.slice(off, off + size));
      off += size;
    },
  });
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body,
  } as unknown as Response;
}

/** Adapt a Request handler into the McpSend cli-call uses. */
function sender(handle: (r: Request) => Promise<Response>): McpSend {
  return (init) =>
    handle(
      new Request("https://hub.test/svc/mcp", {
        method: init.method,
        headers: init.headers,
        body: init.body,
      }),
    );
}

async function run(
  handle: (r: Request) => Promise<Response>,
  method: string,
  params: Json = {},
  opts = {},
) {
  const res = await cliMcpCall(sender(handle), method, params, { service: "svc", ...opts });
  return { status: res.status, body: (await res.json()) as Json };
}

const posts = (seen: Seen[]) => seen.filter((s) => s.method === "POST");

describe("cli call: Python-SDK-like stateful server", () => {
  it("rejects the old bare one-shot request, as the real SDK does", async () => {
    const py = pythonSdkServer();
    const bare = await py.handle(
      new Request("https://hub.test/svc/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    expect(bare.status).toBe(406);
    const noSession = await py.handle(
      new Request("https://hub.test/svc/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    expect(noSession.status).toBe(400);
    expect(await noSession.text()).toContain("Missing session ID");
  });

  it("tools/list: handshake, SSE parse, ping answered, session deleted", async () => {
    const py = pythonSdkServer();
    const { status, body } = await run(py.handle, "tools/list");
    expect(status).toBe(200);
    expect(body.result.tools.map((t: Json) => t.name)).toEqual(["echo", "execute_sql", "météo"]);

    const p = posts(py.seen);
    expect(p.map((s) => s.body?.method ?? `reply:${s.body?.id}`)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "reply:srv-ping-1",
    ]);
    const init = p[0];
    expect(init.headers["accept"]).toBe("application/json, text/event-stream");
    // The version is offered in the body; the header only follows once it
    // is negotiated.
    expect(init.headers["mcp-protocol-version"]).toBeUndefined();
    expect(init.body!.params).toEqual({
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "finch-cli", version: "1.0.0" },
    });
    const sid = p[1].headers["mcp-session-id"];
    expect(sid).toMatch(/^sid-/);
    // Subsequent requests carry the session and the NEGOTIATED version, and no
    // 2026-07-28 mirror headers (the session is legacy).
    for (const s of p.slice(1)) {
      expect(s.headers["mcp-session-id"]).toBe(sid);
      expect(s.headers["mcp-protocol-version"]).toBe("2025-06-18");
    }
    expect(p[2].headers["mcp-method"]).toBeUndefined();
    expect(p[3].body).toEqual({ jsonrpc: "2.0", id: "srv-ping-1", result: {} });
    expect(py.deleted).toEqual([sid]);
  });

  it("tools/call returns the tool's result in the shape the CLI prints", async () => {
    const py = pythonSdkServer();
    const { status, body } = await run(py.handle, "tools/call", {
      name: "echo",
      arguments: { text: "hi" },
    });
    expect(status).toBe(200);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.result.content[0]).toEqual({ type: "text", text: 'echo:{"text":"hi"}' });
  });

  it("a JSON-RPC error from the tool comes back as 200 + error (CLI shows the message)", async () => {
    const py = pythonSdkServer();
    const { status, body } = await run(py.handle, "tools/call", { name: "nope", arguments: {} });
    expect(status).toBe(200);
    expect(body.error).toEqual({ code: -32602, message: "Unknown tool: nope" });
    expect(body.result).toBeUndefined();
  });
});

describe("cli call: Go-SDK-like server (checks MCP-Protocol-Version on initialize too)", () => {
  it("handshakes without the header, then carries the negotiated 2025-06-18", async () => {
    const go = goSdkServer();
    const { status, body } = await run(go.handle, "tools/call", { name: "echo", arguments: { q: 1 } });
    expect(status).toBe(200);
    expect(body.result.content[0].text).toBe('echo:{"q":1}');
    const methods = go.seen.map((s) => (s.method === "DELETE" ? "DELETE" : s.body!.method));
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "DELETE"]);
    expect(go.seen[0].headers["mcp-protocol-version"]).toBeUndefined();
    for (const s of go.seen.slice(1)) {
      expect(s.headers["mcp-protocol-version"]).toBe("2025-06-18");
      expect(s.headers["mcp-session-id"]).toBe("go-session");
    }
  });

  it("the fake refuses a 2025-11-25 header on initialize, as go-sdk v0.8.0 does", async () => {
    const go = goSdkServer();
    const res = await go.handle(
      new Request("https://hub.test/svc/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unsupported protocol version");
  });
});

describe("cli call: JSON-response server", () => {
  it("works over plain JSON and ignores 405 on the session DELETE", async () => {
    const js = jsonServer();
    const { status, body } = await run(js.handle, "tools/call", {
      name: "echo",
      arguments: { a: 1 },
    });
    expect(status).toBe(200);
    expect(body.result.content[0].text).toBe('echo:{"a":1}');
    const methods = js.seen.map((s) => (s.method === "DELETE" ? "DELETE" : s.body!.method));
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "DELETE"]);
    expect(js.seen[2].headers["mcp-protocol-version"]).toBe("2025-11-25");
    expect(js.seen[3].headers["mcp-session-id"]).toBe("json-session");
  });

  it("a server with no session id gets no DELETE", async () => {
    const seen: string[] = [];
    const handle = async (req: Request) => {
      if (req.method === "DELETE") {
        seen.push("DELETE");
        return new Response(null, { status: 405 });
      }
      const b = (await bodyOf(req))!;
      seen.push(b.method);
      if (!("id" in b)) return new Response(null, { status: 202 });
      if (b.method === "initialize") {
        return jsonRes(200, { jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-03-26", capabilities: {} } });
      }
      return jsonRes(200, { jsonrpc: "2.0", id: b.id, result: { tools: [] } });
    };
    const { status, body } = await run(handle, "tools/list");
    expect(status).toBe(200);
    expect(body.result.tools).toEqual([]);
    expect(seen).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });
});

describe("cli call: 2026-07-28 stateless fallback", () => {
  it("falls back after -32022 on initialize and sends _meta + mirrored headers", async () => {
    const m = modernServer();
    const { status, body } = await run(m.handle, "tools/list");
    expect(status).toBe(200);
    expect(body.result.tools).toHaveLength(3);
    const p = posts(m.seen);
    expect(p.map((s) => s.body!.method)).toEqual(["initialize", "tools/list"]);
    const call = p[1];
    expect(call.headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(call.headers["mcp-method"]).toBe("tools/list");
    expect(call.headers["mcp-session-id"]).toBeUndefined();
    expect(call.body!.params._meta).toEqual({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "finch-cli", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    });
    // No session was opened, so nothing is torn down.
    expect(m.seen.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("falls back after a 405 on the initialize POST", async () => {
    const m = modernServer({ initialize405: true });
    const { status, body } = await run(m.handle, "tools/call", {
      name: "echo",
      arguments: { x: "y" },
    });
    expect(status).toBe(200);
    expect(body.result.content[0].text).toBe('echo:{"x":"y"}');
    expect(posts(m.seen)[1].headers["mcp-name"]).toBe("echo");
  });

  it("tools/call with an x-mcp-header parameter: HeaderMismatch -> tools/list -> retry with Mcp-Param-*", async () => {
    const m = modernServer();
    const { status, body } = await run(m.handle, "tools/call", {
      name: "execute_sql",
      arguments: { region: "us-west1", query: "select 1" },
    });
    expect(status).toBe(200);
    expect(body.result.content[0].text).toContain("execute_sql");
    const p = posts(m.seen);
    expect(p.map((s) => s.body!.method)).toEqual(["initialize", "tools/call", "tools/list", "tools/call"]);
    expect(p[3].headers["mcp-param-region"]).toBe("us-west1");
    expect(p[3].headers["mcp-name"]).toBe("execute_sql");
  });

  it("base64-encodes a non-ASCII tool name in Mcp-Name", async () => {
    const m = modernServer();
    const { status, body } = await run(m.handle, "tools/call", { name: "météo", arguments: {} });
    expect(status).toBe(200);
    expect(body.result.content[0].text).toBe("météo:{}");
    expect(posts(m.seen)[1].headers["mcp-name"]).toMatch(/^=\?base64\?.+\?=$/);
  });

  it("a modern error on the real request is surfaced, not masked by the initialize failure", async () => {
    const m = modernServer();
    const { status, body } = await run(m.handle, "resources/list");
    expect(status).toBe(404);
    expect(body.error.code).toBe(-32601);
  });
});

describe("cli call: failures keep the status the CLI classifies on", () => {
  it("a service that wants its own credentials: 401 passes through", async () => {
    const handle = async () => new Response("Unauthorized", { status: 401 });
    const { status, body } = await run(handle, "tools/list");
    expect(status).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });
  });

  it("the relay's own JSON error (service offline) passes through", async () => {
    const handle = async () => jsonRes(503, { error: "service offline" });
    const { status, body } = await run(handle, "tools/list");
    expect(status).toBe(503);
    expect(body).toEqual({ error: "service offline" });
  });

  it("a legacy server that rejects initialize with -32000 is not retried statelessly", async () => {
    let n = 0;
    const handle = async () => {
      n++;
      return jsonRes(400, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: nope" } });
    };
    const { status, body } = await run(handle, "tools/list");
    expect(n).toBe(1);
    expect(status).toBe(400);
    expect(body.error.message).toBe("Bad Request: nope");
  });

  it("an SSE stream that never answers is cut off at the deadline (504)", async () => {
    let deletes = 0;
    const handle = async (req: Request) => {
      if (req.method === "DELETE") {
        deletes++;
        return new Response(null, { status: 200 });
      }
      const b = (await bodyOf(req))!;
      if (b.method === "initialize") {
        return jsonRes(200, { jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-11-25", capabilities: {} } }, { "mcp-session-id": "s1" });
      }
      if (!("id" in b)) return new Response(null, { status: 202 });
      const { readable, writable } = new TransformStream();
      const w = writable.getWriter();
      w.write(new TextEncoder().encode(": still thinking\n\n"));
      return new Response(readable, { headers: { "content-type": "text/event-stream" } });
    };
    const started = Date.now();
    const { status, body } = await run(handle, "tools/list", {}, { deadlineMs: 150 });
    expect(status).toBe(504);
    expect(body.error).toMatch(/did not answer tools\/list/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Time was held back from the call, so the session is still closed.
    expect(deletes).toBe(1);
  });

  it("an SSE line split between \\r and \\n across chunks is still one terminator", async () => {
    const handle = async (req: Request) => {
      const b = (await bodyOf(req))!;
      if (b.method === "initialize") {
        return jsonRes(200, { jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      }
      if (!("id" in b)) return new Response(null, { status: 202 });
      // 1-byte chunks: every "\r" arrives alone, its "\n" in the next chunk.
      return chunkedSse(
        `: hi\r\n\r\n${sseEvent({ jsonrpc: "2.0", method: "notifications/message", params: {} })}` +
          sseEvent({ jsonrpc: "2.0", id: b.id, result: { tools: [{ name: "a\rb" }] } }),
        1,
      );
    };
    const { status, body } = await run(handle, "tools/list");
    expect(status).toBe(200);
    expect(body.result.tools[0].name).toBe("a\rb");
  });

  it("a long unterminated SSE line in small chunks is scanned once, not per chunk", async () => {
    const handle = async (req: Request) => {
      const b = (await bodyOf(req))!;
      if (b.method === "initialize") {
        return jsonRes(200, { jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      }
      if (!("id" in b)) return new Response(null, { status: 202 });
      return chunkedSse("x".repeat(4 * 1024 * 1024 + 64), 64);
    };
    // 4 MiB (the cap) in 64-byte chunks. Growing one buffer string and
    // regex-scanning it per chunk flattens and rescans it every time: ~12 s
    // of CPU here under workerd, against ~0.3 s for the linear splitter.
    const started = Date.now();
    const { status, body } = await run(handle, "tools/list", {}, { maxResponseBytes: 4 * 1024 * 1024 });
    expect(status).toBe(502);
    expect(body.error).toMatch(/exceeds 4194304 bytes/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("a response over the byte cap is refused (502)", async () => {
    const handle = async (req: Request) => {
      const b = (await bodyOf(req))!;
      const pad = "x".repeat(2048);
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { pad } })}\n\n`.repeat(4) +
          sseEvent({ jsonrpc: "2.0", id: b.id, result: {} }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const { status, body } = await run(handle, "tools/list", {}, { maxResponseBytes: 4096 });
    expect(status).toBe(502);
    expect(body.error).toMatch(/exceeds 4096 bytes/);
  });

  it("a 2xx without any JSON-RPC response is a 502, not an empty success", async () => {
    const handle = async (req: Request) => {
      const b = (await bodyOf(req))!;
      if (b.method === "initialize") {
        return jsonRes(200, { jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      }
      return new Response(null, { status: 202 });
    };
    const { status, body } = await run(handle, "tools/list");
    expect(status).toBe(502);
    expect(body.error).toMatch(/no JSON-RPC response/);
  });
});

describe("header helpers", () => {
  it("encodeHeaderValue follows the 2026-07-28 value-encoding table", () => {
    expect(encodeHeaderValue("us-west1")).toBe("us-west1");
    expect(encodeHeaderValue("Hello, 世界")).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
    expect(encodeHeaderValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
    expect(encodeHeaderValue("line1\nline2")).toBe("=?base64?bGluZTEKbGluZTI=?=");
    expect(encodeHeaderValue("=?base64?literal?=")).toBe("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
  });

  it("paramHeaders reads only statically reachable primitive annotations", () => {
    const schema = {
      type: "object",
      properties: {
        region: { type: "string", "x-mcp-header": "Region" },
        n: { type: "integer", "x-mcp-header": "N" },
        flag: { type: "boolean", "x-mcp-header": "Flag" },
        absent: { type: "string", "x-mcp-header": "Absent" },
        nested: { type: "object", properties: { zone: { type: "string", "x-mcp-header": "Zone" } } },
        bad: { type: "string", "x-mcp-header": "Bad Name" },
        list: { type: "array", items: { type: "string", "x-mcp-header": "Item" } },
      },
    };
    expect(
      paramHeaders(schema, {
        region: "eu",
        n: 42,
        flag: false,
        nested: { zone: "b" },
        bad: "x",
        list: ["a"],
      }),
    ).toEqual({
      "Mcp-Param-Region": "eu",
      "Mcp-Param-N": "42",
      "Mcp-Param-Flag": "false",
      "Mcp-Param-Zone": "b",
    });
  });
});

// ---- Through the real worker route: CLI token -> /api/cli/call -> SELF ----

const SERVICE = env.FINCH_SERVICE_SECRET;
const TENANT = env.DEFAULT_TENANT!;
const HOST = "hub.test";

async function cliToken(): Promise<string> {
  const epochRes = await env.TENANT.get(env.TENANT.idFromName(TENANT)).fetch("https://tenant/op", {
    method: "POST",
    body: JSON.stringify({ op: "cliEpoch" }),
  });
  const { epoch } = (await epochRes.json()) as { epoch: number };
  return signAssertion(
    { tenant: TENANT, exp: Math.floor(Date.now() / 1000) + 300, kind: "cli", epoch },
    SERVICE,
  );
}

async function viaRoute(handle: (r: Request) => Promise<Response>, body: unknown) {
  const urls: string[] = [];
  const authed: boolean[] = [];
  const SELF = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as any, init);
      urls.push(req.url);
      authed.push(req.headers.get("x-finch-service") === SERVICE && !!req.headers.get("x-finch-auth"));
      return handle(req);
    },
  };
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://${HOST}/api/cli/call`, {
      method: "POST",
      headers: {
        host: HOST,
        authorization: `Bearer ${await cliToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { ...env, SELF } as any,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, urls, authed };
}

const unused = async () => new Response("unexpected", { status: 500 });

describe("POST /api/cli/call route", () => {
  it("runs the MCP exchange over SELF, pinned to one box, with first-party auth", async () => {
    const { service, boxes, agents } = await bridgedService(unused, 2);
    const py = pythonSdkServer();
    const { res, urls, authed } = await viaRoute(py.handle, { service, method: "tools/list" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const out = (await res.json()) as Json;
    expect(out.result.tools).toHaveLength(3);
    // Every request of the exchange goes to the SAME box's pinned path, so a
    // stateful server's session id is valid on each of them.
    expect(urls.length).toBe(5); // initialize, initialized, tools/list, ping reply, DELETE
    expect(new Set(urls).size).toBe(1);
    expect(boxes.map((b) => `https://${HOST}/${service}/${b}/mcp`)).toContain(urls[0]);
    expect(authed.every(Boolean)).toBe(true);
    agents.forEach((a) => a.close(1000, "done"));
  });

  it("a stale box pick (X-Finch-Offline 503) moves on to the next healthy box, then sticks", async () => {
    const { service, boxes, agents } = await bridgedService(unused, 2);
    const py = pythonSdkServer();
    let offlineBox = "";
    const { res, urls } = await viaRoute(
      async (req) => {
        const box = decodeURIComponent(new URL(req.url).pathname.split("/")[2]);
        if (!offlineBox) offlineBox = box;
        if (box === offlineBox) {
          return jsonRes(503, { error: "service offline" }, { "X-Finch-Offline": "1" });
        }
        return py.handle(req);
      },
      { service, method: "tools/list" },
    );
    expect(res.status).toBe(200);
    const other = boxes.find((b) => b !== offlineBox)!;
    expect(urls[0]).toContain(`/${offlineBox}/mcp`);
    expect(urls.slice(1).every((u) => u.endsWith(`/${other}/mcp`))).toBe(true);
    agents.forEach((a) => a.close(1000, "done"));
  });

  it("an unknown service is a 404 before anything is relayed", async () => {
    const { res, urls } = await viaRoute(unused, { service: "no-such-svc", method: "tools/list" });
    expect(res.status).toBe(404);
    expect(urls).toHaveLength(0);
  });

  it("rejects non-object params and missing fields", async () => {
    const a = await viaRoute(unused, { service: "printer", method: "tools/call", params: [1] });
    expect(a.res.status).toBe(400);
    expect(a.urls).toHaveLength(0);
    const b = await viaRoute(unused, { service: "printer" });
    expect(b.res.status).toBe(400);
  });
});

// ---- End to end: CLI route -> SELF (the real worker) -> relayMcp -> BoxDO ->
//      a fake agent socket that bridges each relayed request to the Python-SDK
//      fake. Proves the session id header and the SSE body survive the relay
//      in both directions. ----

async function hubApi(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    "X-Finch-Service": SERVICE,
    "X-Finch-Auth": await signAssertion(
      { tenant: TENANT, exp: Math.floor(Date.now() / 1000) + 300 },
      SERVICE,
    ),
    host: HOST,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://${HOST}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env as any,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Enroll a service with `n` approved, live boxes. Box i's fake agent answers
 *  every relayed request by calling `handlers[i]` (or the single handler) and
 *  streaming the Response back as head/chunk/end frames. */
async function bridgedService(
  handlers: ((r: Request) => Promise<Response>) | Array<(r: Request) => Promise<Response>>,
  n = Array.isArray(handlers) ? handlers.length : 1,
) {
  const handlerFor = (i: number) => (Array.isArray(handlers) ? handlers[i] : handlers);
  const enroll = (await (
    await hubApi("POST", "/api/enroll", { name: `cli call ${Date.now()}` })
  ).json()) as { id: string; ticket: string };
  const boxes: string[] = [];
  const agents: WebSocket[] = [];
  const frames: Array<{ box: string; method: string; path: string; headers: Record<string, string> }> = [];
  const ctx = createExecutionContext();
  for (let i = 0; i < n; i++) {
    const box = `box-${crypto.randomUUID().slice(0, 8)}`;
    const handle = handlerFor(i);
    const joinRes = await worker.fetch(
      new Request(`http://${HOST}/join`, {
        method: "POST",
        headers: { "content-type": "application/json", host: HOST },
        body: JSON.stringify({
          // Tickets are single-use: every box after the first gets a fresh
          // one for the same service, as a second `finch join` would.
          ticket:
            i === 0
              ? enroll.ticket
              : await signToken(
                  {
                    tenant: TENANT,
                    service: enroll.id,
                    exp: Math.floor(Date.now() / 1000) + 600,
                    kind: "join",
                    jti: genJti(),
                  },
                  env.TICKET_SECRET,
                ),
          box,
          os: "linux",
          version: "1.6.0",
        }),
      }),
      env as any,
      ctx,
    );
    expect(joinRes.status).toBe(200);
    const join = (await joinRes.json()) as { connectToken: string };
    const connectRes = await worker.fetch(
      new Request(
        `http://${HOST}/${enroll.id}/${box}/_connect?ct=${encodeURIComponent(join.connectToken)}`,
        { headers: { Upgrade: "websocket", host: HOST } },
      ),
      env as any,
      ctx,
    );
    expect(connectRes.status).toBe(101);
    const agent = connectRes.webSocket!;
    agent.accept();
    agent.addEventListener("message", (ev: MessageEvent) => {
      const f = JSON.parse(ev.data as string);
      if (f.type !== "req") return;
      frames.push({ box, method: f.method, path: f.path, headers: f.headers });
      (async () => {
        const res = await handle(
          new Request(`http://upstream${f.path}`, {
            method: f.method,
            headers: f.headers,
            body: f.method === "GET" || f.method === "HEAD" || !f.body ? undefined : f.body,
          }),
        );
        const hs: Array<[string, string]> = [];
        res.headers.forEach((v, k) => hs.push([k, v]));
        agent.send(JSON.stringify({ id: f.id, type: "head", status: res.status, headers: hs }));
        if (res.body) {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            agent.send(JSON.stringify({ id: f.id, type: "chunk", data: b64(value) }));
          }
        }
        agent.send(JSON.stringify({ id: f.id, type: "end" }));
      })();
    });
    boxes.push(box);
    agents.push(agent);
  }
  expect((await hubApi("POST", `/api/services/${enroll.id}/approve`)).status).toBe(200);
  let live = false;
  for (let i = 0; i < 50 && !live; i++) {
    const state = (await (await hubApi("GET", "/api/state")).json()) as any;
    const svc = state.services?.find((a: any) => a.id === enroll.id);
    live = boxes.every((b) => {
      const m = svc?.boxes?.find((x: any) => x.name === b);
      return !!m?.connected && m.state !== "pending";
    });
    if (!live) await new Promise((r) => setTimeout(r, 0));
  }
  expect(live).toBe(true);
  return { service: enroll.id, boxes, agents, frames };
}

describe("POST /api/cli/call end to end through the relay", () => {
  it("stateful Python-SDK-style servers on two boxes: the session stays on its box", async () => {
    // Each box runs its OWN stateful server, so a session id minted on one box
    // is unknown (404) on the other: only a pinned exchange can pass.
    const servers = [pythonSdkServer(), pythonSdkServer()];
    const { service, agents, frames } = await bridgedService(servers.map((s) => s.handle));
    const SELF = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        worker.fetch(new Request(input as any, init), env as any, createExecutionContext()),
    };
    for (let round = 0; round < 4; round++) {
      frames.length = 0;
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`http://${HOST}/api/cli/call`, {
          method: "POST",
          headers: {
            host: HOST,
            authorization: `Bearer ${await cliToken()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            service,
            method: "tools/call",
            params: { name: "echo", arguments: { via: "relay" } },
          }),
        }),
        { ...env, SELF } as any,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      const out = (await res.json()) as Json;
      expect(out.result.content[0].text).toBe('echo:{"via":"relay"}');
      // Handshake, call, ping reply and DELETE all reached one box at /mcp,
      // and the session id came back through the relay's response head.
      const methods = frames.map((f) => f.method);
      // (each fake pings only on its first request, hence 3 or 4 POSTs)
      expect([3, 4]).toContain(methods.filter((m) => m === "POST").length);
      expect(methods[methods.length - 1]).toBe("DELETE");
      expect(new Set(frames.map((f) => f.box)).size).toBe(1);
      expect(frames.every((f) => f.path === "/mcp")).toBe(true);
      expect(frames[2].headers["mcp-session-id"]).toMatch(/^sid-/);
      // First-party relay credentials never reach the box.
      for (const f of frames) {
        expect(f.headers["x-finch-service"]).toBeUndefined();
        expect(f.headers["x-finch-auth"]).toBeUndefined();
      }
    }
    // Every session opened was closed on the box that opened it.
    expect(servers.flatMap((s) => s.deleted)).toHaveLength(4);
    expect(servers.every((s) => s.sessions.size === 0)).toBe(true);
    agents.forEach((a) => a.close(1000, "done"));
  });
});
