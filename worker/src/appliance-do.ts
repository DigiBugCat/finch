/// <reference types="@cloudflare/workers-types" />
//
// ApplianceDO — one Durable Object per finch appliance. It is the rendezvous
// point: the box-side agent dials OUT to /{id}/_connect and parks a WebSocket
// here; public requests routed to this DO are relayed down that socket and the
// response is relayed back.
//
// Hibernation: we use the WebSocket Hibernation API (ctx.acceptWebSocket +
// webSocketMessage handler method, NOT addEventListener). That lets the runtime
// evict this object from memory while the socket sits idle, so an idle but
// connected appliance costs ~nothing. NAT keepalive is handled by WS-protocol
// pings via setWebSocketAutoResponse — those do NOT wake us (so they're free).
// Never keep a setInterval running here; it would pin us awake and bill.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

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

export class ApplianceDO extends DurableObject<Env> {
  // Public requests awaiting an agent response, keyed by frame id.
  // In-memory only — but a request in flight is "pending work" that keeps us
  // awake for the round-trip, so this survives the wait. It's only ever empty
  // when we hibernate (no requests pending), so nothing is lost.
  private pending = new Map<string, (f: Frame) => void>();

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Path relative to the appliance: strip the leading /{id} segment so the
    // upstream MCP server sees /mcp, not /{id}/mcp.
    const parts = url.pathname.split("/").filter(Boolean);
    const relPath = "/" + parts.slice(1).join("/") + (url.search || "");

    // ---- Agent registration: the box dials in here with a WS upgrade. ----
    if (relPath.startsWith("/_connect")) {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      // Hibernation-aware accept; tag it so getWebSockets("agent") finds it.
      this.ctx.acceptWebSocket(server, ["agent"]);
      // Auto-pong NAT keepalives without waking the DO.
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong"),
      );
      return new Response(null, { status: 101, webSocket: client });
    }

    // ---- Public request: relay it to the connected agent. ----
    const agent = this.ctx.getWebSockets("agent")[0];
    if (!agent) {
      return json(503, { error: "appliance offline", id: parts[0] });
    }

    const id = crypto.randomUUID();
    const frame: Frame = {
      id,
      type: "req",
      method: req.method,
      path: relPath,
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
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

    return new Response(res.body ?? "", {
      status: res.status ?? 502,
      headers: {
        "content-type": res.headers?.["content-type"] ?? "application/json",
      },
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
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  async webSocketError(_ws: WebSocket, _error: unknown) {
    // Agent link errored; pending requests will time out and 504.
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
