import { type Conversation, createConversation, getOrchestrator, telegramConversationKey } from "@abotica/core";
import { conversations, db } from "@abotica/db";
import { and, desc, eq, isNull } from "@abotica/db/orm";
import type { Context } from "grammy";
import { botTranslator } from "./bot";

/**
 * The chat's conversation with the super agent, who answers in every chat and topic (a new one when
 * `fresh`). A conversation left from another agent (a project's manager that used to answer in its
 * topic) is not reused.
 */
export async function currentConversation(ctx: Context, fresh = false): Promise<Conversation> {
  const agentId = (await getOrchestrator()).id;
  const externalId = telegramConversationKey(ctx.chat!.id, ctx.msg?.message_thread_id);
  if (!fresh) {
    const [existing] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.channel, "telegram"),
          eq(conversations.externalId, externalId),
          eq(conversations.agentId, agentId),
          isNull(conversations.projectId),
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(1);
    if (existing) return existing;
  }
  return createConversation({
    agentId,
    channel: "telegram",
    externalId,
    projectId: null,
    title: (await botTranslator())("telegram.conversationTitle"),
  });
}
