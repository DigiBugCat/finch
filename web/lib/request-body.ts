import { HttpError } from "./hub";

export const DEFAULT_JSON_BODY_LIMIT = 64 * 1024;

/** Read a request stream with a hard byte ceiling, including when an attacker
 * omits or lies about Content-Length. */
export async function readBoundedBody(
  req: Request,
  maxBytes = DEFAULT_JSON_BODY_LIMIT,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new HttpError(400, "invalid content-length");
    }
    if (Number(contentLength) > maxBytes) {
      throw new HttpError(413, "request body too large");
    }
  }

  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Parse a bounded JSON object from a route request.
 *
 * `Request.json()` buffers an unbounded body and accepts JSON primitives. Most
 * bridge handlers then dereference the result, turning valid JSON such as
 * `null` into a 500. This helper bounds bytes even when Content-Length is
 * absent or dishonest and makes malformed/non-object input a deterministic
 * client error. */
export async function readJsonObject(
  req: Request,
  maxBytes = DEFAULT_JSON_BODY_LIMIT,
): Promise<Record<string, unknown>> {
  const bytes = await readBoundedBody(req, maxBytes);

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "request body must be valid UTF-8 JSON");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON object body required");
  }
  return parsed as Record<string, unknown>;
}
