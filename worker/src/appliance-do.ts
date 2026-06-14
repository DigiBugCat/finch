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

/** Identity stashed on the agent socket via serializeAttachment so the
 *  close/error handlers can reach the right TenantDO after hibernation. */
interface SockMeta {
  tenant: string;
  appliance: string;
  machine: string;
}

interface Frame {
  id: string;
  type: "req" | "res";
  // req
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  // res
  status?: number;
}

const REQUEST_TIMEOUT_MS = 30_000;

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
  // Public requests awaiting an agent response, keyed by frame id.
  // In-memory only — but a request in flight is "pending work" that keeps us
  // awake for the round-trip, so this survives the wait. It's only ever empty
  // when we hibernate (no requests pending), so nothing is lost.
  private pending = new Map<string, (f: Frame) => void>();

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

    // SSE is not yet supported end-to-end (the relay frames a single buffered
    // response; it can't stream a session-sticky event stream). Fail FAST with
    // 501 rather than hanging or silently dropping events. (code-review #10)
    if ((req.headers.get("accept") || "").includes("text/event-stream")) {
      return json(501, {
        error: "text/event-stream not supported by the relay yet",
      });
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
    const frame: Frame = {
      id,
      type: "req",
      method: req.method,
      path: relPath,
      headers: Object.fromEntries(req.headers),
      body,
    };

    const res = await new Promise<Frame>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ id, type: "res", status: 504, body: "upstream timeout" });
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, (f) => {
        clearTimeout(timer);
        resolve(f);
      });
      try {
        agent.send(JSON.stringify(frame));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ id, type: "res", status: 502, body: `relay failed: ${e}` });
      }
    });

    // Re-emit the FULL upstream header set (minus hop-by-hop / recomputed) so
    // stateful MCP works — the Mcp-Session-Id returned on `initialize` must reach
    // the caller or every follow-up call 4xx's. (code-review #10)
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers ?? {})) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
    }
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return new Response(res.body ?? "", {
      status: res.status ?? 502,
      headers,
    });
  }

  // Hibernatable handler — fires when the agent sends a frame (a response, or
  // later: server-initiated MCP messages for the bidirectional channel).
  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
    let frame: Frame;
    try {
      const text =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.type === "res") {
      const resolve = this.pending.get(frame.id);
      if (resolve) {
        this.pending.delete(frame.id);
        resolve(frame);
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // A dead link must NOT leave in-flight callers hanging on the 30s timeout —
    // drain pending now with a fast 502 so they unblock immediately. (#9)
    this.failPending("appliance link closed");
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
    // Agent link errored — fail in-flight requests fast instead of waiting out
    // the 30s timer, and flag the machine offline. (#9)
    this.failPending("appliance link errored");
    const meta = ws.deserializeAttachment() as SockMeta | null;
    if (meta) await this.markMachine(meta, false);
  }

  /** Resolve every in-flight pending request with a fast 502 and clear the map.
   *  Called on socket close/error so a dead link surfaces immediately rather
   *  than each caller waiting out REQUEST_TIMEOUT_MS. */
  private failPending(reason: string): void {
    for (const resolve of this.pending.values()) {
      resolve({ id: "", type: "res", status: 502, body: reason });
    }
    this.pending.clear();
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
