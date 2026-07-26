import { HttpError } from "@/lib/hub";

const MEMBER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function memberId(value: unknown): string {
  if (typeof value !== "string" || !MEMBER_ID_RE.test(value)) {
    throw new HttpError(400, "invalid member id");
  }
  return value;
}

export function invitationEmail(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "valid email required");
  const email = value.trim().toLowerCase();
  const at = email.indexOf("@");
  if (
    email.length > 254 ||
    !EMAIL_RE.test(email) ||
    at <= 0 ||
    at > 64 ||
    email.length - at - 1 > 253
  ) {
    throw new HttpError(400, "valid email required");
  }
  return email;
}

export function memberRole(value: unknown): "owner" | "admin" | "member" {
  if (typeof value !== "string") throw new HttpError(400, "invalid role");
  const role = value.trim().toLowerCase();
  if (role !== "owner" && role !== "admin" && role !== "member") {
    throw new HttpError(400, "invalid role");
  }
  return role;
}
