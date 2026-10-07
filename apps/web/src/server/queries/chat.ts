import "server-only";
import {
  availableProviders,
  type CatalogModel,
  type Conversation,
  getCatalog,
  getOrchestrator,
  getSettings,
  listFiles,
  resolveModelChain,
} from "@abotica/core";
import type { ReasoningSupport } from "@abotica/core/models/reasoning";
import {
  agents,
  conversations,
  db,
  messages,
  type ModelRef,
  projectAgents,
  projects,
  type ReasoningEffort,
  runs,
  skills,
} from "@abotica/db";
import { and, asc, desc, eq, inArray, isNull, ne } from "@abotica/db/orm";
import type { UIMessage } from "ai";
import { cache } from "react";
import { type ConversationFilter } from "@/lib/conversation-filter";
import { query } from "@/server/query";

export type ChatModelOption = {
  id: string;
  name: string;
  /** Null when the model does not reason. */
  reasoning: ReasoningSupport | null;
  contextWindow: number | null;
  /** USD per 1M tokens. */
  cost: { input: number; output: number } | null;
};

type ChatModelProvider = { id: string; label: string; models: ChatModelOption[] };

export type ChatModelState = {
  /** Configured providers with their tool-capable models. */
  providers: ChatModelProvider[];
  agent: {
    /**
     * First model of the agent's chain (its own or the default from settings); null when there is none.
     * `reasoning` is undefined when the model is not in the catalog.
     */
    model: (ModelRef & { name: string; reasoning: ReasoningSupport | null | undefined }) | null;
    /** The agent has no model of its own and follows the default from settings. */
    followsDefault: boolean;
    reasoningEffort: ReasoningEffort;
  };
  /** Effort from settings, used when the agent's is "default". */
  defaultReasoningEffort: ReasoningEffort;
  /** What this conversation overrides; null means it follows the agent. */
  selection: { model: ModelRef | null; reasoningEffort: ReasoningEffort | null };
};

type AgentRow = Pick<typeof agents.$inferSelect, "provider" | "model" | "fallbacks" | "reasoningEffort">;
type ConversationRow = Pick<Conversation, "modelOverride" | "reasoningEffort">;

const toOption = (m: CatalogModel): ChatModelOption => ({
  id: m.id,
  name: m.name,
  reasoning: m.reasoning,
  contextWindow: m.contextWindow,
  cost: m.cost ? { input: m.cost.input, output: m.cost.output } : null,
});

/** Everything the chat model picker needs for one conversation. */
export const getChatModelState = query(async (agent: AgentRow, conversation: ConversationRow): Promise<ChatModelState> => {
  const [providers, settings, catalog] = await Promise.all([availableProviders(), getSettings(), getCatalog()]);
  const primary = resolveModelChain(agent, settings)[0];
  const entry = primary && catalog.find((m) => m.provider === primary.provider && m.id === primary.model);
  return {
    providers: providers.map((p) => ({ id: p.id, label: p.label, models: p.models.map(toOption) })),
    agent: {
      model: primary
        ? {
            provider: primary.provider,
            model: primary.model,
            name: entry?.name ?? primary.model,
            reasoning: entry ? entry.reasoning : undefined,
          }
        : null,
      followsDefault: !agent.provider || !agent.model,
      reasoningEffort: agent.reasoningEffort,
    },
    defaultReasoningEffort: settings.defaultReasoningEffort,
    selection: { model: conversation.modelOverride ?? null, reasoningEffort: conversation.reasoningEffort ?? null },
  };
});

/**
 * Conversations shown in the chat list, newest first: every channel except internal (task and automation
 * runs), optionally only those of one project or those outside projects.
 */
export const listConversations = query(async (filter: ConversationFilter = null, limit: number = 100) => {
  const byProject = !filter
    ? undefined
    : filter.projectId
      ? eq(conversations.projectId, filter.projectId)
      : isNull(conversations.projectId);
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      channel: conversations.channel,
      updatedAt: conversations.updatedAt,
      agentName: agents.name,
      agentAvatar: agents.avatar,
      project: { id: projects.id, name: projects.name },
    })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .leftJoin(projects, eq(projects.id, conversations.projectId))
    .where(and(ne(conversations.channel, "internal"), byProject))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
});

/** Projects that have conversations in the chat list, by name: the choices of its project filter. */
export const listConversationProjects = query(async () => {
  return db
    .selectDistinct({ id: projects.id, name: projects.name })
    .from(conversations)
    .innerJoin(projects, eq(projects.id, conversations.projectId))
    .where(ne(conversations.channel, "internal"))
    .orderBy(asc(projects.name));
});

/** Agents a new conversation can be started with, the super agent first. */
export const listChatAgents = query(async () => {
  return db
    .select({
      id: agents.id,
      name: agents.name,
      avatar: agents.avatar,
      role: agents.role,
      isOrchestrator: agents.isOrchestrator,
      enabled: agents.enabled,
    })
    .from(agents)
    .where(eq(agents.isTemplate, false))
    .orderBy(desc(agents.isOrchestrator), agents.name);
});

export type ChatAgent = Awaited<ReturnType<typeof listChatAgents>>[number];

/** Projects a conversation can work in (not archived), with their manager and team. */
export const listChatProjects = query(async () => {
  const [rows, members] = await Promise.all([
    db
      .select({ id: projects.id, name: projects.name, managerAgentId: projects.managerAgentId })
      .from(projects)
      .where(ne(projects.status, "archived"))
      .orderBy(asc(projects.name)),
    db.select({ projectId: projectAgents.projectId, agentId: projectAgents.agentId }).from(projectAgents),
  ]);
  return rows.map((p) => ({
    ...p,
    memberIds: members.filter((m) => m.projectId === p.id).map((m) => m.agentId),
  }));
});

export type ChatProject = Awaited<ReturnType<typeof listChatProjects>>[number];

/** The most recently active conversation of an agent on a channel, or null. */
async function latestConversationId(agentId: string, channel: Conversation["channel"]): Promise<string | null> {
  const [latest] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), eq(conversations.channel, channel)))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  return latest?.id ?? null;
}

/** The super agent's most recently active web conversation, or null. */
export const getLatestOrchestratorConversationId = query(async (): Promise<string | null> =>
  latestConversationId((await getOrchestrator()).id, "web"),
);

/** The most recently active conversation of the chat list under a filter, or null. */
export const getLatestListedConversationId = query(async (filter: ConversationFilter): Promise<string | null> => {
  const [latest] = await listConversations(filter, 1);
  return latest?.id ?? null;
});

/**
 * A conversation with its agent, its project (null for a global one) and, for a skill test, the tested
 * skill; or null.
 * Cached per request: page metadata and the page share it.
 */
export const getConversationWithAgent = query(
  cache(async (id: string) => {
    const [row] = await db
      .select({
        conversation: conversations,
        agent: agents,
        project: { id: projects.id, name: projects.name },
        testSkill: { id: skills.id, name: skills.name },
      })
      .from(conversations)
      .innerJoin(agents, eq(agents.id, conversations.agentId))
      .leftJoin(projects, eq(projects.id, conversations.projectId))
      .leftJoin(skills, eq(skills.id, conversations.testSkillId))
      .where(eq(conversations.id, id));
    return row ?? null;
  }),
);

/** The conversation's queued or running run, or null. */
export const getActiveRunId = query(async (conversationId: string): Promise<string | null> => {
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.conversationId, conversationId), inArray(runs.status, ["queued", "running"])))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return run?.id ?? null;
});

/**
 * A conversation's messages as the chat restores them, their creation times, whether a run is active,
 * and the sizes of the conversation's files (file parts carry no size).
 */
export const getConversationMessages = query(async (conversationId: string) => {
  const [rows, activeRunId, conversationFiles] = await Promise.all([
    db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt)),
    getActiveRunId(conversationId),
    listFiles({ conversationId }),
  ]);
  // Reasoning is saved for the model's next turn (OpenAI's is an encrypted blob); the chat never shows it.
  const visible = (parts: unknown[]) => (parts as UIMessage["parts"]).filter((p) => p.type !== "reasoning");
  return {
    messages: rows.map(
      (m) => ({ id: m.id, role: m.role, parts: visible(m.parts), metadata: m.metadata ?? undefined }) as UIMessage,
    ),
    timestamps: Object.fromEntries(rows.map((m) => [m.id, m.createdAt.toISOString()])),
    fileSizes: Object.fromEntries(conversationFiles.map((f) => [f.id, f.size])) as Record<string, number>,
    active: activeRunId !== null,
  };
});
