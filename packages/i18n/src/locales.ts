import { hasLocale } from "use-intl/core";

/** Locales and locale matching, without the messages: light enough for any client bundle. */
export const locales = ["en", "ro"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

/** Shown in the language picker, each in its own language. */
export const localeNames: Record<Locale, string> = { en: "English", ro: "Română" };

/** Language name in English, for prompts that tell a model which language to write in. */
export const localeEnglishNames: Record<Locale, string> = { en: "English", ro: "Romanian" };

export function isLocale(value: unknown): value is Locale {
  return hasLocale(locales, value);
}

/** Best supported locale from an Accept-Language header, by quality. */
export function matchLocale(acceptLanguage: string | null | undefined): Locale {
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = Number(
        params
          .find((p) => p.trim().startsWith("q="))
          ?.trim()
          .slice(2) ?? 1,
      );
      return { lang: tag.toLowerCase().split("-")[0], q: Number.isNaN(q) ? 0 : q };
    })
    .sort((a, b) => b.q - a.q);
  return ranked.map((r) => r.lang).find(isLocale) ?? defaultLocale;
}
