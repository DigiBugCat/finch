// DELETE /api/finch/acl/:id -> hub DELETE /api/acl/:id
import { errorResponse, hubProxy } from "@/lib/hub";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return await hubProxy(`/api/acl/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  } catch (err) {
    return errorResponse(err);
  }
}
