/// <reference types="@cloudflare/workers-types" />
//
// cli-call.ts — the hub's MCP client for POST /api/cli/call (`finch test` /
// `finch call`). The CLI sends one {service, method, params}; this module turns
// it into a real MCP exchange with the tenant's service over the relay and
// hands back ONE JSON-RPC response object, which is what every CLI version
// parses (`out.result` / `out.error`).
//
// Why a client and not a bare relay: standard Streamable-HTTP servers (the
// official Python/TS SDKs, FastMCP) refuse a lone tools/list — 406 without
// `Accept: application/json, text/event-stream`, 400 "Missing session ID"
// without an initialize handshake — and many answer in SSE framing even for a
// single response.
//
// The exchange:
//   1. POST initialize (protocolVersion 2025-11-25 in the body, and no
//      MCP-Protocol-Version header: the spec only asks for it after
//      initialization, the official clients leave it off, and servers that
//      check it on every POST — the Go SDK up to v1.1.0 knows nothing past
//      2025-06-18 — would refuse the handshake with a plain-text 400). Reply
//      is JSON or SSE; we keep Mcp-Session-Id and the negotiated
//      protocolVersion.
//   2. POST notifications/initialized.
//   3. POST the real request with the session id + MCP-Protocol-Version (and
//      Mcp-Method / Mcp-Name when the negotiated version is 2026-07-28+).
//   4. Best-effort DELETE of the session (405 and every other outcome ignored).
//      Once a session exists, steps 2-3 stop a little before the deadline so
//      the DELETE still fits inside it, even when the call itself times out.
// If initialize is refused the way a 2026-07-28-only server refuses it (405,
// or a modern JSON-RPC error such as -32022 UnsupportedProtocolVersion), the
// request is retried statelessly: `_meta` carries protocolVersion /
// clientInfo / clientCapabilities and the headers mirror the body, per the
// 2026-07-28 Streamable HTTP binding.
//
// Every read is bounded by a byte cap and one overall deadline, so a server
// that streams forever or never answers cannot hold the hub past the CLI's own
// 30 s client timeout.

/** The protocol revision we open legacy (initialize-based) sessions with. */
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";
/** The stateless revision we fall back to. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

const CLIENT_INFO = { name: "finch-cli", version: "1.0.0" };

/** Overall budget for the whole exchange. The CLI's HTTP client gives up at
 *  30 s, so the hub answers with a clear 504 before that. */
export const CLI_CALL_DEADLINE_MS = 25_000;
/** Cap on the bytes read from any single upstream response (JSON or SSE).
 *  Same ceiling as the relay's request-body cap (MAX_RELAY_BODY_BYTES). */
export const CLI_CALL_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** How long the best-effort session DELETE may take at most. Once a session
 *  exists, this much (or a tenth of a shorter deadline) is held back from the
 *  exchange so a timed-out call still closes its session. */
const DELETE_BUDGET_MS = 2_000;

/** One HTTP exchange with the service's MCP endpoint through the relay. The
 *  caller (api.ts) adds the relay URL and the first-party auth headers. */
export type McpSend = (init: {
  method: "POST" | "DELETE";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<Response>;

export interface CliCallOptions {
  deadlineMs?: number;
  maxResponseBytes?: number;
  /** Used in error messages only. */
  service?: string;
}

type Json = Record<string, any>;

interface Exchange {
  status: number;
  sessionId: string | null;
  /** The JSON-RPC response for our request id (or, on an error status, any
   *  JSON-RPC-shaped error body). */
  rpc?: Json;
  /** Raw body text of a non-2xx answer that was not JSON-RPC. */
  text?: string;
}

class CallTimeout extends Error {}
class TooLarge extends Error {}

/** Run one CLI call against the service and shape the answer for the CLI. */
export async function cliMcpCall(
  send: McpSend,
  rpcMethod: string,
  params: Json,
  opts: CliCallOptions = {},
): Promise<Response> {
  const budget = opts.deadlineMs ?? CLI_CALL_DEADLINE_MS;
  const end = Date.now() + budget;
  const client = new Client(send, {
    deadline: end,
    hardDeadline: end,
    deleteReserve: Math.min(DELETE_BUDGET_MS, Math.floor(budget / 10)),
    maxBytes: opts.maxResponseBytes ?? CLI_CALL_MAX_RESPONSE_BYTES,
  });
  const label = opts.service || "the service";
  try {
    return await client.run(rpcMethod, params);
  } catch (e) {
    if (e instanceof CallTimeout) {
      const secs = Math.round((opts.deadlineMs ?? CLI_CALL_DEADLINE_MS) / 1000);
      return jsonResponse(504, { error: `${label} did not answer ${rpcMethod} within ${secs}s` });
    }
    if (e instanceof TooLarge) {
      return jsonResponse(502, {
        error: `${label}'s answer to ${rpcMethod} exceeds ${opts.maxResponseBytes ?? CLI_CALL_MAX_RESPONSE_BYTES} bytes`,
      });
    }
    return jsonResponse(502, {
      error: `relay to ${label} failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

class Client {
  private nextId = 1;
  constructor(
    private send: McpSend,
    private limits: {
      /** When the current step gives up (CallTimeout). */
      deadline: number;
      /** The overall end of the exchange, the session DELETE included. */
      hardDeadline: number;
      /** Held back from the exchange for the DELETE once a session exists. */
      deleteReserve: number;
      maxBytes: number;
    },
  ) {}

  async run(rpcMethod: string, params: Json): Promise<Response> {
    // No MCP-Protocol-Version header here: the version is negotiated in the
    // body, and the header only follows once it is known (see the top).
    const init = await this.request(
      "initialize",
      {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      {},
    );

    if (isOk(init.status) && init.rpc && isObject(init.rpc.result)) {
      return this.runSession(init, rpcMethod, params);
    }

    if (looksModernOnly(init)) {
      const modern = await this.runStateless(rpcMethod, params);
      // A 4xx with no JSON-RPC body is not a modern answer; the initialize
      // failure is the more useful thing to show.
      if (modern.status >= 400 && modern.status < 500 && !modern.rpc) {
        return toCliResponse(init, "initialize");
      }
      return toCliResponse(modern, rpcMethod);
    }
    return toCliResponse(init, "initialize");
  }

  /** Legacy path: an initialize-based session (possibly without a session
   *  id, for stateless 2025-era servers). */
  private async runSession(init: Exchange, rpcMethod: string, params: Json): Promise<Response> {
    const negotiated =
      typeof init.rpc!.result.protocolVersion === "string" && init.rpc!.result.protocolVersion
        ? (init.rpc!.result.protocolVersion as string)
        : LEGACY_PROTOCOL_VERSION;
    const session: Record<string, string> = { "MCP-Protocol-Version": negotiated };
    if (init.sessionId) session["Mcp-Session-Id"] = init.sessionId;
    const modern = negotiated >= MODERN_PROTOCOL_VERSION;
    // There is a session to close now: keep time for its DELETE.
    if (init.sessionId) {
      this.limits.deadline = this.limits.hardDeadline - this.limits.deleteReserve;
    }

    try {
      await this.notify(
        "notifications/initialized",
        modern ? { ...session, "Mcp-Method": "notifications/initialized" } : session,
      );
      const res = await this.request(
        rpcMethod,
        params,
        modern ? { ...session, ...standardHeaders(rpcMethod, params) } : session,
        session,
      );
      return toCliResponse(res, rpcMethod);
    } finally {
      if (init.sessionId) await this.closeSession(session);
    }
  }

  /** 2026-07-28 path: per-request `_meta`, headers mirroring the body, no
   *  session. A tools/call refused with HeaderMismatch (-32020) is retried
   *  once with the Mcp-Param-* headers the tool's inputSchema asks for, as
   *  the spec's client behavior suggests. */
  private async runStateless(rpcMethod: string, params: Json): Promise<Exchange> {
    const res = await this.statelessRequest(rpcMethod, params, {});
    if (
      rpcMethod === "tools/call" &&
      res.status === 400 &&
      res.rpc?.error?.code === -32020 &&
      typeof params.name === "string"
    ) {
      const list = await this.statelessRequest("tools/list", {}, {});
      const tools = list.rpc?.result?.tools;
      const tool = Array.isArray(tools)
        ? tools.find((t: any) => isObject(t) && t.name === params.name)
        : undefined;
      const extra = tool ? paramHeaders(tool.inputSchema, params.arguments) : {};
      if (Object.keys(extra).length > 0) {
        return this.statelessRequest(rpcMethod, params, extra);
      }
    }
    return res;
  }

  private statelessRequest(rpcMethod: string, params: Json, extra: Record<string, string>) {
    const userMeta = isObject(params._meta) ? params._meta : {};
    const withMeta = {
      ...params,
      _meta: {
        ...userMeta,
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
    return this.request(rpcMethod, withMeta, {
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
      ...standardHeaders(rpcMethod, params),
      ...extra,
    });
  }

  /** POST a JSON-RPC request and read back its response (JSON or SSE).
   *  `replyHeaders` enables answering server->client requests that a legacy
   *  server interleaves on the SSE stream (ping gets {}, anything else
   *  -32601: we declared no client capabilities). */
  private async request(
    method: string,
    params: Json,
    headers: Record<string, string>,
    replyHeaders?: Record<string, string>,
  ): Promise<Exchange> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, headers);
    const sessionId = res.headers.get("mcp-session-id");
    const ctype = (res.headers.get("content-type") || "").toLowerCase();

    if (ctype.includes("text/event-stream") && res.body) {
      const rpc = await this.readSse(res.body, id, replyHeaders);
      return { status: res.status, sessionId, rpc };
    }
    const text = await this.readText(res.body);
    const parsed = parseJson(text);
    const rpc = pickResponse(parsed, id);
    return rpc
      ? { status: res.status, sessionId, rpc }
      : { status: res.status, sessionId, text };
  }

  /** POST a notification; the answer (202 by spec) is drained and ignored.
   *  A refusal here is not fatal: the real request that follows reports
   *  whatever is actually wrong. Only the deadline propagates. */
  private async notify(method: string, headers: Record<string, string>): Promise<void> {
    try {
      const res = await this.post({ jsonrpc: "2.0", method }, headers);
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      if (e instanceof CallTimeout) throw e;
    }
  }

  private async closeSession(session: Record<string, string>): Promise<void> {
    const remaining = this.limits.hardDeadline - Date.now();
    if (remaining <= 0) return;
    const ctl = new AbortController();
    try {
      const res = await withTimeout(
        this.send({ method: "DELETE", headers: { ...session }, signal: ctl.signal }),
        Math.min(remaining, DELETE_BUDGET_MS),
        () => ctl.abort(),
      );
      await res.body?.cancel().catch(() => {});
    } catch {
      // best effort: 405, timeouts and relay errors all leave the session to
      // the server's own expiry
    }
  }

  private async post(message: Json, headers: Record<string, string>): Promise<Response> {
    const ctl = new AbortController();
    return withTimeout(
      this.send({
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify(message),
        signal: ctl.signal,
      }),
      this.limits.deadline - Date.now(),
      () => ctl.abort(),
    );
  }

  private async readText(body: ReadableStream<Uint8Array> | null): Promise<string> {
    if (!body) return "";
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await this.read(reader);
        if (done) break;
        total += value.byteLength;
        if (total > this.limits.maxBytes) throw new TooLarge();
        chunks.push(value);
      }
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.byteLength;
    }
    return new TextDecoder().decode(all);
  }

  /** Read SSE events until the JSON-RPC response for `id` (then stop reading
   *  and cancel the stream). Notifications are skipped; server requests are
   *  answered when `replyHeaders` is given. Returns undefined if the stream
   *  ends without a matching response. */
  private async readSse(
    body: ReadableStream<Uint8Array>,
    id: number,
    replyHeaders?: Record<string, string>,
  ): Promise<Json | undefined> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    // The current, still unterminated line, kept as the decoded pieces it
    // arrived in. Each chunk is searched for terminators once and the pieces
    // are joined once per line, so a long line in small chunks stays linear
    // (growing one string and scanning it again per chunk is quadratic).
    let pending: string[] = [];
    // The last chunk ended in "\r", already taken as a line end: a "\n"
    // opening the next chunk is the rest of that "\r\n", not a blank line.
    let skipLF = false;
    let data: string[] = [];
    let total = 0;
    let found: Json | undefined;

    const dispatch = async (): Promise<void> => {
      if (data.length === 0) return;
      const payload = data.join("\n");
      data = [];
      const msg = parseJson(payload);
      if (!isObject(msg)) return;
      if (isResponseFor(msg, id)) {
        found = msg;
        return;
      }
      if (typeof msg.method === "string" && "id" in msg && msg.id !== null && replyHeaders) {
        await this.answerServerRequest(msg, replyHeaders);
      }
    };

    const onLine = async (line: string): Promise<void> => {
      if (line === "") return dispatch();
      if (line.startsWith(":")) return; // comment / keep-alive
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      // event / id / retry are irrelevant here: every event's data is JSON-RPC
    };

    const feed = async (text: string): Promise<void> => {
      if (text === "") return;
      let i = 0;
      if (skipLF) {
        skipLF = false;
        if (text.startsWith("\n")) i = 1;
      }
      const re = /\r\n|\n|\r/g;
      re.lastIndex = i;
      let m: RegExpExecArray | null;
      while (!found && (m = re.exec(text))) {
        const piece = text.slice(i, m.index);
        const line = pending.length ? pending.join("") + piece : piece;
        pending = [];
        i = m.index + m[0].length;
        if (m[0] === "\r" && i === text.length) skipLF = true;
        await onLine(line);
      }
      if (!found && i < text.length) pending.push(text.slice(i));
    };

    try {
      while (!found) {
        const { done, value } = await this.read(reader);
        if (done) {
          await feed(decoder.decode());
          if (!found && pending.length) await onLine(pending.join(""));
          if (!found) await dispatch();
          break;
        }
        total += value.byteLength;
        if (total > this.limits.maxBytes) throw new TooLarge();
        await feed(decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    }
    // Stop reading once we have our answer; the server SHOULD close anyway.
    await reader.cancel().catch(() => {});
    return found;
  }

  private async answerServerRequest(msg: Json, headers: Record<string, string>): Promise<void> {
    const reply =
      msg.method === "ping"
        ? { jsonrpc: "2.0", id: msg.id, result: {} }
        : {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `finch-cli does not support ${msg.method}` },
          };
    try {
      const res = await this.post(reply, headers);
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      if (e instanceof CallTimeout) throw e;
    }
  }

  private read(reader: ReadableStreamDefaultReader<Uint8Array>) {
    return withTimeout(reader.read(), this.limits.deadline - Date.now());
  }
}

/** Race `p` against the remaining budget; on timeout run `onTimeout` and
 *  throw CallTimeout. */
async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  if (ms <= 0) {
    onTimeout?.();
    p.catch(() => {});
    throw new CallTimeout();
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new CallTimeout());
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    p.catch(() => {});
  }
}

/** Modern-era refusal of initialize: the server speaks 2026-07-28 only.
 *  405 on the POST, or a JSON-RPC error that only a modern server sends for a
 *  well-formed initialize: the spec-reserved -32020..-32022, "method not
 *  found" (initialize does not exist any more), or -32602 on a 400 (the
 *  request lacks the required `_meta`). */
function looksModernOnly(x: Exchange): boolean {
  if (x.status === 405) return true;
  const code = x.rpc?.error?.code;
  if (typeof code !== "number") return false;
  if (code === -32020 || code === -32021 || code === -32022) return true;
  if (code === -32601) return true;
  if (code === -32602 && x.status === 400) return true;
  return false;
}

/** Mcp-Method always; Mcp-Name for the methods whose target the spec mirrors. */
function standardHeaders(rpcMethod: string, params: Json): Record<string, string> {
  const h: Record<string, string> = { "Mcp-Method": rpcMethod };
  const name =
    rpcMethod === "tools/call" || rpcMethod === "prompts/get"
      ? params.name
      : rpcMethod === "resources/read"
        ? params.uri
        : undefined;
  if (typeof name === "string") h["Mcp-Name"] = encodeHeaderValue(name);
  return h;
}

const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SENTINEL = /^=\?base64\?.*\?=$/s;

/** Plain value when it is header-safe ASCII without edge whitespace and does
 *  not look like the sentinel; otherwise =?base64?<utf-8 base64>?=. */
export function encodeHeaderValue(v: string): string {
  const safe = /^[\x20-\x7E\t]*$/.test(v) && v === v.trim() && !SENTINEL.test(v);
  if (safe) return v;
  const bytes = new TextEncoder().encode(v);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?base64?${btoa(bin)}?=`;
}

/** Mcp-Param-{Name} headers for the tool's `x-mcp-header` properties that are
 *  reachable through `properties` keys only, have a primitive type, and have
 *  a value in the arguments. Invalid annotations are skipped. */
export function paramHeaders(schema: unknown, args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  const walk = (node: unknown, value: unknown, depth: number) => {
    if (depth > 32 || !isObject(node) || !isObject(node.properties)) return;
    for (const [key, sub] of Object.entries(node.properties as Json)) {
      if (!isObject(sub)) continue;
      const v = isObject(value) ? (value as Json)[key] : undefined;
      const hname = sub["x-mcp-header"];
      if (typeof hname === "string" && HEADER_TOKEN.test(hname) && !seen.has(hname.toLowerCase())) {
        seen.add(hname.toLowerCase());
        let s: string | undefined;
        if (typeof v === "string") s = v;
        else if (typeof v === "boolean") s = v ? "true" : "false";
        else if (typeof v === "number" && Number.isSafeInteger(v)) s = String(v);
        if (s !== undefined) out[`Mcp-Param-${hname}`] = encodeHeaderValue(s);
      }
      walk(sub, v, depth + 1);
    }
  };
  walk(schema, args, 0);
  return out;
}

/** Shape one upstream exchange into what the CLI parses: 200 + the JSON-RPC
 *  response when the service answered; the service's own status otherwise
 *  (so the CLI can tell 401 / 404 / 5xx apart), with a JSON body whose
 *  `error` is either the JSON-RPC error object or a string. */
function toCliResponse(x: Exchange, step: string): Response {
  if (isOk(x.status)) {
    if (x.rpc) return jsonResponse(200, x.rpc);
    return jsonResponse(502, {
      error: `the service answered ${step} with HTTP ${x.status} but no JSON-RPC response`,
    });
  }
  if (x.rpc) return jsonResponse(x.status, x.rpc);
  const parsed = parseJson(x.text || "");
  if (isObject(parsed) && "error" in parsed) return jsonResponse(x.status, parsed);
  const text = (x.text || "").trim().slice(0, 2000);
  return jsonResponse(x.status, { error: text || `HTTP ${x.status}` });
}

function pickResponse(parsed: unknown, id: number): Json | undefined {
  if (Array.isArray(parsed)) {
    return parsed.find((m) => isObject(m) && isResponseFor(m, id)) as Json | undefined;
  }
  if (isObject(parsed) && ("result" in parsed || "error" in parsed)) return parsed;
  return undefined;
}

function isResponseFor(msg: Json, id: number): boolean {
  if (!("result" in msg || "error" in msg) || typeof msg.method === "string") return false;
  // An error the server could not tie to a request carries no id.
  if (msg.id === undefined || msg.id === null) return "error" in msg;
  return String(msg.id) === String(id);
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
