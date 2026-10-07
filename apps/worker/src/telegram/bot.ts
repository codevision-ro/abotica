import { env, getSettings, settingsLocale } from "@abotica/core";
import { getTranslator, type Translator } from "@abotica/i18n";
import { Bot } from "grammy";

let bot: Bot | null = null;

/** Null when TELEGRAM_BOT_TOKEN is not configured; callers then skip Telegram. */
export function getBot(): Bot | null {
  const token = env().TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  bot ??= new Bot(token);
  return bot;
}

/** Translator for Telegram and notification texts, in the language from Settings. */
export async function botTranslator(): Promise<Translator> {
  return getTranslator(settingsLocale(await getSettings()));
}

export function notifyChatId(): number | null {
  const id = env().TELEGRAM_NOTIFY_CHAT_ID ?? String(env().TELEGRAM_ALLOWED_USER_IDS[0] ?? "");
  return id ? Number(id) : null;
}
