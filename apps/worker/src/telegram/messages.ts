import {
  appendUserMessage,
  type Conversation,
  ConversationBusyError,
  filePart,
  getSettings,
  projectProviderPolicy,
  providerAllowed,
  readRunStream,
  saveFile,
  startRun,
  TRANSCRIPTION_PROVIDER,
  transcriptionModel,
} from "@abotica/core";
import { translateKey, type Translator } from "@abotica/i18n";
import { generateId, transcribe, type UIMessage } from "ai";
import type { Bot, Context } from "grammy";
import type { Message } from "grammy/types";
import { botTranslator } from "./bot";
import { currentConversation } from "./chat";
import type { TelegramOrigin } from "./delivery";
import { incomingFileName, mediaGroupCollector, TELEGRAM_DOWNLOAD_MAX_BYTES } from "./incoming-files";
import { replyError } from "./send";

async function download(bot: Bot, fileId: string): Promise<{ data: Buffer; path: string }> {
  const file = await bot.api.getFile(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${bot.token}/${file.file_path}`);
  if (!res.ok) throw new Error(`File download failed (${res.status})`);
  return { data: Buffer.from(await res.arrayBuffer()), path: file.file_path ?? "" };
}

/** Replies and returns true when Telegram will not let the bot download the file. */
async function refuseTooLarge(ctx: Context, name: string, size: number | undefined): Promise<boolean> {
  if ((size ?? 0) <= TELEGRAM_DOWNLOAD_MAX_BYTES) return false;
  const t = await botTranslator();
  await ctx.reply(t("telegram.fileTooLarge", { name, max: TELEGRAM_DOWNLOAD_MAX_BYTES / (1024 * 1024) }));
  return true;
}

/** Draft status for a tool call: the tool's own "running" text when the tools namespace has one. */
const toolStatus = (t: Translator, name: string) => {
  const key = `tools.${name}.running`;
  const running = translateKey(t, key);
  if (running !== key) return running;
  if (name === "skill_read") return t("telegram.progress.skill");
  if (name === "tool_search") return t("telegram.progress.toolSearch");
  const [server, tool] = name.split("__");
  return tool ? t("telegram.progress.mcpTool", { tool, server: server! }) : t("telegram.progress.tool", { tool: name });
};

/**
 * Live progress while the agent works: in private chats an animated draft with the current
 * step only (its text, or what tool it is using), elsewhere a typing indicator. Intermediate
 * steps are replaced, never stacked, and the final answer arrives as a normal message.
 */
async function showProgress(bot: Bot, ctx: Context, runId: string) {
  const chatId = ctx.chat!.id;
  const thread = ctx.msg?.message_thread_id;
  const typingIn = thread ? { message_thread_id: thread } : {};
  const isPrivate = ctx.chat!.type === "private";
  const draftId = Math.floor(Math.random() * 1_000_000) + 1;
  const t = await botTranslator();
  let stepText = "";
  let status = "";
  let lastShown = "";
  let lastSent = 0;
  const typing = setInterval(() => void bot.api.sendChatAction(chatId, "typing", typingIn).catch(() => {}), 4_500);
  void bot.api.sendChatAction(chatId, "typing", typingIn).catch(() => {});
  try {
    for await (const chunk of readRunStream(runId, { idleMs: 60_000 })) {
      if (chunk.type === "start-step") {
        stepText = "";
        status = "";
      } else if (chunk.type === "text-delta") {
        stepText += chunk.delta;
      } else if (chunk.type === "tool-input-available") {
        status = toolStatus(t, chunk.toolName);
      }
      const view = stepText.trim() || status;
      if (!isPrivate || !view || view === lastShown || Date.now() - lastSent < 900) continue;
      lastShown = view;
      lastSent = Date.now();
      await bot.api.sendMessageDraft(chatId, draftId, view.slice(-4000)).catch(() => {});
    }
  } finally {
    clearInterval(typing);
  }
}

/**
 * Appends the message to the chat's conversation and starts the super agent on it. The Telegram
 * message it came from is kept in its metadata, so the worker can react to it when a running run
 * takes it in.
 */
async function handleUserMessage(bot: Bot, ctx: Context, message: UIMessage, conversation: Conversation) {
  const origin: TelegramOrigin | null = ctx.msg ? { chatId: ctx.chat!.id, messageId: ctx.msg.message_id } : null;
  await appendUserMessage(
    conversation.id,
    origin ? { ...message, metadata: { ...(message.metadata as object | undefined), telegram: origin } } : message,
  );
  try {
    const run = await startRun({
      agentId: conversation.agentId,
      trigger: "telegram",
      conversationId: conversation.id,
      projectId: conversation.projectId,
    });
    void showProgress(bot, ctx, run.id).catch((e) => console.error("[telegram] progress", e));
  } catch (error) {
    if (!(error instanceof ConversationBusyError)) throw error;
    // Still answering the previous message: the running run takes this one in at its next step (the
    // reaction then becomes ✍), or a follow-up answers it right after.
    await ctx.react("👀").catch(() => {});
  }
}

/** Text, voice, photos and documents become user messages for the super agent, in every chat and topic. */
export function registerMessageHandlers(bot: Bot) {
  bot.on("message:text", async (ctx) => {
    const conversation = await currentConversation(ctx);
    await handleUserMessage(
      bot,
      ctx,
      { id: generateId(), role: "user", parts: [{ type: "text", text: ctx.message.text }] },
      conversation,
    );
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const media = ctx.message.voice ?? ctx.message.audio!;
    const name = ctx.message.audio?.file_name ?? (await botTranslator())("telegram.fileDefaultName");
    if (await refuseTooLarge(ctx, name, media.file_size)) return;
    const conversation = await currentConversation(ctx);
    // The recording is the project's data: it goes to the transcription provider only if the project allows it.
    if (!providerAllowed(await projectProviderPolicy(conversation.projectId), TRANSCRIPTION_PROVIDER)) {
      return ctx.reply((await botTranslator())("telegram.voiceNotAllowed"));
    }
    const { data } = await download(bot, media.file_id);
    const { locale } = await getSettings();
    const { text } = await transcribe({
      model: await transcriptionModel(),
      audio: data,
      // Hint the language set in Settings; without one the model detects it.
      ...(locale ? { providerOptions: { openai: { language: locale } } } : {}),
    });
    if (!text.trim()) return ctx.reply((await botTranslator())("telegram.voiceNotUnderstood"));
    await ctx.reply(`🎙️ _${text}_`, { parse_mode: "Markdown" }).catch(() => ctx.reply(`🎙️ ${text}`));
    await handleUserMessage(bot, ctx, { id: generateId(), role: "user", parts: [{ type: "text", text }] }, conversation);
  });

  // A photo or document arrives on its own, or as one update per item of an album; an album becomes one message.
  const collectAlbum = mediaGroupCollector<Context>((items) => {
    void handleFiles(bot, items).catch((error: unknown) => {
      // Outside the middleware chain here, so bot.catch does not see the error.
      console.error("[telegram]", error);
      return replyError(items[0]!, error).catch(() => {});
    });
  });
  bot.on(["message:photo", "message:document"], async (ctx) => {
    const group = ctx.message.media_group_id;
    if (group) collectAlbum(group, ctx);
    else await handleFiles(bot, [ctx]);
  });
}

type Attachment = { fileId: string; size: number | undefined; name: string; mimeType: string | undefined };

/** The file of a photo (its largest size, always JPEG) or document message; `position` numbers album photos. */
function attachmentOf(message: Message, t: Translator, position: number | null): Attachment | null {
  const photo = message.photo?.at(-1);
  if (photo) {
    const base = t("telegram.photoDefaultName");
    return {
      fileId: photo.file_id,
      size: photo.file_size,
      name: incomingFileName(undefined, "image/jpeg", position ? `${base}-${position}` : base),
      mimeType: "image/jpeg",
    };
  }
  const doc = message.document;
  if (!doc) return null;
  return {
    fileId: doc.file_id,
    size: doc.file_size,
    name: incomingFileName(doc.file_name, doc.mime_type, t("telegram.fileDefaultName")),
    mimeType: doc.mime_type,
  };
}

/**
 * Photos and documents, one or an album: each is stored as a file of the chat's conversation and the
 * message carries a part per file plus the captions. The model input decides how to show each file.
 * One file over the download limit refuses the whole message, so the agent never gets half an album.
 */
async function handleFiles(bot: Bot, items: Context[]) {
  const ctx = items[0]!;
  const t = await botTranslator();
  const attachments = items.flatMap((item, i) => {
    const attachment = item.message && attachmentOf(item.message, t, items.length > 1 ? i + 1 : null);
    return attachment ? [attachment] : [];
  });
  for (const a of attachments) if (await refuseTooLarge(ctx, a.name, a.size)) return;

  const conversation = await currentConversation(ctx);
  const parts: UIMessage["parts"] = [];
  for (const a of attachments) {
    const { data } = await download(bot, a.fileId);
    const file = await saveFile({
      name: a.name,
      data,
      source: "user",
      owner: { conversationId: conversation.id },
      mimeType: a.mimeType,
    });
    parts.push(filePart(file));
  }
  for (const item of items) if (item.message?.caption) parts.push({ type: "text", text: item.message.caption });
  if (!parts.length) return;
  await handleUserMessage(bot, ctx, { id: generateId(), role: "user", parts }, conversation);
}
