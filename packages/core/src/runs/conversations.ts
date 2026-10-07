// Conversation lifecycle shared by the web app and the Telegram bot.
import { agents, conversations, db, messages, projectAgents, projects } from "@abotica/db";
import { and, count, eq } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import type { UIMessage } from "ai";
import { fileIdsOwnedBy, removeFileBytes } from "../files/files";
import { conversationWorkspaceKey, requestWorkspaceRemoval } from "../sandbox/sandbox";

export type Conversation = typeof conversations.$inferSelect;

const TITLE_LENGTH = 80;

/**
 * Throws unless the agent may work in the project: it has to be on the team, and the super agent,
 * which works on projects through their managers, never is.
 */
async function assertProjectMember(agentId: string, projectId: string): Promise<void> {
  const [[agent], [project], [member]] = await Promise.all([
    db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)),
    db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)),
    db
      .select({ id: projectAgents.agentId })
      .from(projectAgents)
      .where(and(eq(projectAgents.projectId, projectId), eq(projectAgents.agentId, agentId))),
  ]);
  if (!agent) throw new UserError("team.errors.agentNotFound");
  if (!project) throw new UserError("projects.errors.notFound");
  if (!member) throw new UserError("team.errors.agentNotInProject", { agent: agent.name, project: project.name });
}

/**
 * `title` comes translated from the caller: the web and the bot each know their user's language.
 * With `projectId` the conversation works in that project, and the agent must be on its team.
 */
export async function createConversation(input: {
  agentId: string;
  channel: Conversation["channel"];
  title: string;
  projectId?: string | null;
  externalId?: string | null;
  /** A skill test: the agent gets this skill in the conversation even when it is not assigned. */
  testSkillId?: string | null;
}): Promise<Conversation> {
  if (input.projectId) await assertProjectMember(input.agentId, input.projectId);
  const [row] = await db
    .insert(conversations)
    .values({
      agentId: input.agentId,
      channel: input.channel,
      projectId: input.projectId ?? null,
      title: input.title,
      externalId: input.externalId ?? null,
      testSkillId: input.testSkillId ?? null,
    })
    .returning();
  return row!;
}

/**
 * A conversation in a project. Without `agentId` it is with the project's manager; a project without
 * one is refused, since nobody leads it yet. The agent is checked like in `createConversation`.
 */
export async function startProjectConversation(input: {
  projectId: string;
  agentId?: string;
  channel: Conversation["channel"];
  title: string;
}): Promise<Conversation> {
  let agentId = input.agentId;
  if (!agentId) {
    const [project] = await db
      .select({ name: projects.name, managerAgentId: projects.managerAgentId })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    if (!project) throw new UserError("projects.errors.notFound");
    if (!project.managerAgentId) throw new UserError("team.errors.noManager", { project: project.name });
    agentId = project.managerAgentId;
  }
  return createConversation({ agentId, channel: input.channel, title: input.title, projectId: input.projectId });
}

/**
 * Call right after appending a user message: when it is the conversation's first message, its
 * text becomes the title (`fallback` when it has no text).
 */
export async function setTitleFromFirstMessage(
  conversationId: string,
  message: UIMessage,
  fallback: string,
): Promise<void> {
  const [existing] = await db.select({ n: count() }).from(messages).where(eq(messages.conversationId, conversationId));
  if (existing?.n !== 1) return;
  const text = message.parts.find((p) => p.type === "text")?.text ?? fallback;
  await db
    .update(conversations)
    .set({ title: text.slice(0, TITLE_LENGTH) })
    .where(eq(conversations.id, conversationId));
}

/** Deletes a conversation with its messages, its files and its sandbox workspace. */
export async function deleteConversation(id: string): Promise<void> {
  const fileIds = await fileIdsOwnedBy({ conversationIds: [id] });
  const [row] = await db.delete(conversations).where(eq(conversations.id, id)).returning({ id: conversations.id });
  if (!row) return;
  await removeFileBytes(fileIds);
  await requestWorkspaceRemoval(conversationWorkspaceKey(id));
}
