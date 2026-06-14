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
    // Agent link errored; pending requests will time out and 504. Also flag the
    // machine offline so the appliance state stops claiming it's chirping.
    const meta = ws.deserializeAttachment() as SockMeta | null;
    if (meta) await this.markMachine(meta, false);
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
