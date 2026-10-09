import { settingsTranslator, telegramAccess } from "@abotica/core";
import type { Bot } from "grammy";

import { registerCommands } from "./commands";
import { registerMessageHandlers } from "./messages";
import { replyError } from "./send";

export function registerHandlers(bot: Bot) {
  // Read on every update, so a user added or removed in Settings > Telegram counts at once.
  bot.use(async (ctx, next) => {
    const { allowedUserIds } = await telegramAccess();
    if (!ctx.from || !allowedUserIds.includes(ctx.from.id)) {
      if (ctx.chat?.type === "private") {
        await ctx.reply((await settingsTranslator())("telegram.accessDenied", { id: String(ctx.from?.id) }));
      }
      return;
    }
    await next();
  });

  // Commands first: the message:text handler would otherwise take them as chat messages.
  registerCommands(bot);
  registerMessageHandlers(bot);

  bot.catch((err) => {
    console.error("[telegram]", err.error);
    void replyError(err.ctx, err.error).catch(() => {});
  });
}
