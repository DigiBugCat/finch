import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import vectors from "./relay-vectors.json";
import {
  MAX_STREAMS_PER_MACHINE,
  RELAY_HEAD_TIMEOUT_MS,
  RELAY_IDLE_MS,
} from "../src/appliance-do";

// The APPLIANCE binding's stub type (DurableObjectStub<undefined> in this
// config). runInDurableObject hands the callback the real ApplianceDO instance;
// we type those callbacks `any` since we reach into private methods (onIdle)
// that the public class type doesn't expose.
type Stub = ReturnType<typeof env.APPLIANCE.get>;

// DO STREAMING INTEGRATION (vitest-pool-workers, real ApplianceDO inside workerd).
//
// We drive the genuine ApplianceDO streaming pump end-to-end over a REAL
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
function freshMachine() {
  return {
    tenant: "org_relay",
    appliance: "scraper",
    machine: `box_${Date.now()}_${seq++}`,
  };
}

function stubFor(m: { tenant: string; appliance: string; machine: string }) {
  const name = `${m.tenant}:${m.appliance}:${m.machine}`;
  return env.APPLIANCE.get(env.APPLIANCE.idFromName(name));
}

/** Per-machine relay URL the public path forwards. The DO strips the two leading
 *  /<appliance>/<machine> segments to derive the upstream path. */
function relayUrl(
  m: { appliance: string; machine: string },
  rest = "mcp",
): string {
  return `https://hub/${m.appliance}/${encodeURIComponent(m.machine)}/${rest}`;
}

/** Register a fake agent over a real WS upgrade to the DO's _connect (the DO
 *  itself does no auth; index.ts gates that). Returns the agent's client end. */
async function connectAgent(
  stub: Stub,
  m: { tenant: string; appliance: string; machine: string },
): Promise<WebSocket> {
  const url =
    `https://hub/${m.appliance}/${encodeURIComponent(m.machine)}/_connect` +
    `?tenant=${m.tenant}&appliance=${m.appliance}&machine=${encodeURIComponent(m.machine)}`;
  const res = await stub.fetch(url, { headers: { Upgrade: "websocket" } });
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
 *  ApplianceDO instance; onIdle is private, so we reach it via `any`. The stub is
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

describe("ApplianceDO streaming relay — head + chunks + end", () => {
  it("streams status+headers FIRST, then reassembles the body to 'hello world'", async () => {
    const m = freshMachine();
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

  it("excludes hop-by-hop headers the agent (defensively) re-sent in head", async () => {
    const m = freshMachine();
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
    const m = freshMachine();
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

describe("ApplianceDO streaming relay — err before head", () => {
  it("turns an err frame into a plain Response with the agent's status (502)", async () => {
    const m = freshMachine();
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
    const m = freshMachine();
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

describe("ApplianceDO streaming relay — idle timeout", () => {
  it("504s a head-less stream when the idle timer fires before any head", async () => {
    const m = freshMachine();
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
    const m = freshMachine();
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

describe("ApplianceDO streaming relay — reset / offline", () => {
  it("503s with X-Finch-Offline when no agent socket is registered", async () => {
    const m = freshMachine();
    const stub = stubFor(m);
    // No _connect -> getWebSockets('agent')[0] is undefined.
    const res = await stub.fetch(
      new Request(relayUrl(m), { method: "POST", body: "x" }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Finch-Offline")).toBe("1");
  });

  it("errors the in-flight readable when the agent sends a reset mid-stream", async () => {
    const m = freshMachine();
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
    const m = freshMachine();
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

describe("ApplianceDO streaming relay — per-machine stream cap (S1)", () => {
  it("pins the slowloris constants: pre-head 120s, post-head idle 300s, cap 32", () => {
    // The pre-head timer must be TIGHTER than the streaming idle so head-less
    // (slowloris) slots recycle fast; the cap bounds concurrent DO memory.
    expect(RELAY_HEAD_TIMEOUT_MS).toBe(120_000);
    expect(RELAY_IDLE_MS).toBe(300_000);
    expect(MAX_STREAMS_PER_MACHINE).toBe(32);
  });

  it("429s the request over the cap; a freed slot admits the next request", async () => {
    const m = freshMachine();
    const stub = stubFor(m);
    const agent = await connectAgent(stub, m);

    // Collect every relayed req frame (to learn the live ids).
    const reqIds: string[] = [];
    agent.addEventListener("message", ((ev: MessageEvent) => {
      const f = JSON.parse(ev.data as string);
      if (f.type === "req") reqIds.push(f.id);
    }) as EventListener);
    const waitForReqs = async (n: number) => {
      for (let i = 0; i < 500 && reqIds.length < n; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(reqIds.length).toBeGreaterThanOrEqual(n);
    };

    // Fill EVERY slot: the fetches park awaiting head (a slow/silent upstream).
    const parked: Promise<Response>[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_MACHINE; i++) {
      parked.push(
        stub.fetch(new Request(relayUrl(m), { method: "POST", body: "x" })),
      );
    }
    await waitForReqs(MAX_STREAMS_PER_MACHINE);

    // One more is over the cap → 429, terminal (no X-Finch-Offline: the LB
    // must NOT treat a saturated machine as offline / fail its load over).
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

    // Teardown: close the agent socket → resetAll resolves every parked fetch
    // (502) so nothing dangles past the test.
    agent.close(1011, "cap test done");
    const rest = await Promise.all([...parked.slice(1), admitted]);
    for (const r of rest) expect(r.status).toBe(502);
  });
});

describe("ApplianceDO streaming relay — backpressure (window frames)", () => {
  // RELAY_WINDOW_BYTES in appliance-do.ts. The response ReadableStream uses a
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
    const m = freshMachine();
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
    const m = freshMachine();
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
});
