import { telegramAccess } from "@abotica/core";
import type { Bot } from "grammy";

/** Where getBot finds the bot; bot-lifecycle.ts points it at the bot it runs when the worker starts. */
let botSource: () => Bot | null = () => null;

export function setBotSource(source: () => Bot | null) {
  botSource = source;
}

/** Null when no bot token is set in Settings > Telegram; callers then skip Telegram. */
export function getBot(): Bot | null {
  return botSource();
}

/** The chat notifications go to, read from the settings each time so a change applies at once. */
export async function notifyChatId(): Promise<number | null> {
  return (await telegramAccess()).notifyChatId;
}
