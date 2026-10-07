import { DEFAULT_SETTINGS, getSettings } from "@abotica/core";
import { matchLocale, messages } from "@abotica/i18n";
import { headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

/** No locale in the URL: the language comes from Settings, or the browser until one is chosen. */
export default getRequestConfig(async () => {
  // Read the request first: during `next build` this marks the page dynamic before any database access.
  const acceptLanguage = (await headers()).get("accept-language");
  const settings = await getSettings().catch(() => DEFAULT_SETTINGS);
  const locale = settings.locale ?? matchLocale(acceptLanguage);
  return { locale, messages: messages[locale], timeZone: settings.timezone };
});
