/// <reference types="@cloudflare/workers-types" />
//
// RELAY v2 FRAME CONTRACT (FROZEN) — the TypeScript side of the wire shapes the
// BoxDO (WS server) and the Go agent (WS client) exchange over the single
// hibernatable WebSocket. One WS message = one frame = one JSON object, UTF-8.
//
// The canonical fixture is worker/test/relay-vectors.json; both this codec and
// the Go codec round-trip those exact shapes. If you change a shape, change it
// THERE and re-pass both sides.
//
// Direction summary:
//   DO -> agent:  req
//   DO -> agent:  window (flow control; credits===0 PAUSE, credits>0 RESUME)
//   agent -> DO:  head, then zero+ chunk, then end   (STRICT per-id order)
//                 OR err (before head only)
//   either:       reset (abort an in-flight stream; message optional)

/** DO -> agent. The relayed request; body is the buffered request body as a
 *  UTF-8 string. headers is a name->value map (request side stays a map). */
export interface ReqFrame {
  id: string;
  type: "req";
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** agent -> DO. Sent the INSTANT upstream status+headers are known, BEFORE any
 *  body — this is what unblocks SSE. headers is an ORDERED [name,value] list,
 *  lowercased, hop-by-hop excluded, duplicates PRESERVED (e.g. two set-cookie). */
export interface HeadFrame {
  id: string;
  type: "head";
  status: number;
  headers: Array<[string, string]>;
}

/** agent -> DO. data = base64 (std alphabet, padded) of a body byte slice. */
export interface ChunkFrame {
  id: string;
  type: "chunk";
  data: string;
}

/** agent -> DO. Upstream body fully read -> close the stream. */
export interface EndFrame {
  id: string;
  type: "end";
}

/** agent -> DO, error BEFORE head (502 dial fail, 403 SSRF reject). */
export interface ErrFrame {
  id: string;
  type: "err";
  status: number;
  message: string;
}

/** either direction. Abort an in-flight stream. message is optional and is
 *  OMITTED from the wire when empty. */
export interface ResetFrame {
  id: string;
  type: "reset";
  message?: string;
}

/** DO -> agent ONLY. Streaming flow-control (backpressure). credits===0 =>
 *  PAUSE: the agent stops sending `chunk` frames for this id until resumed.
 *  credits>0 => RESUME: the agent may send body chunks again. The agent NEVER
 *  sends a window frame. Emitted by the DO when its response ReadableStream's
 *  in-memory queue crosses the high-water-mark (pause) or drains below it
 *  (resume) — bounding the DO's buffered body to ~HWM + in-flight chunks. */
export interface WindowFrame {
  id: string;
  type: "window";
  credits: number;
}

/** Any frame the agent may send DOWN to the DO. */
export type AgentFrame =
  | HeadFrame
  | ChunkFrame
  | EndFrame
  | ErrFrame
  | ResetFrame;

/** Decode a base64 (std alphabet, padded) chunk payload to raw bytes. atob
 *  yields a binary string (one char per byte); map back to a Uint8Array. */
export function decodeChunk(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
