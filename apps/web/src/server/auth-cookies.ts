import { appOrigins } from "@abotica/core/app-origins";

/**
 * Names and attributes of the auth cookies. Over HTTPS (APP_URL) they are `__Host-` cookies:
 * host-only and Secure, so no subdomain (agents' previews included) can set or replace them. Over
 * plain HTTP (local development) browsers refuse that prefix, and the names stay plain.
 * Functions, not constants: env is read at request time, never while `next build` imports this.
 */
export const isHttpsApp = () => appOrigins()[0]?.startsWith("https:") ?? false;

export const authCookiePrefix = () => (isHttpsApp() ? "__Host-abotica" : "abotica");

/** For betterAuth's `advanced`: the prefix above, never better-auth's own `__Secure-`. */
export const authCookieOptions = () =>
  ({
    cookiePrefix: authCookiePrefix(),
    useSecureCookies: false,
    defaultCookieAttributes: { secure: isHttpsApp() },
  }) as const;
