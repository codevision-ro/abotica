import { conversations, db, projects } from "@abotica/db";
import { and, desc, eq, isNull, sql } from "@abotica/db/orm";
import { getTranslator } from "@abotica/i18n";
import { getSettings, settingsLocale } from "../platform/settings";
import { getTelegramToken, telegramAccess } from "../telegram/telegram-config";
import { telegramConversationKey } from "../telegram/telegram-ids";
import type { Conversation } from "./conversations";
import { getOrchestrator } from "./runs";

/**
 * Where the super agent gets what reaches it outside a conversation it delegated from: the results of
 * work a schedule or trigger fired for a manager or a specialist. It is where the user talks to the
 * super agent, so they read its answer there: with Telegram set up, the conversation of the project's
 * topic (or of the notification chat itself), the one the bot continues when the user writes there;
 * otherwise a web conversation per project, in the chat list.
 */
export async function superAgentInbox(projectId: string | null): Promise<Conversation> {
  const [agent, { notifyChatId }, token, settings, [project]] = await Promise.all([
    getOrchestrator(),
    telegramAccess(),
    getTelegramToken(),
    getSettings(),
    projectId
      ? db
          .select({ name: projects.name, topicId: projects.telegramTopicId })
          .from(projects)
          .where(eq(projects.id, projectId))
      : Promise.resolve([]),
  ]);
  const t = getTranslator(settingsLocale(settings));
  const telegram = Boolean(token) && notifyChatId !== null;
  const channel = telegram ? ("telegram" as const) : ("web" as const);
  const externalId = telegram
    ? telegramConversationKey(notifyChatId!, project?.topicId)
    : `reports:${projectId && project ? projectId : "general"}`;
  const title = telegram
    ? t("telegram.conversationTitle")
    : project
      ? t("notifications.reportsInbox.project", { project: project.name })
      : t("notifications.reportsInbox.general");

  // Serialized per key, so two reports arriving together find or make the same conversation.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`inbox:${channel}:${externalId}`}))`);
    // As the bot picks it (telegram/chat.ts in the worker): the latest of the super agent's for the key.
    const [existing] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.channel, channel),
          eq(conversations.externalId, externalId),
          eq(conversations.agentId, agent.id),
          isNull(conversations.projectId),
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(1);
    if (existing) return existing;
    const [created] = await tx
      .insert(conversations)
      .values({ agentId: agent.id, channel, externalId, projectId: null, title })
      .returning();
    return created!;
  });
}
