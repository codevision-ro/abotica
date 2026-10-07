/**
 * Names and attributes of the auth cookies. Over HTTPS they are `__Host-` cookies: host-only and
 * Secure, so no subdomain (agents' previews included) can set or replace them. Over plain HTTP
 * (local development) browsers refuse that prefix, and the names stay plain.
 */
const secure = (process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? "").startsWith("https://");

export const AUTH_COOKIE_PREFIX = secure ? "__Host-abotica" : "abotica";

/** For betterAuth's `advanced`: the prefix above, never better-auth's own `__Secure-`. */
export const authCookieOptions = {
  cookiePrefix: AUTH_COOKIE_PREFIX,
  useSecureCookies: false,
  defaultCookieAttributes: { secure },
} as const;
