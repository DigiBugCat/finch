// DELETE /api/finch/acl/:id -> hub DELETE /api/acl/:id
import { errorResponse, HttpError, hubProxy, requireSharing } from "@/lib/hub";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSharing();
    const { id } = await params;
    if (
      typeof id !== "string" ||
      !id ||
      id !== id.trim() ||
      id.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(id)
    ) {
      throw new HttpError(400, "valid id required");
    }
    return await hubProxy(`/api/acl/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  } catch (err) {
    return errorResponse(err);
  }
}
