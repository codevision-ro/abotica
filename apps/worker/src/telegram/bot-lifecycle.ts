import { clearTelegramBotStatus, env, getTelegramToken, setTelegramBotStatus, type TelegramBotStatus } from "@abotica/core";
import { TELEGRAM_COMMANDS } from "@abotica/core/telegram-commands";
import { defaultLocale, getTranslator, locales } from "@abotica/i18n";
import { Bot } from "grammy";
import { setBotSource } from "./bot";
import { createBotSupervisor } from "./bot-supervisor";
import { registerHandlers } from "./handlers";

/** Logs a failed status write: the bot keeps working, only the settings page misses its state. */
const storeStatus = (write: Promise<void>) =>
  write.catch((error: unknown) => console.error("[telegram] storing the status failed:", error));

/**
 * Command names stay the same in every language; only the descriptions are translated. The default
 * list is English; Telegram clients set to another supported language get theirs.
 */
async function setCommandMenu(bot: Bot) {
  for (const locale of locales) {
    const t = getTranslator(locale);
    const commands = TELEGRAM_COMMANDS.map((command) => ({
      command,
      description: t(`telegram.commands.${command}`),
    }));
    await bot.api.setMyCommands(commands, locale === defaultLocale ? {} : { language_code: locale });
  }
}

/**
 * Starts polling in the background. grammY retries network errors on its own and gives up on a token
 * Telegram refuses or a second instance polling the same bot; that ends up in the status the settings
 * page shows, with the token masked.
 */
function launch(token: string): Bot {
  const bot = new Bot(token, { client: { apiRoot: env().TELEGRAM_API_URL } });
  registerHandlers(bot);
  void bot
    .start({
      onStart: async (me) => {
        console.log(`[telegram] @${me.username} started`);
        const status: TelegramBotStatus = { state: "running", username: me.username, startedAt: new Date().toISOString() };
        await storeStatus(setTelegramBotStatus(token, status));
        await setCommandMenu(bot).catch((error: unknown) =>
          console.error("[telegram] setting the commands failed:", error),
        );
      },
    })
    .catch(async (error: unknown) => {
      if (!supervisor.owns(bot)) return;
      const message = (error instanceof Error ? error.message : String(error)).replaceAll(token, "***");
      console.error(`[telegram] the bot stopped: ${message}`);
      await storeStatus(setTelegramBotStatus(token, { state: "error", error: message, at: new Date().toISOString() }));
    });
  return bot;
}

const supervisor = createBotSupervisor<Bot>({
  readToken: getTelegramToken,
  launch,
  onMissing: async (stopped) => {
    if (stopped) console.log("[telegram] the bot token was removed, the bot stopped");
    else console.warn("[telegram] no bot token in Settings > Telegram, the bot will not start");
    await storeStatus(clearTelegramBotStatus());
  },
});

setBotSource(supervisor.bot);

/** Starts, restarts or stops the bot for the token in the vault: at startup and on telegram.config-changed. */
export const reloadBot = supervisor.reload;

/** Stops polling at shutdown; the bot still sends the replies of runs that are finishing. */
export async function closeBot(): Promise<void> {
  await supervisor.close();
  await storeStatus(clearTelegramBotStatus());
}
