import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@abotica/db";
import { defaultLocale, getTranslator } from "@abotica/i18n";
import * as authSchema from "@abotica/db/auth-schema";
import { count } from "@abotica/db/orm";
import { APIError, betterAuth } from "better-auth";
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

/** Extra public origins (tunnels, a second domain) besides BETTER_AUTH_URL, comma separated. */
const trustedOrigins = (process.env.TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const auth = betterAuth({
  appName: "Abotica",
  trustedOrigins,
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
  emailAndPassword: { enabled: true, minPasswordLength: 10, autoSignIn: true },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  advanced: authCookieOptions,
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
