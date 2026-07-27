// POST /api/finch/chat {service, messages} — the dashboard's "test in chat"
// panel. Admin-only; relays to the hub's /chat/completions using the web's
// service auth (no finch_ key), so chatting never mints keys.
import { errorResponse, HttpError, hubFetchAs, requireAdmin } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { isJsonObject, relayHubJson, requireServiceId } from "../services/_contract";

const MAX_CHAT_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARACTERS = 8_000;

function parseMessages(value: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "messages must contain at least one entry");
  }
  // The browser accumulates two messages per completed turn. Slice before
  // validation/forwarding so turn 16 (31 messages including the new user
  // prompt) stays within the worker's 30-message inference budget.
  return value.slice(-MAX_MESSAGES).map((message) => {
    if (!isJsonObject(message)) throw new HttpError(400, "invalid chat message");
    const keys = Object.keys(message);
    if (keys.some((key) => key !== "role" && key !== "content")) {
      throw new HttpError(400, "invalid chat message");
    }
    if (message.role !== "user" && message.role !== "assistant") {
      throw new HttpError(400, "invalid chat message role");
    }
    if (
      typeof message.content !== "string" ||
      message.content.length === 0 ||
      [...message.content].length > MAX_MESSAGE_CHARACTERS
    ) {
      throw new HttpError(400, "invalid chat message content");
    }
    return { role: message.role, content: message.content };
  });
}

export async function POST(req: Request) {
  try {
    const ctx = await requireAdmin();
    const body = await readJsonObject(req, MAX_CHAT_BODY_BYTES);
    if (Object.keys(body).some((key) => key !== "service" && key !== "messages")) {
      throw new HttpError(400, "unknown chat request field");
    }
    const service = requireServiceId(body.service);
    const messages = parseMessages(body.messages);
    const res = await hubFetchAs(ctx.tenant, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ service, messages }),
    });
    return await relayHubJson(res, 256 * 1024);
  } catch (err) {
    return errorResponse(err);
  }
}
