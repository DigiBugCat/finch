import "server-only";
import { clerkClient } from "@clerk/nextjs/server";

const ORG_PAGE_SIZE = 100;
// A human identity with 10,000 organization memberships is already far beyond
// the expected operating envelope. This cap turns a broken/repeating Clerk
// page into a bounded failure instead of an infinite request and memory leak.
const MAX_ORG_PAGES = 100;
// Keep the admin-org portion of /api/user/sync comfortably below the worker's
// 256 KiB control-body limit even when every Clerk org id is 128 characters.
// The exact serialized size is checked separately at the producer boundary.
const MAX_ADMIN_ORG_IDS = 1_000;
export const MAX_IDENTITY_SYNC_BODY_BYTES = 256 * 1024;
const ORGANIZATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const norm = (value: string) => value.trim().toLowerCase();

export interface SyncedIdentity {
  emails: string[];
  primaryEmail?: string;
  adminOrgIds: string[];
}

/** Serialize the identity using the worker's exact UTF-8 request-body limit. */
export function serializeSyncedIdentity(identity: SyncedIdentity): string {
  const body = JSON.stringify(identity);
  if (new TextEncoder().encode(body).byteLength > MAX_IDENTITY_SYNC_BODY_BYTES) {
    throw new RangeError("identity sync body exceeded worker limit");
  }
  return body;
}

function errorCodes(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const row = error as { code?: unknown; errors?: unknown };
  const codes = typeof row.code === "string" ? [row.code] : [];
  if (Array.isArray(row.errors)) {
    for (const item of row.errors) {
      if (item && typeof item === "object" && typeof (item as { code?: unknown }).code === "string") {
        codes.push((item as { code: string }).code);
      }
    }
  }
  return codes;
}

/** True only for Clerk's explicit "organizations disabled" error.
 *
 * Generic `*_not_found` failures are deliberately not swallowed: a missing
 * user, instance, or endpoint is a real sync failure, not evidence that the
 * optional organizations feature is disabled.
 */
export function organizationsUnavailable(error: unknown): boolean {
  return errorCodes(error).includes("organization_not_enabled_in_instance");
}

export async function syncIdentity(
  clerkUserId: string,
  { includeOrgs = false }: { includeOrgs?: boolean } = {},
): Promise<SyncedIdentity> {
  const clerk = await clerkClient();
  const user = await clerk.users.getUser(clerkUserId);
  const verified = user.emailAddresses
    .filter((email) => email.verification?.status === "verified")
    .map((email) => ({ ...email, normalized: norm(email.emailAddress) }))
    .filter((email) => email.normalized.length > 0);
  const emails = [...new Set(verified.map((email) => email.normalized))];
  const primary =
    verified.find((email) => email.id === user.primaryEmailAddressId) ?? verified[0];

  const adminOrgIds = new Set<string>();
  if (includeOrgs) {
    try {
      for (let pageNumber = 0; pageNumber < MAX_ORG_PAGES; pageNumber += 1) {
        const page = await clerk.users.getOrganizationMembershipList({
          userId: clerkUserId,
          limit: ORG_PAGE_SIZE,
          offset: pageNumber * ORG_PAGE_SIZE,
        });
        if (!page || !Array.isArray(page.data)) {
          throw new TypeError("invalid organization membership page");
        }
        if (page.data.length > ORG_PAGE_SIZE) {
          throw new RangeError("organization membership page exceeded requested limit");
        }
        for (const membership of page.data) {
          if (!membership || typeof membership !== "object") {
            throw new TypeError("invalid organization membership");
          }
          if (membership.role === "org:admin" || membership.role === "admin") {
            const organizationId = membership.organization?.id;
            if (
              typeof organizationId !== "string" ||
              !ORGANIZATION_ID_RE.test(organizationId)
            ) {
              throw new TypeError("invalid admin organization membership");
            }
            adminOrgIds.add(organizationId);
            if (adminOrgIds.size > MAX_ADMIN_ORG_IDS) {
              throw new RangeError("admin organization membership limit exceeded");
            }
          }
        }
        if (page.data.length < ORG_PAGE_SIZE) break;
        if (pageNumber === MAX_ORG_PAGES - 1) {
          throw new RangeError("organization membership pagination exceeded safe limit");
        }
      }
    } catch (error) {
      if (!organizationsUnavailable(error)) throw error;
    }
  }

  return {
    emails,
    ...(primary ? { primaryEmail: primary.normalized } : {}),
    adminOrgIds: [...adminOrgIds],
  };
}
