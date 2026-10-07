import { type Conversation, createConversation, getOrchestrator } from "@abotica/core";
import { conversations, db, projects } from "@abotica/db";
import { and, desc, eq, isNull } from "@abotica/db/orm";
import type { Context } from "grammy";
import { botTranslator, notifyChatId } from "./bot";
import { type ChatRoute, routeChat, topicOf } from "./routing";

const externalIdOf = (ctx: Context) => {
  const chatId = ctx.chat!.id;
  const thread = ctx.msg?.message_thread_id;
  return thread ? `${chatId}:${thread}` : `${chatId}`;
};

/**
 * Who answers in this chat: the manager in a project's forum topic, the super agent anywhere else.
 * Topic ids are numbered per chat, and project topics live in the notification chat, so a topic with
 * the same id in another group is not the project's.
 */
async function routeOf(ctx: Context): Promise<ChatRoute> {
  const topic = topicOf(ctx.msg);
  if (!topic || ctx.chat?.id !== notifyChatId()) return { kind: "orchestrator" };
  const [project] = await db
    .select({ id: projects.id, name: projects.name, managerAgentId: projects.managerAgentId })
    .from(projects)
    .where(eq(projects.telegramTopicId, topic));
  return routeChat(project);
}

/**
 * The chat's conversation with the agent that answers there (a new one when `fresh`). A conversation
 * left from an earlier route (another manager, a topic no longer mapped) is not reused. Replies and
 * returns null when the chat is a topic of a project without a manager.
 */
export async function currentConversation(ctx: Context, fresh = false): Promise<Conversation | null> {
  const route = await routeOf(ctx);
  if (route.kind === "noManager") {
    await ctx.reply((await botTranslator())("telegram.noManager", { project: route.project }));
    return null;
  }
  const { agentId, projectId } =
    route.kind === "manager" ? route : { agentId: (await getOrchestrator()).id, projectId: null };
  const externalId = externalIdOf(ctx);
  if (!fresh) {
    const [existing] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.channel, "telegram"),
          eq(conversations.externalId, externalId),
          eq(conversations.agentId, agentId),
          projectId ? eq(conversations.projectId, projectId) : isNull(conversations.projectId),
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
    projectId,
    title: (await botTranslator())("telegram.conversationTitle"),
  });
}
