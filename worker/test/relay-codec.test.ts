import { describe, it, expect } from "vitest";
import vectors from "./relay-vectors.json";
import {
  type AgentFrame,
  type HeadFrame,
  type ChunkFrame,
  type ReqFrame,
  type ResetFrame,
  decodeChunk,
} from "../src/relay-frames";

// CODEC ROUND-TRIP against the SHARED golden fixture (worker/test/relay-vectors.json).
// The Go codec test (agent/relay_vectors_test.go) loads the SAME file. We assert
// each frame's `wire` shape survives JSON.parse(JSON.stringify(wire)) intact, plus
// the contract-critical invariants: head.headers is an ORDERED [name,value] list
// that preserves duplicate set-cookie; chunk.data is std-padded base64 that
// decodes back to the body bytes; a message-less reset serializes WITHOUT a
// `message` key. Field ORDER inside a JSON object is not significant, so we
// compare by decoding to objects/bytes — not by string-comparing the JSON.

type Wire = Record<string, unknown>;
const frames = vectors.frames as Record<string, { wire: Wire }>;
const wireOf = (name: string): Wire => frames[name].wire;

describe("relay codec — round-trips the golden fixture", () => {
  it("every frame deep-equals after JSON round-trip", () => {
    for (const [name, def] of Object.entries(frames)) {
      const wire = def.wire;
      const round = JSON.parse(JSON.stringify(wire));
      expect(round, `frame "${name}" survives JSON round-trip`).toEqual(wire);
    }
  });

  it("req parses to a ReqFrame with a header MAP (not a list)", () => {
    const req = wireOf("req") as unknown as ReqFrame;
    expect(req.type).toBe("req");
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/mcp");
    // The REQUEST side stays a name->value map (Object.fromEntries(req.headers)).
    expect(req.headers).toEqual({
      "content-type": "application/json",
      "mcp-session-id": "sess-abc",
    });
    expect(typeof req.body).toBe("string");
  });

  it("head.headers is an ORDERED [name,value] list preserving duplicate set-cookie", () => {
    const head = wireOf("head") as unknown as HeadFrame;
    expect(head.type).toBe("head");
    expect(head.status).toBe(200);
    expect(Array.isArray(head.headers)).toBe(true);
    // Exact order matters (this is what re-emits Set-Cookie correctly downstream).
    expect(head.headers).toEqual([
      ["content-type", "text/event-stream"],
      ["mcp-session-id", "sess-abc"],
      ["set-cookie", "a=1; Path=/"],
      ["set-cookie", "b=2; Path=/"],
    ]);
    // Two set-cookie entries, in order — duplicates are NOT collapsed.
    const cookies = head.headers
      .filter(([k]) => k === "set-cookie")
      .map(([, v]) => v);
    expect(cookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    // None of the hop-by-hop names leak into head.headers.
    const hop = new Set(vectors.hopByHop as string[]);
    for (const [k] of head.headers) expect(hop.has(k)).toBe(false);
  });

  it("chunk.data is std-padded base64 that decodes to the body bytes", () => {
    const hello = wireOf("chunk_hello") as unknown as ChunkFrame;
    const world = wireOf("chunk_world") as unknown as ChunkFrame;
    expect(hello.data).toBe("aGVsbG8=");
    expect(world.data).toBe("IHdvcmxk");
    // decodeChunk is exactly what the DO body pump uses.
    const a = decodeChunk(hello.data);
    const b = decodeChunk(world.data);
    const joined = new TextDecoder().decode(concat(a, b));
    expect(joined).toBe("hello world");
    // Cross-check against the fixture's convenience field.
    expect(new TextDecoder().decode(a)).toBe(
      (frames.chunk_hello as any).bytes_utf8,
    );
    expect(new TextDecoder().decode(b)).toBe(
      (frames.chunk_world as any).bytes_utf8,
    );
  });

  it("end is just {id,type}", () => {
    expect(wireOf("end")).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      type: "end",
    });
  });

  it("err carries status + message (before head only)", () => {
    const err = wireOf("err");
    expect(err).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      type: "err",
      status: 502,
      message: "dial tcp 127.0.0.1:8000: connect: connection refused",
    });
  });

  it("reset with a message keeps it; reset with no message OMITS the key", () => {
    const withMsg = wireOf("reset") as unknown as ResetFrame;
    expect(withMsg.message).toBe("idle timeout");

    const noMsg = wireOf("reset_no_message");
    // The message key must be ABSENT (omitempty), not "" — matching the Go side.
    expect("message" in noMsg).toBe(false);
    expect(noMsg).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      type: "reset",
    });

    // And what WE emit for a message-less reset must also omit the key.
    const emitted: ResetFrame = {
      id: "11111111-1111-4111-8111-111111111111",
      type: "reset",
    };
    const serialized = JSON.parse(JSON.stringify(emitted));
    expect("message" in serialized).toBe(false);
  });

  it("the streamScript references real frames and the expected reassembly", () => {
    const script = vectors.streamScript;
    expect(script.expectStatus).toBe(200);
    expect(script.expectBodyUtf8).toBe("hello world");
    const decoded = (script.sequence as string[])
      .filter((n) => n.startsWith("chunk"))
      .map((n) => decodeChunk((wireOf(n) as unknown as ChunkFrame).data));
    const joined = new TextDecoder().decode(
      decoded.reduce((acc, cur) => concat(acc, cur), new Uint8Array()),
    );
    expect(joined).toBe(script.expectBodyUtf8);
  });
});

// AgentFrame discrimination: a parsed wire frame narrows by `type`.
describe("relay codec — AgentFrame type discrimination", () => {
  it("narrows each agent->DO frame by its type tag", () => {
    const names = ["head", "chunk_hello", "end", "err", "reset"] as const;
    for (const n of names) {
      const f = wireOf(n) as unknown as AgentFrame;
      switch (f.type) {
        case "head":
          expect(typeof f.status).toBe("number");
          expect(Array.isArray(f.headers)).toBe(true);
          break;
        case "chunk":
          expect(typeof f.data).toBe("string");
          break;
        case "end":
          break;
        case "err":
          expect(typeof f.status).toBe("number");
          expect(typeof f.message).toBe("string");
          break;
        case "reset":
          break;
        default:
          throw new Error(`unexpected frame type for "${n}"`);
      }
    }
  });
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
