import type { Locale, Messages } from "@abotica/i18n";

declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
