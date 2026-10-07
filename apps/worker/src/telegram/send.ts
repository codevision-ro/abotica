import { isUserError, translateKey } from "@abotica/i18n";
import type { Bot, Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { botTranslator } from "./bot";

const PLAIN_LIMIT = 4000;

function splitText(text: string, limit = PLAIN_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export type Target = { chatId: number; threadId?: number | null };

/**
 * Sends Markdown as a Telegram rich message; falls back to plain text chunks if the
 * rich message is rejected (e.g. too long or unsupported markup).
 */
export async function sendMarkdown(
  bot: Bot,
  target: Target,
  markdown: string,
  opts: { keyboard?: InlineKeyboardMarkup } = {},
): Promise<number | undefined> {
  const text = markdown.trim() || (await botTranslator())("telegram.reply.empty");
  const thread = target.threadId ? { message_thread_id: target.threadId } : {};
  try {
    const msg = await bot.api.sendRichMessage(
      target.chatId,
      { markdown: text },
      { ...thread, ...(opts.keyboard ? { reply_markup: opts.keyboard } : {}) },
    );
    return msg.message_id;
  } catch {
    const chunks = splitText(text);
    let lastId: number | undefined;
    for (const [i, chunk] of chunks.entries()) {
      const isLast = i === chunks.length - 1;
      const msg = await bot.api.sendMessage(target.chatId, chunk, {
        ...thread,
        ...(isLast && opts.keyboard ? { reply_markup: opts.keyboard } : {}),
      });
      lastId = msg.message_id;
    }
    return lastId;
  }
}

/** Tells the user a handler failed: a UserError in the bot's language, anything else with its message. */
export async function replyError(ctx: Context, error: unknown): Promise<void> {
  const t = await botTranslator();
  const message = isUserError(error)
    ? translateKey(t, error.key, error.values)
    : error instanceof Error
      ? error.message
      : t("errors.unknown");
  await ctx.reply(t("telegram.error", { message }));
}
