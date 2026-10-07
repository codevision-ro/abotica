/** Any base works: only paths that stay on it pass, and the result is relative to it. */
const PLACEHOLDER_ORIGIN = "http://return-path.invalid";

/**
 * A path on the same site to send the visitor back to after a redirect (login, preview access), or
 * "/" when the value could lead elsewhere. Client-safe: the login form, the app and the preview server use it.
 *
 * Browsers drop tabs and newlines inside URLs and read "\" as "/", so "/\t/evil.com" or "/\\evil.com"
 * become "//evil.com"; dot segments can do the same ("/.//evil.com"). Both are refused, and the
 * result is the parsed, normalized path rather than the raw value.
 */
export function safeReturnPath(value: string | null | undefined, origin: string = PLACEHOLDER_ORIGIN): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  let base: URL;
  let url: URL;
  try {
    base = new URL(origin);
    url = new URL(value, base);
  } catch {
    return "/";
  }
  if (url.origin !== base.origin || url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
