// PUT /api/finch/services/:id/tags {tags} -> hub PUT /api/services/:id/tags
import { adminProxy, errorResponse } from "@/lib/hub";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return await adminProxy(
      req,
      `/api/services/${encodeURIComponent(id)}/tags`,
      "PUT",
    );
  } catch (err) {
    return errorResponse(err);
  }
}
