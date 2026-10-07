import { createTranslator } from "use-intl/core";
import { defaultLocale, type Locale } from "./locales";
import { en, type Messages, ro } from "./messages";

export * from "./locales";

export const messages: Record<Locale, Messages> = { en, ro };
export type { Messages };

declare module "use-intl/core" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}

/** Translator outside React (worker, Telegram, core). Same messages and ICU syntax as the web UI. */
export function getTranslator(locale: Locale) {
  return createTranslator({ locale, messages: messages[locale] });
}
export type Translator = ReturnType<typeof getTranslator>;

/**
 * An error meant for the user. `key` is a full message key (e.g. "errors.providerNotConfigured");
 * the web action wrapper and the worker translate it into the user's language.
 * `message` holds the English text for logs.
 */
export class UserError extends Error {
  override name = "UserError";
  constructor(
    public readonly key: string,
    public readonly values?: Record<string, string | number>,
  ) {
    super(translateKey(getTranslator(defaultLocale), key, values));
  }
}

export function isUserError(error: unknown): error is UserError {
  return error instanceof Error && error.name === "UserError" && typeof (error as UserError).key === "string";
}

/** Translates a dynamic key (from a UserError or a validation message); unknown keys come back unchanged. */
export function translateKey(t: Translator, key: string, values?: Record<string, string | number>): string {
  const loose = t as unknown as { has(k: string): boolean; (k: string, v?: Record<string, string | number>): string };
  return loose.has(key) ? loose(key, values) : key;
}
