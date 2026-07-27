import { HttpError } from "@/lib/hub";
import { readJsonObject as readBoundedJsonObject } from "@/lib/request-body";

export const MAX_API_JSON_BYTES = 4 * 1024;

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new HttpError(502, "invalid response from hub");
    }
    if (Number(declared) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(502, "response from hub is too large");
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(502, "response from hub is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "could not read response from hub");
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

function requireJsonContentType(response: Response): string {
  const contentType = response.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new HttpError(502, "invalid response from hub");
  }
  return contentType;
}

/** Finch's small control messages use a tighter cap than the shared default. */
export async function readJsonObject(
  req: Request,
  maxBytes = MAX_API_JSON_BYTES,
): Promise<JsonObject> {
  return readBoundedJsonObject(req, maxBytes);
}

/** Read a bounded, UTF-8 JSON object from the trusted hub. */
export async function readHubJsonObject(
  response: Response,
  maxBytes = 64 * 1024,
): Promise<JsonObject> {
  requireJsonContentType(response);
  const bytes = await readBoundedResponseBytes(response, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(502, "invalid response from hub");
  }
  if (!isJsonObject(value)) throw new HttpError(502, "invalid response from hub");
  return value;
}

/** Validate a bounded JSON response while preserving its status and bytes. */
export async function relayHubJson(
  response: Response,
  maxBytes = 64 * 1024,
): Promise<Response> {
  const contentType = requireJsonContentType(response);
  const bytes = await readBoundedResponseBytes(response, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(502, "invalid response from hub");
  }
  if (!isJsonObject(value)) throw new HttpError(502, "invalid response from hub");
  return new Response(bytes.buffer as ArrayBuffer, {
    status: response.status,
    headers: { "content-type": contentType },
  });
}

/** Relay a bounded JSON hub response with a route-specific success contract.
 * Malformed successes are a 502. Malformed error bodies retain the upstream
 * status but are replaced with safe JSON so callers never receive HTML or
 * corrupt bytes mislabeled as JSON. */
export async function relayValidatedHubJson(
  response: Response,
  validSuccess: (value: JsonObject) => boolean,
  maxBytes = 64 * 1024,
): Promise<Response> {
  if (response.ok) requireJsonContentType(response);
  const bytes = await readBoundedResponseBytes(response, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    value = undefined;
  }
  if (!isJsonObject(value)) {
    if (response.ok) throw new HttpError(502, "invalid response from hub");
    return Response.json({ error: "hub request failed" }, { status: response.status });
  }
  if (response.ok && !validSuccess(value)) {
    throw new HttpError(502, "invalid response from hub");
  }
  if (!response.ok) return Response.json(value, { status: response.status });
  return new Response(bytes.buffer as ArrayBuffer, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type")! },
  });
}

/** Forward only the response body, status, and content type from the trusted hub. */
export function forwardHubResponse(response: Response, status = response.status): Response {
  return new Response(response.body, {
    status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}
