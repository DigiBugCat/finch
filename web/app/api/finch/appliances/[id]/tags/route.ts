// PUT /api/finch/appliances/:id/tags {tags} -> hub PUT /api/appliances/:id/tags
import { adminProxy, errorResponse } from "@/lib/hub";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return await adminProxy(
      req,
      `/api/appliances/${encodeURIComponent(id)}/tags`,
      "PUT",
    );
  } catch (err) {
    return errorResponse(err);
  }
}
