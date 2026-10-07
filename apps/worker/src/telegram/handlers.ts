import { env } from "@abotica/core";
import type { Bot } from "grammy";
import { botTranslator } from "./bot";
import { registerCommands } from "./commands";
import { registerMessageHandlers } from "./messages";
import { replyError } from "./send";

export function registerHandlers(bot: Bot) {
  const allowed = new Set(env().TELEGRAM_ALLOWED_USER_IDS);

  bot.use(async (ctx, next) => {
    if (!ctx.from || !allowed.has(ctx.from.id)) {
      if (ctx.chat?.type === "private") {
        await ctx.reply((await botTranslator())("telegram.accessDenied", { id: String(ctx.from?.id) }));
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
