import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { isSecurePublicRequest } from "./secure-transport";

export type InvitationDelivery = "sent" | "existing-user" | "failed";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EXISTING_INVITATION_CODES = new Set([
  "already_exists",
  "already_invited",
  "duplicate_record",
  "email_address_already_exists",
  "form_identifier_exists",
  "invitation_already_exists",
]);

function invitationRedirect(origin: string): string | null {
  if (typeof origin !== "string") return null;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }

  // The caller promises an origin, not an arbitrary base URL. Reject path,
  // query, fragment, or embedded credentials instead of silently changing the
  // destination. HTTP is permitted only for the loopback development cases
  // accepted by the web transport boundary.
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !isSecurePublicRequest(url.href)
  ) {
    return null;
  }

  return `${url.origin}/dashboard`;
}

function errorCodes(error: unknown): string[] {
  try {
    if (typeof error !== "object" || error === null) return [];
    const record = error as { code?: unknown; errors?: unknown };
    const nested = Array.isArray(record.errors)
      ? record.errors.flatMap((item) =>
          typeof item === "object" && item !== null && "code" in item
            ? [String((item as { code?: unknown }).code ?? "").toLowerCase()]
            : [],
        )
      : [];
    return [String(record.code ?? "").toLowerCase(), ...nested].filter(Boolean);
  } catch {
    // A provider error is diagnostic data, not a reason for this helper to
    // reject and turn a recoverable invitation failure into a route-level 500.
    return [];
  }
}

function validEmail(email: unknown): email is string {
  if (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email)) {
    return false;
  }
  const at = email.indexOf("@");
  return at > 0 && at <= 64 && email.length - at - 1 <= 253;
}

export async function deliverApplicationInvite(
  email: string,
  origin: string,
): Promise<InvitationDelivery> {
  const redirectUrl = invitationRedirect(origin);
  if (!validEmail(email) || !redirectUrl) {
    return "failed";
  }

  try {
    const clerk = await clerkClient();
    await clerk.invitations.createInvitation({
      emailAddress: email,
      redirectUrl,
      ignoreExisting: true,
      notify: true,
    });
    return "sent";
  } catch (error: unknown) {
    if (errorCodes(error).some((code) => EXISTING_INVITATION_CODES.has(code))) {
      return "existing-user";
    }
    console.error("Finch invitation delivery failed", error);
    return "failed";
  }
}
