import { HttpError } from "@/lib/hub";
import { isJsonObject, type JsonObject } from "./cli-contract";

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

/** Forward only the response body, status, and content type from the trusted hub. */
export function forwardHubResponse(response: Response, status = response.status): Response {
  return new Response(response.body, {
    status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}
