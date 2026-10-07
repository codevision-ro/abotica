"use client";

import { useTranslations } from "next-intl";

/** better-auth error codes we show in the user's language; anything else falls back to the given message. */
const CODES = {
  INVALID_EMAIL_OR_PASSWORD: "invalidEmailOrPassword",
  INVALID_EMAIL: "invalidEmail",
  PASSWORD_TOO_SHORT: "passwordTooShort",
  USER_ALREADY_EXISTS: "userAlreadyExists",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "userAlreadyExists",
  INVALID_CODE: "invalidCode",
  INVALID_BACKUP_CODE: "invalidBackupCode",
  TOO_MANY_ATTEMPTS: "tooManyAttempts",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "tooManyAttempts",
  INVALID_TWO_FACTOR_COOKIE: "verificationExpired",
  INVALID_SETUP_CODE: "setupCodeInvalid",
} as const;

export function useAuthError() {
  const t = useTranslations("auth.errors");
  return (error: { code?: string; message?: string }, fallback: string) => {
    const key = error.code ? CODES[error.code as keyof typeof CODES] : undefined;
    return key ? t(key) : error.message || fallback;
  };
}
