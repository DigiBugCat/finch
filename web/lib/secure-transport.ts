/** Public Finch pages and APIs must use HTTPS. Plain HTTP remains available
 * only for an explicitly loopback local development URL. This mirrors the hub
 * and box-agent transport boundary without trusting a spoofable forwarded
 * header. */
export function isSecurePublicRequest(rawUrl: string): boolean {
  if (typeof rawUrl !== "string") return false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // Credentials in a public URL are both ambiguous to operators and easy to
  // misread in logs (for example, https://trusted.example@evil.example).
  if (url.username || url.password) return false;

  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}
