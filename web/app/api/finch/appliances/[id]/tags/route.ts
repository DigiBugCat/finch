// PUT /api/finch/appliances/:id/tags {tags} -> hub PUT /api/appliances/:id/tags
import { errorResponse, hubProxy, requireAdmin } from "@/lib/hub";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
    const { id } = await params;
    const body = await req.text();
    return await hubProxy(
      `/api/appliances/${encodeURIComponent(id)}/tags`,
      { method: "PUT", body },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
