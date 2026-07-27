// PUT /api/finch/services/:id/tags {tags} -> hub PUT /api/services/:id/tags
import { errorResponse, HttpError, hubFetchAs, requireAdmin } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { relayHubJson, requireServiceId } from "../../_contract";

const MAX_TAGS = 50;
const MAX_TAG_CHARACTERS = 64;

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw new HttpError(400, `tags must be an array with at most ${MAX_TAGS} entries`);
  }
  const tags = value.map((tag) => {
    if (typeof tag !== "string") throw new HttpError(400, "tags must be strings");
    const clean = tag.trim();
    if (!clean || [...clean].length > MAX_TAG_CHARACTERS || /\p{Cc}/u.test(clean)) {
      throw new HttpError(400, "invalid tag");
    }
    return clean;
  });
  return [...new Set(tags)];
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAdmin();
    const { id: rawId } = await params;
    const id = requireServiceId(rawId);
    const body = await readJsonObject(req, 8 * 1024);
    if (Object.keys(body).some((key) => key !== "tags")) {
      throw new HttpError(400, "unknown tags request field");
    }
    const response = await hubFetchAs(ctx.tenant, `/api/services/${encodeURIComponent(id)}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags: parseTags(body.tags) }),
    });
    return await relayHubJson(response);
  } catch (err) {
    return errorResponse(err);
  }
}
