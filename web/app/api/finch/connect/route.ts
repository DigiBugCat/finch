// GET /api/finch/connect — the one-command box-onboarding string.
//
// Returns the install-and-sign-in one-liner the dashboard shows on "Add a
// device": it installs the finch CLI from the hub and runs `finch login`, which
// starts the browser device-authorization flow (the box prints a short code the
// operator approves at /cli). No appliance id or one-shot ticket — the box is
// named later with `finch add <name>`.
//
// The hub origin comes from HUB_URL (the real hub this web instance talks to),
// so the command targets the same environment the dashboard is on (staging vs
// prod), not a tenant's stored slug host.
import { resolveTenant, getHubUrl, errorResponse } from "@/lib/hub";

export async function GET() {
  try {
    // Authed callers only (this is a dashboard surface), but no admin needed —
    // it reveals nothing tenant-specific, just the public install/login command.
    await resolveTenant();
    const hub = await getHubUrl();
    const command = `curl -fsSL ${hub}/install | sh && finch login --hub ${hub}`;
    return Response.json({ hub, command });
  } catch (err) {
    return errorResponse(err);
  }
}
