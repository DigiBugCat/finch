/// <reference types="@cloudflare/workers-types" />
//
// ApplianceDO — one Durable Object per finch MACHINE (keyed
// `${tenant}:${appliance}:${machine}`). It is the rendezvous point: the
// box-side agent dials OUT to /<appliance>/<machine>/_connect and parks a
// WebSocket here; public requests routed to this DO are relayed down that
// socket and the response is relayed back.
//
// Beyond relaying, it reports liveness to the tenant's TenantDO: on WS open it
// calls markMachine{connected:true}; on close/error markMachine{connected:false}
// so the appliance's online/offline state stays accurate. It learns its
// tenant/appliance/machine from query params on the _connect URL and stashes
// them via serializeAttachment so they survive hibernation (the close/error
// handlers fire on a possibly-evicted-and-revived object).
//
// Hibernation: we use the WebSocket Hibernation API (ctx.acceptWebSocket +
// webSocketMessage handler method, NOT addEventListener). That lets the runtime
// evict this object from memory while the socket sits idle, so an idle but
// connected appliance costs ~nothing. NAT keepalive is handled by WS-protocol
// pings via setWebSocketAutoResponse — those do NOT wake us (so they're free).
// Never keep a setInterval running here; it would pin us awake and bill.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import {
  type AgentFrame,
  type ReqFrame,
  type ResetFrame,
  decodeChunk,
} from "./relay-frames";

/** Identity stashed on the agent socket via serializeAttachment so the
 *  close/error handlers can reach the right TenantDO after hibernation. */
interface SockMeta {
  tenant: string;
  appliance: string;
  machine: string;
}

/** One in-flight relayed response, keyed by frame id. Created when the DO sends
 *  a `req` down the socket; lives until `end`/`err`/`reset` or socket death.
 *
 *  Lifecycle: the public fetch() awaits `head` (resolveHead). On `head` we hand
 *  back a streaming Response whose ReadableStream `start` captures `controller`;
 *  subsequent `chunk` frames enqueue base64-decoded bytes, `end` closes it,
 *  `err`/`reset` error it. The idle `timer` is armed on send and re-armed on
 *  every head/chunk for this id; on fire it 504s a head-less stream or errors a
 *  streaming one (and sends `reset` to the agent). */
interface Stream {
  /** ReadableStream controller, set once the head arrives and the body stream
   *  has been started. Undefined while we're still awaiting head. */
  controller?: ReadableStreamDefaultController<Uint8Array>;
  /** Resolves the fetch()'s await-first-frame promise with the agent's first
   *  frame (head or err). Cleared (set to undefined) once it has fired so a
   *  late frame can't double-resolve. */
  resolveHead?: (f: AgentFrame) => void;
  /** Idle-timeout handle (see RELAY_IDLE_MS). */
  timer: ReturnType<typeof setTimeout>;
  /** True once `head` (or `err`) has resolved the head promise — past this
   *  point we are committed to the stream body, not a fresh Response. */
  headSettled: boolean;
  /** Chunks that arrived after `head` but before start() captured the controller
   *  (a race the WS input gate normally prevents). start() flushes them, so a
   *  future regression can't silently truncate the body. */
  pending?: Uint8Array[];
  /** `end` won the same race — start() closes after flushing `pending`. */
  ended?: boolean;
}

// Per-stream idle timeout. Armed on `req` send, RESET on every head/chunk for
// that id. On fire: no head yet -> resolve 504; head already sent -> error the
// readable + send `reset` to the agent. This REPLACES the old 30s total cap —
// a long-running ("thinking") tool that keeps streaming never trips it; only a
// genuinely stalled link does.
const RELAY_IDLE_MS = 300_000;

// Max relay body we'll buffer (#16 / L9). Mirrors index.ts's pre-stub cap; we
// enforce by STRING LENGTH after req.text() because content-length is
// client-controlled and absent for chunked requests.
const MAX_RELAY_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB

// Hop-by-hop / recomputed headers we never re-emit from the upstream response.
// Everything else (notably Mcp-Session-Id) IS forwarded so stateful MCP works.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

export class ApplianceDO extends DurableObject<Env> {
  // In-flight relayed responses, keyed by frame id. In-memory only — but a
  // request in flight is "pending work" (the streaming Response is the DO's
  // return value and keeps us awake for the round-trip), so this survives the
  // relay. It's only ever empty when we hibernate (no streams open), so nothing
  // is lost. See the Stream interface for the per-id lifecycle.
  private streams = new Map<string, Stream>();

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // This DO is per-MACHINE, so the incoming path is
    // /<appliance>/<machine>/<rest>. Strip BOTH leading segments so the
    // upstream agent sees /_connect or /mcp — not /<appliance>/<machine>/mcp.
    const parts = url.pathname.split("/").filter(Boolean);
    const relPath = "/" + parts.slice(2).join("/") + (url.search || "");

    // ---- Agent registration: the box dials in here with a WS upgrade. ----
    if (relPath.startsWith("/_connect")) {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      // index.ts stamps tenant/appliance/machine onto the _connect URL.
      const meta: SockMeta = {
        tenant: url.searchParams.get("tenant") ?? "",
        appliance: url.searchParams.get("appliance") ?? "",
        machine: url.searchParams.get("machine") ?? "",
      };
      // SINGLE-AGENT: a machine has exactly one live agent socket. Evict any
      // prior "agent" sockets before accepting the new one (last-writer-wins) so
      // a reconnect — or a would-be second claimant — can't leave two sockets
      // racing in getWebSockets("agent")[0]. Close code 1012 ("superseded") is
      // recognized by webSocketClose, which then skips markMachine(false) so the
      // freshly-accepted socket's liveness doesn't flap offline.
      for (const old of this.ctx.getWebSockets("agent")) {
        try {
          old.close(1012, "superseded");
        } catch {
          /* already closing */
        }
      }
      const { 0: client, 1: server } = new WebSocketPair();
      // Hibernation-aware accept; tag it so getWebSockets("agent") finds it.
      this.ctx.acceptWebSocket(server, ["agent"]);
      // Persist identity so close/error handlers survive hibernation.
      server.serializeAttachment(meta);
      // Auto-pong NAT keepalives without waking the DO.
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong"),
      );
      // Tell the tenant this machine is live (fire-and-forget — don't block the
      // 101 on the control-plane write).
      this.ctx.waitUntil(this.markMachine(meta, true));
      return new Response(null, { status: 101, webSocket: client });
    }

    // ---- Public request: relay it to the connected agent. ----
    const agent = this.ctx.getWebSockets("agent")[0];
    if (!agent) {
      // No live agent socket for this machine — a stale pick. Tag the 503 with
      // X-Finch-Offline so the relay (which knows the tenant; the public relay
      // path doesn't carry it down to this DO) can fail over to a sibling AND
      // mark this machine offline so the next pick excludes it. (code-review #12)
      return json(
        503,
        { error: "appliance offline", id: parts[0] },
        { "X-Finch-Offline": "1" },
      );
    }

    const body = await req.text();
    if (body.length > MAX_RELAY_BODY_BYTES) {
      return json(413, { error: "request body too large" });
    }

    const id = crypto.randomUUID();
    const frame: ReqFrame = {
      id,
      type: "req",
      method: req.method,
      path: relPath,
      headers: Object.fromEntries(req.headers),
      body,
    };

    // Register the stream and arm the idle timer BEFORE sending, so a head/chunk
    // that lands synchronously (or a same-tick reset) finds its entry. Await the
    // FIRST frame for this id: `head` -> a streaming Response; `err` -> a plain
    // error Response; idle timeout with no head -> 504.
    const first = await new Promise<AgentFrame>((resolve) => {
      const timer = setTimeout(() => this.onIdle(id), RELAY_IDLE_MS);
      this.streams.set(id, { resolveHead: resolve, timer, headSettled: false });
      try {
        agent.send(JSON.stringify(frame));
      } catch (e) {
        // Couldn't even hand the request to the agent — fail this stream fast as
        // a 502 (BEFORE head, so index.ts may still fail over). Synthesize an
        // err frame and tear the entry down.
        this.settleHead(id, {
          id,
          type: "err",
          status: 502,
          message: `relay failed: ${e}`,
        });
      }
    });

    if (first.type === "err") {
      // Error before head. Return the message as a plain body with the agent's
      // status (502 dial fail / 403 SSRF). index.ts only fails over on a 503
      // X-Finch-Offline, so an err here is the box's real (terminal) answer.
      return new Response(first.message, { status: first.status });
    }
    if (first.type !== "head") {
      // Only head/err can settle the head promise; defensively 502 anything else.
      return new Response("relay protocol error", { status: 502 });
    }

    // head -> stream the body. Build the Response headers from the agent's
    // ORDERED [name,value] list (hop-by-hop already excluded agent-side; we keep
    // HOP_BY_HOP as defense-in-depth). headers.append PRESERVES DUPLICATES so
    // multiple Set-Cookie survive.
    const headers = new Headers();
    // `?? []` tolerates a head whose `headers` key is absent (the agent omits it
    // when no headers survive the hop-by-hop filter) — iterating undefined throws.
    for (const [k, v] of first.headers ?? []) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers.append(k, v);
    }

    // The ReadableStream is fed by chunk frames (base64-decoded) and closed on
    // end. Its `start` captures the controller into the live stream entry so
    // webSocketMessage can pump into it. If the stream entry is already gone
    // (e.g. a same-tick reset between head and here), close immediately.
    const self = this;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        const s = self.streams.get(id);
        if (!s) {
          controller.close();
          return;
        }
        s.controller = controller;
        // Flush any chunks that landed before we captured the controller, then
        // close if `end` already arrived during that window.
        if (s.pending) {
          for (const bytes of s.pending) {
            try {
              controller.enqueue(bytes);
            } catch {
              /* errored mid-flush */
            }
          }
          s.pending = undefined;
        }
        if (s.ended) {
          self.streams.delete(id);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        // The consumer (the downstream client) went away. Tear the stream down
        // and tell the agent to stop reading the upstream body into the void.
        self.resetStream(id, "client cancelled", true);
      },
    });

    return new Response(readable, { status: first.status, headers });
  }

  // Hibernatable handler — fires when the agent sends a frame down the socket:
  // head / chunk / end / err / reset, all keyed by the relayed request id.
  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
    let frame: AgentFrame;
    try {
      const text =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      frame = JSON.parse(text);
    } catch {
      return;
    }
    const s = this.streams.get(frame.id);
    if (!s) return; // unknown / already-torn-down id — ignore.

    switch (frame.type) {
      case "head":
        // First frame: re-arm idle, settle the awaiting fetch() with the head.
        this.rearm(s, frame.id);
        this.settleHead(frame.id, frame);
        return;
      case "err":
        // Error before head: settle the fetch() with the err (turns into a plain
        // error Response). If head was already sent this is a protocol violation
        // (agent must not err after head); treat it as a reset of the body.
        if (s.headSettled && s.controller) {
          this.resetStream(frame.id, frame.message, false);
        } else {
          this.rearm(s, frame.id);
          this.settleHead(frame.id, frame);
        }
        return;
      case "chunk": {
        this.rearm(s, frame.id);
        let bytes: Uint8Array;
        try {
          bytes = decodeChunk(frame.data);
        } catch {
          this.resetStream(frame.id, "bad chunk encoding", false);
          return;
        }
        if (s.controller) {
          try {
            s.controller.enqueue(bytes);
          } catch {
            // Controller already closed/errored — drop and tear down.
            this.resetStream(frame.id, "enqueue failed", false);
          }
        } else {
          // head settled but start() hasn't captured the controller yet — buffer
          // (the input gate normally prevents this; flushed in start()).
          (s.pending ??= []).push(bytes);
        }
        return;
      }
      case "end":
        // Upstream body fully read -> close the readable and retire the stream.
        clearTimeout(s.timer);
        if (s.controller) {
          this.streams.delete(frame.id);
          try {
            s.controller.close();
          } catch {
            /* already closed */
          }
        } else {
          // `end` won the race against start(): keep the entry so start() can
          // flush any buffered chunks and then close.
          s.ended = true;
        }
        return;
      case "reset":
        // Agent aborted its side. Error the readable (if streaming) or resolve
        // the pending head 502; do NOT echo a reset back (agent initiated it).
        this.resetStream(frame.id, frame.message ?? "stream reset", false);
        return;
    }
  }

  /** Settle the fetch()'s await-first-frame promise exactly once and mark the
   *  head as committed. Subsequent head/err for this id are ignored. */
  private settleHead(id: string, frame: AgentFrame): void {
    const s = this.streams.get(id);
    if (!s || !s.resolveHead) return;
    const resolve = s.resolveHead;
    s.resolveHead = undefined;
    s.headSettled = true;
    if (frame.type === "err") {
      // No body stream will follow — retire the entry now.
      clearTimeout(s.timer);
      this.streams.delete(id);
    }
    resolve(frame);
  }

  /** Re-arm the idle timer for a live stream (called on every head/chunk). */
  private rearm(s: Stream, id: string): void {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this.onIdle(id), RELAY_IDLE_MS);
  }

  /** Idle timeout fired for `id`: no traffic in RELAY_IDLE_MS. If we never got a
   *  head, resolve the fetch() 504; otherwise error the streaming body and tell
   *  the agent to abort (it may still be blocked reading a dead upstream). */
  private onIdle(id: string): void {
    const s = this.streams.get(id);
    if (!s) return;
    if (!s.headSettled) {
      this.settleHead(id, {
        id,
        type: "err",
        status: 504,
        message: "upstream timeout",
      });
      return;
    }
    this.resetStream(id, "idle timeout", true);
  }

  /** Tear down an in-flight stream: clear its timer, drop it from the map, error
   *  its readable (or resolve a still-pending head 502), and optionally send a
   *  `reset` to the agent so it stops reading the upstream into a dead socket. */
  private resetStream(id: string, message: string, notifyAgent: boolean): void {
    const s = this.streams.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    this.streams.delete(id);
    if (s.resolveHead) {
      // Head never arrived -> the fetch() is still awaiting; 502 it.
      const resolve = s.resolveHead;
      s.resolveHead = undefined;
      resolve({ id, type: "err", status: 502, message });
    } else if (s.controller) {
      try {
        s.controller.error(new Error(message));
      } catch {
        /* already closed/errored */
      }
    }
    if (notifyAgent) {
      const reset: ResetFrame = { id, type: "reset", message };
      const agent = this.ctx.getWebSockets("agent")[0];
      try {
        agent?.send(JSON.stringify(reset));
      } catch {
        /* socket gone — nothing to abort */
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // A dead link must NOT leave in-flight callers hanging — reset ALL in-flight
    // streams now (error their readables / resolve pending heads 502) so they
    // unblock immediately.
    this.resetAll("appliance link closed");
    // Code 1012 means we superseded this socket with a fresh agent connection
    // (single-agent eviction above). The newer socket is the live one, so do NOT
    // mark the machine offline — that would flap a connected machine to offline.
    const meta = ws.deserializeAttachment() as SockMeta | null;
    if (meta && code !== 1012) await this.markMachine(meta, false);
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    // Agent link errored — reset all in-flight streams fast and flag the machine
    // offline.
    this.resetAll("appliance link errored");
    const meta = ws.deserializeAttachment() as SockMeta | null;
    if (meta) await this.markMachine(meta, false);
  }

  /** Reset EVERY in-flight stream: error its readable (or resolve its pending
   *  head 502) and clear the map. Called on socket close/error so a dead link
   *  surfaces immediately. We do NOT notify the agent — the socket is gone. */
  private resetAll(reason: string): void {
    for (const id of [...this.streams.keys()]) {
      this.resetStream(id, reason, false);
    }
  }

  /** Report this machine's connected state to its tenant's TenantDO. Skipped if
   *  we don't have full identity (e.g. an old socket from before this field
   *  existed). Best-effort: never throws into the WS lifecycle. */
  private async markMachine(meta: SockMeta, connected: boolean): Promise<void> {
    if (!meta.tenant || !meta.appliance || !meta.machine) return;
    try {
      const stub = this.env.TENANT.get(
        this.env.TENANT.idFromName(meta.tenant),
      );
      await stub.fetch("https://tenant/op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "markMachine",
          appliance: meta.appliance,
          machine: meta.machine,
          connected,
        }),
      });
    } catch {
      /* control-plane write failed; liveness will reconcile on next event */
    }
  }
}

function json(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
  });
}
