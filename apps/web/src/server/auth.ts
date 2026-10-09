import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { getSettings, redis } from "@abotica/core";
import { appOrigins } from "@abotica/core/app-origins";
import { PASSWORD_MIN_LENGTH } from "@abotica/core/limits";
import { db } from "@abotica/db";
import { defaultLocale, getTranslator } from "@abotica/i18n";
import * as authSchema from "@abotica/db/auth-schema";
import { count } from "@abotica/db/orm";
import { APIError, betterAuth, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { getLocale } from "next-intl/server";
import { authCookieOptions } from "./auth-cookies";

/** Single-user app: sign-up is allowed only while no account exists and ALLOW_SIGNUP is on. */
export async function signupOpen(): Promise<boolean> {
  if (process.env.ALLOW_SIGNUP === "false") return false;
  const [row] = await db.select({ n: count() }).from(authSchema.user);
  return (row?.n ?? 0) === 0;
}

/**
 * SETUP_CODE (install.sh writes one): while it is set, creating the account also needs this code,
 * so on a public server nobody else can claim the instance between install and the first sign-up.
 */
export function setupCodeRequired(): boolean {
  return Boolean(process.env.SETUP_CODE?.trim());
}

/** The header the sign-up form sends the code in. */
export const SETUP_CODE_HEADER = "x-abotica-setup-code";

function setupCodeMatches(given: string | null | undefined): boolean {
  const expected = process.env.SETUP_CODE?.trim();
  if (!expected) return true;
  // Hashed first: timingSafeEqual needs equal lengths, and the length must not leak either.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given?.trim() ?? ""), digest(expected));
}

const DAY = 60 * 60 * 24;
const RATE_LIMIT_TIMEOUT_MS = 3_000;

/**
 * Counts of requests per client IP and auth path, in Redis: the limits hold across restarts and
 * between processes, and need no table. One step per request: the first INCR of a window sets its
 * expiry, the request passes while the count is within `max`. Fails closed: a sign-in that cannot
 * be counted (Redis down or hung) is refused rather than let through unlimited.
 */
const rateLimitStorage: NonNullable<NonNullable<BetterAuthOptions["rateLimit"]>["customStorage"]> = {
  async consume(key, rule) {
    const step = redis().eval(
      "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return {n, redis.call('TTL', KEYS[1])}",
      1,
      `abotica:auth-rate:${key}`,
      rule.window,
    ) as Promise<[number, number]>;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Auth rate limit: Redis did not answer")), RATE_LIMIT_TIMEOUT_MS);
    });
    try {
      const [n, ttl] = await Promise.race([step, timeout]);
      return n <= rule.max
        ? { allowed: true, retryAfter: null }
        : { allowed: false, retryAfter: ttl > 0 ? ttl : rule.window };
    } finally {
      clearTimeout(timer);
    }
  },
};

function createAuth(sessionDays: number) {
  const expiresIn = sessionDays * DAY;
  return betterAuth({
    appName: "Abotica",
    // APP_URL and TRUSTED_ORIGINS (tunnels, a second domain); better-auth adds BETTER_AUTH_URL itself.
    trustedOrigins: appOrigins(),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authSchema.user,
        session: authSchema.session,
        account: authSchema.account,
        verification: authSchema.verification,
        twoFactor: authSchema.twoFactor,
      },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: PASSWORD_MIN_LENGTH, autoSignIn: true },
    // Renewed once a day while in use (twice per lifetime for a one-day session), so it ends sessionDays after the last visit.
    session: { expiresIn, updateAge: Math.min(DAY, expiresIn / 2) },
    // On in development too (better-auth turns it on only in production by default). Per client IP:
    // behind Caddy or directly, X-Forwarded-For holds the one address better-auth trusts.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/*": { window: 60, max: 5 },
        // Before the account exists this is also where SETUP_CODE can be guessed.
        "/sign-up/*": { window: 60 * 60, max: 10 },
        // TOTP and backup code checks, enabling and disabling 2FA.
        "/two-factor/*": { window: 60, max: 5 },
        "/change-password": { window: 60 * 15, max: 5 },
      },
      customStorage: rateLimitStorage,
    },
    advanced: authCookieOptions(),
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email" || setupCodeMatches(ctx.headers?.get(SETUP_CODE_HEADER))) return;
        const t = getTranslator(await getLocale().catch(() => defaultLocale));
        throw new APIError("FORBIDDEN", { message: t("auth.errors.setupCodeInvalid"), code: "INVALID_SETUP_CODE" });
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (await signupOpen()) return;
            const t = getTranslator(await getLocale().catch(() => defaultLocale));
            throw new APIError("BAD_REQUEST", { message: t("auth.errors.signupClosed") });
          },
        },
      },
    },
    plugins: [twoFactor({ issuer: "Abotica" }), nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;

let current: { sessionDays: number; auth: Auth } | undefined;

/**
 * The better-auth instance for the current Settings > Security session length. better-auth reads
 * session.expiresIn once, at creation, and uses it for the session row's expiry, the cookie's
 * Max-Age and the renewal on use, so the instance is rebuilt when the setting changes instead of
 * patching expiresAt in hooks (which would leave the cookie and the renewal on the old length).
 * Applies to sign-ins and renewals within the settings cache's few seconds, without a restart;
 * sessions already issued keep their expiry until their next renewal.
 */
export async function getAuth(): Promise<Auth> {
  const { sessionDays } = (await getSettings()).security;
  if (current?.sessionDays !== sessionDays) current = { sessionDays, auth: createAuth(sessionDays) };
  return current.auth;
}
