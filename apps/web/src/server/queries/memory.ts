import "server-only";
import { ANY_PROVIDER, embedText, searchJournals } from "@abotica/core";
import { agents, conversations, db, journals, memories, messages, projects } from "@abotica/db";
import {
  and,
  asc,
  cosineDistance,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  lte,
  sql,
  type SQL,
} from "@abotica/db/orm";
import { isDay } from "@/lib/day";
import { isUuid } from "@/lib/uuid";
import { query } from "@/server/query";

export type MemoryScope = "global" | "project" | "agent";

/** For a project entry, `agent*` is its author (null: written by the user); for an agent entry, its owner. */
const memoryColumns = {
  id: memories.id,
  scope: memories.scope,
  content: memories.content,
  source: memories.source,
  status: memories.status,
  projectId: memories.projectId,
  agentId: memories.agentId,
  updatedAt: memories.updatedAt,
  projectName: projects.name,
  agentName: agents.name,
  agentAvatar: agents.avatar,
};

export const getMemoryOptions = query(async () => {
  const [agentRows, projectRows] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name, avatar: agents.avatar })
      .from(agents)
      .where(eq(agents.isTemplate, false))
      .orderBy(asc(agents.name)),
    db.select({ id: projects.id, name: projects.name }).from(projects).orderBy(asc(projects.name)),
  ]);
  return { agents: agentRows, projects: projectRows };
});

export const listMemories = query(async (opts: { scope: MemoryScope; projectId?: string; agentId?: string }) => {
  const where: SQL[] = [eq(memories.scope, opts.scope), eq(memories.status, "active")];
  if (opts.scope === "project" && isUuid(opts.projectId)) where.push(eq(memories.projectId, opts.projectId));
  if (opts.scope === "agent" && isUuid(opts.agentId)) where.push(eq(memories.agentId, opts.agentId));
  return db
    .select(memoryColumns)
    .from(memories)
    .leftJoin(projects, eq(projects.id, memories.projectId))
    .leftJoin(agents, eq(agents.id, memories.agentId))
    .where(and(...where))
    .orderBy(desc(memories.updatedAt))
    .limit(500);
});

/**
 * Every entry of one agent or project, pending first: the memory tab on its page. A project's entries
 * carry their author (the agent that wrote it; none for the user's own).
 */
export const listOwnerMemories = query(async (owner: { agentId: string } | { projectId: string }) => {
  const where =
    "agentId" in owner
      ? and(eq(memories.scope, "agent"), eq(memories.agentId, owner.agentId))
      : and(eq(memories.scope, "project"), eq(memories.projectId, owner.projectId));
  return db
    .select({
      id: memories.id,
      scope: memories.scope,
      content: memories.content,
      source: memories.source,
      status: memories.status,
      updatedAt: memories.updatedAt,
      agentName: agents.name,
      agentAvatar: agents.avatar,
    })
    .from(memories)
    .leftJoin(agents, eq(agents.id, memories.agentId))
    .where(where)
    .orderBy(desc(sql`${memories.status} = 'pending'`), desc(memories.updatedAt));
});

export const listPendingMemories = query(async () => {
  return db
    .select(memoryColumns)
    .from(memories)
    .leftJoin(projects, eq(projects.id, memories.projectId))
    .leftJoin(agents, eq(agents.id, memories.agentId))
    .where(eq(memories.status, "pending"))
    .orderBy(desc(memories.updatedAt));
});

export const getMemoryCounts = query(async () => {
  const rows = await db
    .select({ scope: memories.scope, status: memories.status, n: count() })
    .from(memories)
    .groupBy(memories.scope, memories.status);
  const counts = { global: 0, project: 0, agent: 0, pending: 0 };
  for (const r of rows) {
    if (r.status === "pending") counts.pending += r.n;
    else counts[r.scope] += r.n;
  }
  return counts;
});

/** Semantic search across every memory (all scopes and owners), with a text fallback without embeddings. */
export const getMemorySearchResults = query(async (search: string, limit: number = 20) => {
  // The user's own query, typed outside any project.
  const vector = await embedText(search, ANY_PROVIDER);
  if (vector) {
    const distance = cosineDistance(memories.embedding, vector);
    const rows = await db
      .select({ ...memoryColumns, similarity: sql<number>`1 - (${distance})` })
      .from(memories)
      .leftJoin(projects, eq(projects.id, memories.projectId))
      .leftJoin(agents, eq(agents.id, memories.agentId))
      .where(isNotNull(memories.embedding))
      .orderBy(distance)
      .limit(limit);
    return { semantic: true, rows: rows.map((r) => ({ ...r, similarity: Number(r.similarity) })) };
  }
  const rows = await db
    .select(memoryColumns)
    .from(memories)
    .leftJoin(projects, eq(projects.id, memories.projectId))
    .leftJoin(agents, eq(agents.id, memories.agentId))
    .where(ilike(memories.content, `%${search}%`))
    .orderBy(desc(memories.updatedAt))
    .limit(limit);
  return { semantic: false, rows: rows.map((r) => ({ ...r, similarity: null as number | null })) };
});

const CONVERSATIONS_PAGE_SIZE = 50;

export const getConversationPage = query(async (page: number = 1) => {
  const p = Math.max(1, page);
  const messageCount = db
    .select({ conversationId: messages.conversationId, n: count().as("n") })
    .from(messages)
    .groupBy(messages.conversationId)
    .as("message_count");
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: conversations.id,
        title: conversations.title,
        channel: conversations.channel,
        updatedAt: conversations.updatedAt,
        agentName: agents.name,
        agentAvatar: agents.avatar,
        messageCount: sql<number>`coalesce(${messageCount.n}, 0)`.mapWith(Number),
      })
      .from(conversations)
      .innerJoin(agents, eq(agents.id, conversations.agentId))
      .leftJoin(messageCount, eq(messageCount.conversationId, conversations.id))
      .orderBy(desc(conversations.updatedAt))
      .limit(CONVERSATIONS_PAGE_SIZE)
      .offset((p - 1) * CONVERSATIONS_PAGE_SIZE),
    db.select({ n: count() }).from(conversations),
  ]);
  const n = total?.n ?? 0;
  return { rows, page: p, pageCount: Math.max(1, Math.ceil(n / CONVERSATIONS_PAGE_SIZE)), total: n };
});

export const getConversationTranscript = query(async (id: string) => {
  if (!isUuid(id)) return null;
  const [conversation] = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      channel: conversations.channel,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      agentName: agents.name,
      agentAvatar: agents.avatar,
    })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .where(eq(conversations.id, id));
  if (!conversation) return null;
  const rows = await db
    .select({ id: messages.id, role: messages.role, parts: messages.parts, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));
  return { conversation, messages: rows };
});

const JOURNAL_DAYS_PER_PAGE = 14;

export const getJournalDays = query(async (opts: { agentId?: string; from?: string; to?: string; page?: number }) => {
  const where: SQL[] = [];
  if (isUuid(opts.agentId)) where.push(eq(journals.agentId, opts.agentId));
  if (isDay(opts.from)) where.push(gte(journals.day, opts.from));
  if (isDay(opts.to)) where.push(lte(journals.day, opts.to));
  const condition = where.length ? and(...where) : undefined;
  const page = Math.max(1, opts.page ?? 1);

  const dayRows = await db
    .selectDistinct({ day: journals.day })
    .from(journals)
    .where(condition)
    .orderBy(desc(journals.day))
    .limit(JOURNAL_DAYS_PER_PAGE + 1)
    .offset((page - 1) * JOURNAL_DAYS_PER_PAGE);
  const hasNext = dayRows.length > JOURNAL_DAYS_PER_PAGE;
  const days = dayRows.slice(0, JOURNAL_DAYS_PER_PAGE).map((d) => d.day);
  if (!days.length) return { days: [], page, hasNext: false };

  const entries = await db
    .select({
      id: journals.id,
      day: journals.day,
      summary: journals.summary,
      consolidated: journals.consolidated,
      agentId: journals.agentId,
      agentName: agents.name,
      agentAvatar: agents.avatar,
    })
    .from(journals)
    .innerJoin(agents, eq(agents.id, journals.agentId))
    .where(and(condition, inArray(journals.day, days)))
    .orderBy(desc(journals.day), asc(agents.name));

  return {
    days: days.map((day) => ({ day, entries: entries.filter((e) => e.day === day) })),
    page,
    hasNext,
  };
});

export const listJournalSearchResults = query(async (search: string, agentId?: string) => {
  const rows = await searchJournals(search, { agentId: isUuid(agentId) ? agentId : undefined, limit: 20 });
  const ids = [...new Set(rows.map((r) => r.agentId))];
  const agentRows = ids.length
    ? await db
        .select({ id: agents.id, name: agents.name, avatar: agents.avatar })
        .from(agents)
        .where(inArray(agents.id, ids))
    : [];
  const byId = new Map(agentRows.map((a) => [a.id, a]));
  return rows.map((r) => ({
    ...r,
    agentName: byId.get(r.agentId)?.name ?? null,
    agentAvatar: byId.get(r.agentId)?.avatar ?? null,
  }));
});
