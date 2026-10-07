import { filePath, listFiles } from "@abotica/core";
import type { ExecuteResult } from "@abotica/core/agents/runner";
import type { conversations, runs } from "@abotica/db";
import type { Translator } from "@abotica/i18n";
import { type Bot, InputFile } from "grammy";
import { botTranslator, getBot } from "./bot";
import { sendMarkdown, type Target } from "./send";

/**
 * Files the agent shared with file_share during the run, after the answer. All go as documents, images
 * too: Telegram compresses photos, while a document keeps the file the agent made byte for byte, with
 * its name, which matters for charts, scans and anything the user downloads.
 */
async function sendSharedFiles(bot: Bot, target: Target, runId: string, conversationId: string) {
  for (const file of await listFiles({ runId, conversationId, source: "agent" })) {
    try {
      await bot.api.sendDocument(target.chatId, new InputFile(filePath(file.id), file.name), {
        ...(target.threadId ? { message_thread_id: target.threadId } : {}),
      });
    } catch (error) {
      console.error(`[telegram] sending shared file ${file.id} failed:`, error);
    }
  }
}

/** The chat (and forum topic) a Telegram conversation lives in, from its `chat` or `chat:thread` external id. */
function targetOf(externalId: string): Target {
  const [chat, thread] = externalId.split(":");
  return { chatId: Number(chat), threadId: thread ? Number(thread) : null };
}

/**
 * Sends the final answer of the conversation's agent (the super agent, or a project's manager in its
 * topic) back to the Telegram chat and topic the conversation belongs to.
 */
export async function deliverTelegramReply(
  conversation: typeof conversations.$inferSelect,
  run: typeof runs.$inferSelect,
  result: ExecuteResult,
) {
  const bot = getBot();
  if (!bot || !conversation.externalId) return;
  const target = targetOf(conversation.externalId);
  const t = await botTranslator();
  try {
    await sendReply(bot, target, run, result, t);
  } finally {
    // Shared files are useful even when the run failed or stopped after creating them.
    await sendSharedFiles(bot, target, run.id, conversation.id);
  }
}

async function sendReply(bot: Bot, target: Target, run: typeof runs.$inferSelect, result: ExecuteResult, t: Translator) {
  if (result.status === "failed") {
    await sendMarkdown(
      bot,
      target,
      run.error ? t("telegram.reply.failed", { error: run.error }) : t("telegram.reply.failedUnknown"),
    );
    return;
  }
  if (result.status === "cancelled") {
    await sendMarkdown(
      bot,
      target,
      run.error ? t("telegram.reply.stoppedReason", { reason: run.error }) : t("telegram.reply.stopped"),
    );
    return;
  }
  // For waiting_approval, the approval notification carries the buttons; still send any text so far.
  if (result.output) await sendMarkdown(bot, target, result.output);
}

/** A notice for the user in a Telegram conversation's chat and topic, outside any run. */
export async function sendTelegramNotice(conversation: typeof conversations.$inferSelect, text: string) {
  const bot = getBot();
  if (!bot || !conversation.externalId) return;
  await sendMarkdown(bot, targetOf(conversation.externalId), text);
}

/** Typing indicator for runs the worker starts on its own (follow-ups after queued messages). */
export function showTelegramTyping(conversation: typeof conversations.$inferSelect) {
  const bot = getBot();
  if (!bot || !conversation.externalId) return;
  const { chatId, threadId } = targetOf(conversation.externalId);
  void bot.api.sendChatAction(chatId, "typing", threadId ? { message_thread_id: threadId } : {}).catch(() => {});
}
