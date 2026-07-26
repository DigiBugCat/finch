import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import vectors from "./relay-vectors.json";
import {
  MAX_PENDING_RELAY_BODY_BYTES,
  MAX_RELAY_BODY_BYTES,
  MAX_STREAMS_PER_BOX,
  RELAY_HEAD_TIMEOUT_MS,
  RELAY_IDLE_MS,
  RELAY_STREAM_HARD_CAP_BYTES,
} from "../src/box-do";

// The BOX binding's stub type (DurableObjectStub<undefined> in this
// config). runInDurableObject hands the callback the real BoxDO instance;
// we type those callbacks `any` since we reach into private methods (onIdle)
// that the public class type doesn't expose.
type Stub = ReturnType<typeof env.BOX.get>;

// DO STREAMING INTEGRATION (vitest-pool-workers, real BoxDO inside workerd).
//
// We drive the genuine BoxDO streaming pump end-to-end over a REAL
// WebSocket pair, exactly as production does:
//   1. Open a WS to the DO's /_connect to register the agent side. The DO accepts
//      `server` (getWebSockets("agent")[0]) and hands us back `client` — the
//      agent's writing end.
//   2. stub.fetch(relayReq) on the public relay path. The DO sends a `req` frame
//      DOWN to us (we read it off `client` to learn the per-relay id), then parks
//      its fetch() awaiting our `head`.
//   3. We reply over `client` with head -> chunk* -> end (or err / silence). The
//      runtime delivers each as a webSocketMessage to the DO — the same path
//      workerd uses for a real agent — so there is NO input-gate re-entrancy.
//   4. Assert the Response: status+headers FIRST (head), the body reassembles
//      from the chunks, dupe set-cookie survive, and the err / idle / reset
//      paths produce the right Response.
//
// Driving frames by directly calling instance.webSocketMessage() while fetch()
// is parked deadlocks on the DO input gate (and can't learn the random req id),
// so we go through the socket. Idle-timeout cases use runInDurableObject to fire
// the private idle handler deterministically without a 5-minute real wait.

let seq = 0;
function freshBox() {
  return {
    tenant: "org_relay",
    service: "scraper",
    box: `box_${Date.now()}_${seq++}`,
  };
}

function stubFor(m: { tenant: string; service: string; box: string }) {
  const name = `${m.tenant}:${m.service}:${m.box}`;
  return env.BOX.get(env.BOX.idFromName(name));
}

/** Per-box relay URL the public path forwards. The DO strips the two leading
 *  /<service>/<box> segments to derive the upstream path. */
function relayUrl(
  m: { service: string; box: string },
  rest = "mcp",
): string {
  return `https://hub/${m.service}/${encodeURIComponent(m.box)}/${rest}`;
}

/** Register a fake agent over a real WS upgrade to the DO's _connect. index.ts
 *  verifies the per-box connect token and then proves provenance to the DO with
 *  X-Finch-Service; the DO fails closed without it, so a request the public
 *  relay forwarded can never claim the agent socket. Returns the agent's client
 *  end. */
async function connectAgent(
  stub: Stub,
  m: { tenant: string; service: string; box: string },
): Promise<WebSocket> {
  const url =
    `https://hub/${m.service}/${encodeURIComponent(m.box)}/_connect` +
    `?tenant=${m.tenant}&service=${m.service}&box=${encodeURIComponent(m.box)}`;
  const res = await stub.fetch(url, {
    headers: {
      Upgrade: "websocket",
      "X-Finch-Service": env.FINCH_SERVICE_SECRET,
    },
  });
  expect(res.status).toBe(101);
  const client = res.webSocket!;
  client.accept();
  return client;
}

/** Read the next text message off a socket (the relayed `req` frame, or any
 *  DO->agent frame like `reset`). */
function nextFrame(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (ev: MessageEvent) => resolve(JSON.parse(ev.data as string)),
      { once: true },
    );
  });
}

/** Resolve with the first frame off `ws` that satisfies `pred`. Frames that
 *  don't match are dropped. Used to wait for a specific DO->agent control frame
 *  (e.g. a {type:"window",credits:0}) while ignoring interleaved noise. The
 *  listener is removed once it fires. */
function waitForFrame(
  ws: WebSocket,
  pred: (f: any) => boolean,
): Promise<any> {
  return new Promise((resolve) => {
    const onMsg = (ev: MessageEvent) => {
      const f = JSON.parse(ev.data as string);
      if (pred(f)) {
        ws.removeEventListener("message", onMsg as EventListener);
        resolve(f);
      }
    };
    ws.addEventListener("message", onMsg as EventListener);
  });
}

const fixture = (name: string) =>
  (vectors.frames as Record<string, { wire: any }>)[name].wire;

/** Re-key a fixture frame onto the live relay id the DO allocated. */
function withId(frame: any, id: string) {
  return { ...frame, id };
}

/** Fire the DO's PRIVATE idle handler for a relay id deterministically, instead
 *  of waiting out RELAY_IDLE_MS (300s). runInDurableObject hands us the live
 *  BoxDO instance; onIdle is private, so we reach it via `any`. The stub is
 *  cast to sidestep the binding's `DurableObjectStub<undefined>` generic (which
 *  trips TS2589 deep-instantiation on runInDurableObject's `O extends DO`). */
// runInDurableObject's generic (`O extends DurableObject`) trips TS2589
// deep-instantiation against the binding's DurableObjectStub<undefined>. We only
// need to reach the live instance's private onIdle, so call it through a loosely
// typed alias.
const runInDO = runInDurableObject as unknown as (
  stub: Stub,
  cb: (instance: any) => unknown,
) => Promise<unknown>;

async function fireIdle(stub: Stub, id: string): Promise<void> {
  await runInDO(stub, (instance) => instance.onIdle(id));
}

async function streamCount(stub: Stub): Promise<number> {
  return await runInDO(stub, (instance) => instance.streams.size) as number;
}

/** Drain a Response body that is EXPECTED to be errored mid-stream, returning
 *  the rejection. We read through res.body's reader (not res.text()) so the
 *  rejection handler attaches to the actual stream instance and we never leave a
 *  dangling unhandled rejection — the relay errors the readable via
 *  controller.error(). Returns the caught Error (or null if it closed cleanly). */
async function drainExpectingError(res: Response): Promise<Error | null> {
  const reader = res.body!.getReader();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done } = await reader.read();
      if (done) return null;
    }
  } catch (e) {
    return e as Error;
  } finally {
    reader.releaseLock();
  }
}

describe("BoxDO streaming relay — head + chunks + end", () => {
  it("streams status+headers FIRST, then reassembles the body to 'hello world'", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    // Fire the relay; capture the req frame the DO sends down to learn its id.
    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      }),
    );

    const req = await reqSeen;
    expect(req.type).toBe("req");
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/mcp");
    expect(req.body).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    const id: string = req.id;

    // Reply head -> chunk -> chunk -> end, re-keyed onto the live id.
    agent.send(JSON.stringify(withId(fixture("head"), id)));
    agent.send(JSON.stringify(withId(fixture("chunk_hello"), id)));
    agent.send(JSON.stringify(withId(fixture("chunk_world"), id)));
    agent.send(JSON.stringify(withId(fixture("end"), id)));

    const res = await resPromise;
    // Head landed first: status + ordered headers, hop-by-hop absent.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("mcp-session-id")).toBe("sess-abc");
    // Both Set-Cookie survived as distinct entries, in order. getSetCookie() is
    // a real workerd Headers method (not yet in this @cloudflare/workers-types).
    const setCookies = (
      res.headers as Headers & { getSetCookie(): string[] }
    ).getSetCookie();
    expect(setCookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    // Body reassembles from the two base64 chunks.
    expect(await res.text()).toBe("hello world");
  });

  it("keeps request/response payloads transient and persists socket identity only", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);
    const requestMarker = `PRIVATE_REQUEST_${crypto.randomUUID()}`;
    const responseMarker = `PRIVATE_RESPONSE_${crypto.randomUUID()}`;

    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: requestMarker }),
    );
    const req = await reqSeen;
    expect(req.body).toBe(requestMarker);

    agent.send(JSON.stringify({ id: req.id, type: "head", status: 200 }));
    agent.send(
      JSON.stringify({
        id: req.id,
        type: "chunk",
        data: btoa(responseMarker),
      }),
    );
    agent.send(JSON.stringify({ id: req.id, type: "end" }));
    expect(await (await resPromise).text()).toBe(responseMarker);

    const snapshot = await runInDO(stub, async (instance) => {
      const sockets = instance.ctx.getWebSockets("agent");
      const stored = await instance.ctx.storage.list();
      return {
        streamCount: instance.streams.size,
        attachment: sockets[0]?.deserializeAttachment(),
        storageKeys: [...stored.keys()],
      };
    }) as any;
    expect(snapshot.streamCount).toBe(0);
    expect(snapshot.attachment).toEqual({
      tenant: m.tenant,
      service: m.service,
      box: m.box,
    });
    expect(snapshot.storageKeys).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain(requestMarker);
    expect(JSON.stringify(snapshot)).not.toContain(responseMarker);
  });

  it("excludes hop-by-hop headers the agent (defensively) re-sent in head", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    const { id } = await reqSeen;

    // A head that (wrongly) re-includes content-length/connection must still be
    // filtered by the DO's HOP_BY_HOP defense-in-depth.
    agent.send(
      JSON.stringify({
        id,
        type: "head",
        status: 200,
        headers: [
          ["content-type", "application/json"],
          ["content-length", "5"],
          ["connection", "keep-alive"],
        ],
      }),
    );
    agent.send(JSON.stringify({ id, type: "chunk", data: "aGVsbG8=" }));
    agent.send(JSON.stringify({ id, type: "end" }));

    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.text()).toBe("hello");
  });

  it("tolerates a head with the `headers` key absent (no forwardable headers)", async () => {
    // When every upstream header is hop-by-hop, the agent emits a head with no
    // `headers` key; the DO must not crash iterating `undefined`. (review: major)
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    const { id } = await reqSeen;

    // Note: no `headers` key at all on the head frame.
    agent.send(JSON.stringify({ id, type: "head", status: 200 }));
    agent.send(JSON.stringify({ id, type: "chunk", data: "aGVsbG8=" }));
    agent.send(JSON.stringify({ id, type: "end" }));

    const res = await resPromise;
    expect(res.status).toBe(200);
    expect([...res.headers.keys()]).not.toContain("set-cookie");
    expect(await res.text()).toBe("hello");
  });
});

describe("BoxDO adversarial protocol boundaries", () => {
  it.each([
    ["end before head", (id: string) => ({ id, type: "end" })],
    ["chunk before head", (id: string) => ({ id, type: "chunk", data: "YQ==" })],
    ["invalid status", (id: string) => ({ id, type: "head", status: 99, headers: [] })],
    ["malformed headers", (id: string) => ({ id, type: "head", status: 200, headers: [null] })],
    ["invalid error", (id: string) => ({ id, type: "err", status: 200, message: "wrong" })],
    ["invalid reset", (id: string) => ({ id, type: "reset", message: 42 })],
    ["non-string type", (id: string) => ({ id, type: 42 })],
    ["unknown type", (id: string) => ({ id, type: "surprise" })],
  ])("turns %s into a controlled 502, resets agent work, and releases the slot", async (_name, makeFrame) => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);
    const seen = nextFrame(agent);
    const response = stub.fetch(new Request(relayUrl(m), { method: "POST", body: "x" }));
    const { id } = await seen;
    const resetSeen = waitForFrame(
      agent,
      (frame) => frame.type === "reset" && frame.id === id,
    );
    agent.send(JSON.stringify(makeFrame(id)));
    expect((await response).status).toBe(502);
    expect(await resetSeen).toMatchObject({ id, type: "reset" });
    expect(await streamCount(stub)).toBe(0);
  });

  it("ignores primitive JSON without poisoning a following valid frame", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);
    const seen = nextFrame(agent);
    const response = stub.fetch(new Request(relayUrl(m), { method: "POST", body: "x" }));
    const { id } = await seen;
    for (const value of ["null", "[]", "42", '"text"']) agent.send(value);
    agent.send(JSON.stringify({ id, type: "head", status: 200, headers: [] }));
    agent.send(JSON.stringify({ id, type: "end" }));
    expect(await (await response).text()).toBe("");
    expect(await streamCount(stub)).toBe(0);
  });

  it.each([204, 205, 304])("returns bodyless status %i without throwing or leaking", async (status) => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);
    const seen = nextFrame(agent);
    const response = stub.fetch(new Request(relayUrl(m), { method: "GET" }));
    const { id } = await seen;
    agent.send(JSON.stringify({ id, type: "head", status, headers: [] }));
    const res = await response;
    expect(res.status).toBe(status);
    expect(res.body).toBeNull();
    expect(await streamCount(stub)).toBe(0);
  });

  it("cleans stale-owned work without letting that generation abort replacement work", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const original = await connectAgent(stub, m);
    const staleReqSeen = nextFrame(original);
    const staleResponse = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "stale" }),
    );
    await staleReqSeen;
    // Preserve the actual accepted server socket before replacement. The prior
    // regression fabricated an unrelated WebSocketPair, which could not prove
    // generation ownership across the real last-writer-wins path.
    await runInDO(stub, (instance) => {
      instance.testSupersededAgent = instance.currentAgent;
    });
    const replacement = await connectAgent(stub, m);
    const seen = nextFrame(replacement);
    const response = stub.fetch(new Request(relayUrl(m), { method: "POST", body: "x" }));
    const { id } = await seen;
    await runInDO(stub, async (instance) => {
      const stale = instance.testSupersededAgent;
      expect(stale).toBeDefined();
      expect(stale).not.toBe(instance.currentAgent);
      await instance.webSocketClose(stale, 1012, "superseded");
      await instance.webSocketError(stale, new Error("late stale error"));
      delete instance.testSupersededAgent;
    });
    expect((await staleResponse).status).toBe(502);
    replacement.send(JSON.stringify({ id, type: "head", status: 200, headers: [] }));
    replacement.send(JSON.stringify({ id, type: "chunk", data: "b2s=" }));
    replacement.send(JSON.stringify({ id, type: "end" }));
    expect(await (await response).text()).toBe("ok");
  });

  it("dispatches a slow request body through the replacement socket generation", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    await connectAgent(stub, m);
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode("x"));
      },
    });
    const response = stub.fetch(new Request(relayUrl(m), { method: "POST", body }));
    for (let i = 0; i < 100; i++) {
      const pending = await runInDO(
        stub,
        (instance) => instance.pendingBodyReads,
      ) as number;
      if (pending === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await runInDO(stub, (instance) => instance.pendingBodyReads)).toBe(1);

    const replacement = await connectAgent(stub, m);
    const replacementReqSeen = nextFrame(replacement);
    bodyController.close();
    const replacementReq = await replacementReqSeen;
    expect(replacementReq).toMatchObject({ type: "req", body: "x" });
    replacement.send(JSON.stringify({
      id: replacementReq.id,
      type: "err",
      status: 502,
      message: "generation observed",
    }));
    expect((await response).status).toBe(502);
  });

  it("marks the current agent offline even when it closes with code 1012", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    await connectAgent(stub, m);
    const transitions = await runInDO(stub, async (instance) => {
      const seen: boolean[] = [];
      instance.markBox = async (_meta: unknown, connected: boolean) => {
        seen.push(connected);
      };
      await instance.webSocketClose(instance.currentAgent, 1012, "peer restart");
      return seen;
    }) as boolean[];
    expect(transitions).toEqual([false]);
  });

  it("maps a current-socket send failure to the load-balancer offline contract", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    await connectAgent(stub, m);
    // Workerd does not expose a deterministic way to force send() itself to
    // throw before its close callback runs. Substitute only the current
    // generation's transport operation so this exact catch path is stable.
    await runInDO(stub, (instance) => {
      instance.currentAgent = {
        readyState: 1,
        send() { throw new Error("transport already gone"); },
        close() {},
      };
    });

    const res = await stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Finch-Offline")).toBe("1");
    expect(await res.json()).toEqual({ error: "service offline", id: m.service });
    expect(await streamCount(stub)).toBe(0);
  });

  it("enforces the relay request cap on UTF-8 bytes, not UTF-16 code units", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    await connectAgent(stub, m);
    const multibyte = "💥".repeat(1_048_577); // >4 MiB UTF-8, ~2 Mi JS code units
    const res = await stub.fetch(new Request(relayUrl(m), { method: "POST", body: multibyte }));
    expect(res.status).toBe(413);
    expect(await streamCount(stub)).toBe(0);
    const invalid = await stub.fetch(new Request(relayUrl(m), {
      method: "POST",
      body: new Uint8Array([0xc3, 0x28]),
    }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "relay request body must be valid UTF-8" });
  });

  it("accepts the exact body limit and rejects an over-limit stream before EOF", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    const exactSeen = nextFrame(agent);
    const exactResponse = stub.fetch(new Request(relayUrl(m), {
      method: "POST",
      body: new Uint8Array(MAX_RELAY_BODY_BYTES).fill(0x61),
    }));
    const exact = await exactSeen;
    expect(exact.body).toHaveLength(MAX_RELAY_BODY_BYTES);
    agent.send(JSON.stringify({
      id: exact.id,
      type: "err",
      status: 502,
      message: "boundary observed",
    }));
    expect((await exactResponse).status).toBe(502);

    const neverEnding = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RELAY_BODY_BYTES + 1));
      },
    });
    const over = await stub.fetch(new Request(relayUrl(m), {
      method: "POST",
      body: neverEnding,
    }));
    expect(over.status).toBe(413);
    expect(await streamCount(stub)).toBe(0);
  });
});

describe("BoxDO streaming relay — err before head", () => {
  it("turns an err frame into a plain Response with the agent's status (502)", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    const { id } = await reqSeen;

    agent.send(
      JSON.stringify({
        id,
        type: "err",
        status: 502,
        message: "dial tcp 127.0.0.1:8000: connect: connection refused",
      }),
    );

    const res = await resPromise;
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(
      "dial tcp 127.0.0.1:8000: connect: connection refused",
    );
  });

  it("turns an SSRF-reject err (403) into a 403 Response", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    const { id } = await reqSeen;

    agent.send(
      JSON.stringify({ id, type: "err", status: 403, message: "SSRF blocked" }),
    );

    const res = await resPromise;
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("SSRF blocked");
  });
});

describe("BoxDO streaming relay — idle timeout", () => {
  it("504s a head-less stream when the idle timer fires before any head", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    const { id } = await reqSeen;

    // No head will arrive. Fire the idle handler deterministically (rather than
    // waiting out RELAY_IDLE_MS) — it must resolve the parked fetch() with a 504
    // because the head never settled.
    await fireIdle(stub, id);

    const res = await resPromise;
    expect(res.status).toBe(504);
    expect(await res.text()).toBe("upstream timeout");
  });

  it("errors the body stream (and resets the agent) when idle fires AFTER head", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    const { id } = await reqSeen;

    // Head + one chunk, then the agent stalls (no end).
    agent.send(
      JSON.stringify({
        id,
        type: "head",
        status: 200,
        headers: [["content-type", "text/event-stream"]],
      }),
    );
    agent.send(JSON.stringify({ id, type: "chunk", data: "aGVsbG8=" }));

    const res = await resPromise;
    expect(res.status).toBe(200);

    // The DO must send a `reset` DOWN to the agent on idle-after-head.
    const resetSeen = nextFrame(agent);
    // Begin draining, then fire idle: the reader should REJECT once the
    // controller is errored.
    const bodyErr = drainExpectingError(res);
    await fireIdle(stub, id);

    const reset = await resetSeen;
    expect(reset.type).toBe("reset");
    expect(reset.id).toBe(id);
    expect(await bodyErr).toBeInstanceOf(Error);
  });
});

describe("BoxDO streaming relay — reset / offline", () => {
  it("503s with X-Finch-Offline when no agent socket is registered", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    // No _connect -> getWebSockets('agent')[0] is undefined.
    const res = await stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Finch-Offline")).toBe("1");
  });

  it("errors the in-flight readable when the agent sends a reset mid-stream", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    const { id } = await reqSeen;

    agent.send(
      JSON.stringify({
        id,
        type: "head",
        status: 200,
        headers: [["content-type", "text/event-stream"]],
      }),
    );
    agent.send(JSON.stringify({ id, type: "chunk", data: "aGVsbG8=" }));

    const res = await resPromise;
    expect(res.status).toBe(200);

    const bodyErr = drainExpectingError(res);
    // Agent aborts its side. Per contract the DO must NOT echo a reset back.
    agent.send(JSON.stringify({ id, type: "reset", message: "agent abort" }));

    expect(await bodyErr).toBeInstanceOf(Error);
  });

  it("resets ALL in-flight streams when the agent socket closes mid-body", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    const { id } = await reqSeen;

    agent.send(
      JSON.stringify({
        id,
        type: "head",
        status: 200,
        headers: [["content-type", "text/event-stream"]],
      }),
    );
    agent.send(JSON.stringify({ id, type: "chunk", data: "aGVsbG8=" }));

    const res = await resPromise;
    expect(res.status).toBe(200);

    const bodyErr = drainExpectingError(res);
    // Agent link drops -> webSocketClose -> resetAll errors the in-flight body.
    agent.close(1011, "link gone");
    expect(await bodyErr).toBeInstanceOf(Error);
  });
});

describe("BoxDO streaming relay — per-box stream cap (S1)", () => {
  it("429s the request over the cap; a freed slot admits the next request", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    // Collect every relayed req frame (to learn the live ids).
    const reqIds: string[] = [];
    let wakeReqWaiter: (() => void) | undefined;
    agent.addEventListener("message", ((ev: MessageEvent) => {
      const f = JSON.parse(ev.data as string);
      if (f.type === "req") {
        reqIds.push(f.id);
        wakeReqWaiter?.();
      }
    }) as EventListener);
    const waitForReqs = async (n: number) => {
      const deadline = Date.now() + 5_000;
      while (reqIds.length < n && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 50);
          wakeReqWaiter = () => {
            clearTimeout(t);
            wakeReqWaiter = undefined;
            resolve();
          };
        });
      }
      wakeReqWaiter = undefined;
      expect(reqIds.length).toBeGreaterThanOrEqual(n);
    };

    // Fill EVERY slot: the fetches park awaiting head (a slow/silent upstream).
    const parked: Promise<Response>[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_BOX; i++) {
      parked.push(
        stub.fetch(new Request(relayUrl(m), { method: "POST", body: "x" })),
      );
      // Let this small body dispatch and release its byte reservation before
      // starting the next. This test isolates the persistent stream-count cap;
      // the separate slow-body test below owns reservation-budget behavior.
      await waitForReqs(i + 1);
    }

    // One more is over the cap → 429, terminal (no X-Finch-Offline: the LB
    // must NOT treat a saturated box as offline / fail its load over).
    const over = await stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    expect(over.status).toBe(429);
    expect(over.headers.get("X-Finch-Offline")).toBeNull();
    expect(over.headers.get("retry-after")).toBe("1");

    // Complete ONE stream (err before head → its parked fetch resolves and the
    // slot frees)…
    agent.send(
      JSON.stringify({
        id: reqIds[0],
        type: "err",
        status: 502,
        message: "done",
      }),
    );
    const freed = await parked[0];
    expect(freed.status).toBe(502);

    // …and the SAME request that was just refused now gets through (its req
    // frame reaches the agent instead of a 429).
    const before = reqIds.length;
    const admitted = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    await waitForReqs(before + 1);

    // Teardown: terminate the parked pre-head requests explicitly. Relying on a
    // WebSocket close event here is racy in workerd and can leave promises
    // parked until Vitest's per-test timeout.
    for (const id of reqIds.slice(1)) {
      agent.send(
        JSON.stringify({
          id,
          type: "err",
          status: 502,
          message: "cap test done",
        }),
      );
    }
    const rest = await Promise.all([...parked.slice(1), admitted]);
    for (const r of rest) expect(r.status).toBe(502);
  }, 10_000);

  it("bounds concurrent slow request-body reservations by bytes, not stream count", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);
    const reqIds: string[] = [];
    agent.addEventListener("message", ((event: MessageEvent) => {
      const frame = JSON.parse(event.data as string);
      if (frame.type === "req") reqIds.push(frame.id);
    }) as EventListener);

    const reservationSlots = MAX_PENDING_RELAY_BODY_BYTES / MAX_RELAY_BODY_BYTES;
    expect(Number.isInteger(reservationSlots)).toBe(true);
    expect(reservationSlots).toBeLessThan(MAX_STREAMS_PER_BOX);
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const requests = Array.from({ length: reservationSlots }, () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
          controller.enqueue(new TextEncoder().encode("x"));
        },
      });
      return stub.fetch(new Request(relayUrl(m), { method: "POST", body }));
    });

    // The over-budget request must resolve while every accepted body is still
    // blocked. Without a byte reservation, stream-count-only admission permits
    // roughly MAX_STREAMS_PER_BOX * MAX_RELAY_BODY_BYTES of request buffers.
    let pendingReads = 0;
    let reservedBytes = 0;
    for (let i = 0; i < 100 && reservedBytes < MAX_PENDING_RELAY_BODY_BYTES; i++) {
      const snapshot = await runInDO(stub, (instance) => ({
        pendingReads: instance.pendingBodyReads,
        reservedBytes: instance.reservedRequestBodyBytes,
      })) as { pendingReads: number; reservedBytes: number };
      pendingReads = snapshot.pendingReads;
      reservedBytes = snapshot.reservedBytes;
      if (reservedBytes < MAX_PENDING_RELAY_BODY_BYTES) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    expect(pendingReads).toBe(reservationSlots);
    expect(reservedBytes).toBe(MAX_PENDING_RELAY_BODY_BYTES);
    const over = await stub.fetch(new Request(relayUrl(m), { method: "POST", body: "x" }));
    expect(over.status).toBe(429);
    expect(over.headers.get("X-Finch-Offline")).toBeNull();
    expect(await over.json()).toEqual({
      error: "too many request bytes in flight for this box",
    });
    expect(reqIds).toHaveLength(0);

    for (const controller of controllers) controller.close();
    for (let i = 0; i < 100 && reqIds.length < reservationSlots; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(reqIds).toHaveLength(reservationSlots);
    for (const id of reqIds) {
      agent.send(JSON.stringify({ id, type: "err", status: 502, message: "done" }));
    }
    const statuses = (await Promise.all(requests)).map((res) => res.status);
    expect(statuses.every((status) => status === 502)).toBe(true);
    expect(await streamCount(stub)).toBe(0);
  }, 10_000);
});

describe("BoxDO streaming relay — backpressure (window frames)", () => {
  // RELAY_WINDOW_BYTES in box-do.ts. The response ReadableStream uses a
  // ByteLengthQueuingStrategy with this high-water-mark; once the DO has buffered
  // >= HWM bytes without the consumer reading, desiredSize<=0 and the DO sends a
  // {credits:0} PAUSE down to the agent.
  const HWM = 1 * 1024 * 1024; // 1 MiB
  const CHUNK_BYTES = 64 * 1024; // 64 KiB body chunks

  /** A `chunk` frame carrying `n` bytes all equal to `fill`, base64-encoded the
   *  same way the agent encodes (std alphabet, padded). The fill byte lets the
   *  reassembled body be verified deterministically. */
  function chunkFrame(id: string, n: number, fill: number) {
    let bin = "";
    for (let i = 0; i < n; i++) bin += String.fromCharCode(fill);
    return JSON.stringify({ id, type: "chunk", data: btoa(bin) });
  }

  it("pauses the agent (credits:0) past the HWM, then resumes (credits>0) on drain, body intact", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    const { id } = await reqSeen;

    // Head first (head is never paused), then start streaming body chunks. We do
    // NOT read res.body yet, so every chunk accumulates in the DO's stream queue.
    agent.send(
      JSON.stringify({
        id,
        type: "head",
        status: 200,
        headers: [["content-type", "application/octet-stream"]],
      }),
    );

    // Listen for the PAUSE before we start sending so we can't miss it.
    const pauseSeen = waitForFrame(
      agent,
      (f) => f.type === "window" && f.id === id && f.credits === 0,
    );

    // Send enough 64 KiB chunks to cross the 1 MiB HWM. 24 * 64 KiB = 1.5 MiB,
    // comfortably over. All bytes are 0x41 ('A') so the body is verifiable.
    const N = 24;
    for (let i = 0; i < N; i++) {
      agent.send(chunkFrame(id, CHUNK_BYTES, 0x41));
    }

    const res = await resPromise;
    expect(res.status).toBe(200);

    // The DO must have sent a {type:"window",credits:0} PAUSE down to the agent
    // once the buffered body crossed the HWM — WITHOUT the consumer draining.
    const pause = await pauseSeen;
    expect(pause).toMatchObject({ type: "window", id, credits: 0 });

    // Now arm the RESUME watcher and drain the body. Draining pulls the queue
    // below the HWM, firing the stream's pull() -> a {credits>0} RESUME frame.
    const resumeSeen = waitForFrame(
      agent,
      (f) => f.type === "window" && f.id === id && f.credits > 0,
    );

    // Drain concurrently; the agent sends `end` once the read loop has started so
    // res.text() can resolve. (The DO buffered everything; it only SIGNALS pause —
    // it does not itself withhold chunks, so the full body is present.)
    const reader = res.body!.getReader();
    let total = 0;
    let allA = true;
    const readAll = (async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          for (let i = 0; i < value.byteLength; i++) {
            if (value[i] !== 0x41) allA = false;
          }
        }
      }
    })();

    // The RESUME must fire as the consumer drains below the HWM.
    const resume = await resumeSeen;
    expect(resume).toMatchObject({ type: "window", id });
    expect(resume.credits).toBeGreaterThan(0);
    expect(resume.credits).toBe(HWM);

    // Close the upstream body so the read loop completes.
    agent.send(JSON.stringify({ id, type: "end" }));
    await readAll;

    // The full body reassembled intact: N * 64 KiB bytes, all 0x41.
    expect(total).toBe(N * CHUNK_BYTES);
    expect(allA).toBe(true);
  });

  it("does not pause a small response that never crosses the HWM", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    const { id } = await reqSeen;

    // Track every window frame the DO emits for this id.
    const windows: any[] = [];
    agent.addEventListener("message", ((ev: MessageEvent) => {
      const f = JSON.parse(ev.data as string);
      if (f.type === "window" && f.id === id) windows.push(f);
    }) as EventListener);

    agent.send(
      JSON.stringify({
        id,
        type: "head",
        status: 200,
        headers: [["content-type", "application/json"]],
      }),
    );
    // A few tiny chunks, well under the 1 MiB HWM, then end.
    agent.send(JSON.stringify({ id, type: "chunk", data: "aGVsbG8=" })); // "hello"
    agent.send(JSON.stringify({ id, type: "chunk", data: "IHdvcmxk" })); // " world"
    agent.send(JSON.stringify({ id, type: "end" }));

    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
    // No backpressure ever needed -> no window frames at all.
    expect(windows).toEqual([]);
  });

  it("hard-resets a stream when a non-cooperating agent floods past the hard cap (S2 OOM backstop)", async () => {
    const m = freshBox();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    const reqSeen = nextFrame(agent);
    const resPromise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    const { id } = await reqSeen;

    agent.send(
      JSON.stringify({
        id,
        type: "head",
        status: 200,
        headers: [["content-type", "application/octet-stream"]],
      }),
    );

    const res = await resPromise;
    expect(res.status).toBe(200);

    // Arm watchers for the advisory PAUSE and the terminal reset BEFORE
    // flooding so neither can be missed.
    const pauseSeen = waitForFrame(
      agent,
      (f) => f.type === "window" && f.id === id && f.credits === 0,
    );
    const resetSeen = waitForFrame(
      agent,
      (f) => f.type === "reset" && f.id === id,
    );
    // NOTE: we deliberately do NOT read res.body during the flood — reading
    // would relieve the very buffering pressure this test exercises. The
    // errored state is observed after the reset (workerd only surfaces a
    // controller.error() to the reader once a read is attempted).

    // A MALICIOUS agent: never reads window frames, keeps flooding chunks well
    // past the 8 MiB hard cap. One 256 KiB frame reused for speed.
    const floodChunk = chunkFrame(id, 256 * 1024, 0x42);
    const frames = Math.ceil(RELAY_STREAM_HARD_CAP_BYTES / (256 * 1024)) + 4;
    for (let i = 0; i < frames; i++) agent.send(floodChunk);

    // The advisory pause fired first (at the 1 MiB HWM) and was ignored…
    const pause = await pauseSeen;
    expect(pause).toMatchObject({ type: "window", id, credits: 0 });

    // …so crossing the hard cap must RESET the stream: a `reset` frame goes
    // down to the agent and the buffered readable errors out.
    const reset = await resetSeen;
    expect(reset).toMatchObject({ type: "reset", id });
    expect(reset.message).toBe("stream buffer overflow");
    expect(await drainExpectingError(res)).toBeInstanceOf(Error);

    // The slot is freed: the stream map no longer holds this id, so further
    // chunk frames for it are ignored (no throw) and a new relay is admitted.
    agent.send(floodChunk); // late flood frame against a dead id — must be inert
    const req2Seen = nextFrame(agent);
    const res2Promise = stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    const req2 = await req2Seen;
    expect(req2.type).toBe("req");
    agent.send(
      JSON.stringify({ id: req2.id, type: "err", status: 502, message: "ok" }),
    );
    expect((await res2Promise).status).toBe(502);
  }, 15_000);
});
