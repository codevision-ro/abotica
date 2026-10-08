import "server-only";
import { getSettings, NEVER_USED_DAYS, pinnedUsage, searchAllMemories, searchJournals } from "@abotica/core";
import { agents, conversations, db, journals, memories, memoryOrigin, messages, projects } from "@abotica/db";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "@abotica/db/orm";
import { isDay } from "@/lib/day";
import { isUuid } from "@/lib/uuid";
import { query } from "@/server/query";

export type MemoryScope = "global" | "project" | "agent";

/**
 * The current entries a pending one would replace once approved (it waits, e.g. because it contradicts an
 * entry the user wrote), oldest first. `memories.id` is spelled out: drizzle leaves a column unqualified
 * in a single-table select, where it would name the subquery's own row.
 */
const replaces = sql<string[]>`array(
  select r.content from memories r
  where r.superseded_by = memories.id and r.invalidated_at is null
  order by r.created_at
)`;

/** How long an entry holds, whether a newer one replaced it, and how often runs used it. */
const lifecycleColumns = {
  retention: memories.retention,
  validFrom: memories.validFrom,
  invalidatedAt: memories.invalidatedAt,
  supersededBy: memories.supersededBy,
  expiresAt: memories.expiresAt,
  recallCount: memories.recallCount,
  replaces,
};

/** For a project entry, `agent*` is its author (null: written by the user); for an agent entry, its owner. */
const memoryColumns = {
  id: memories.id,
  scope: memories.scope,
  content: memories.content,
  source: memories.source,
  origin: memories.origin,
  status: memories.status,
  pinned: memories.pinned,
  flagReason: memories.flagReason,
  projectId: memories.projectId,
  agentId: memories.agentId,
  updatedAt: memories.updatedAt,
  ...lifecycleColumns,
  projectName: projects.name,
  agentName: agents.name,
  agentAvatar: agents.avatar,
};

/**
 * Entries agents can read that no run has used since they were written `NEVER_USED_DAYS` ago, for manual
 * cleanup. Pinned entries are in every run's prompt, so they are left out.
 */
const neverUsed = () =>
  and(
    eq(memories.recallCount, 0),
    eq(memories.pinned, false),
    lt(memories.createdAt, sql`now() - make_interval(days => ${NEVER_USED_DAYS})`),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
  );

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

type MemoryOrigin = (typeof memoryOrigin.enumValues)[number];

/** Whether a query param names an origin. */
const isMemoryOrigin = (value: string | undefined): value is MemoryOrigin =>
  (memoryOrigin.enumValues as readonly string[]).includes(value ?? "");

/** `projectId` on the agent level that keeps only the agents' global memory (their craft), no project notes. */
export const AGENT_GLOBAL_ONLY = "global";

/**
 * Active entries of one level. Entries a newer one replaced are left out unless `history` asks for them
 * too; `neverUsed` keeps the current entries no run has used (see neverUsed). On the agent level
 * `projectId` keeps the agents' notes on that project, or their global memory (AGENT_GLOBAL_ONLY).
 */
export const listMemories = query(
  async (opts: {
    scope: MemoryScope;
    projectId?: string;
    agentId?: string;
    origin?: string;
    pinned?: boolean;
    history?: boolean;
    neverUsed?: boolean;
  }) => {
    const where: SQL[] = [eq(memories.scope, opts.scope), eq(memories.status, "active")];
    if (opts.scope !== "global" && isUuid(opts.projectId)) where.push(eq(memories.projectId, opts.projectId));
    if (opts.scope === "agent" && opts.projectId === AGENT_GLOBAL_ONLY) where.push(isNull(memories.projectId));
    if (opts.scope === "agent" && isUuid(opts.agentId)) where.push(eq(memories.agentId, opts.agentId));
    if (isMemoryOrigin(opts.origin)) where.push(eq(memories.origin, opts.origin));
    if (opts.pinned) where.push(eq(memories.pinned, true));
    if (opts.neverUsed) where.push(neverUsed()!);
    if (!opts.history || opts.neverUsed) where.push(isNull(memories.invalidatedAt));
    return db
      .select(memoryColumns)
      .from(memories)
      .leftJoin(projects, eq(projects.id, memories.projectId))
      .leftJoin(agents, eq(agents.id, memories.agentId))
      .where(and(...where))
      .orderBy(desc(memories.updatedAt))
      .limit(500);
  },
);

/**
 * Every entry of one agent or project, pending first: the memory tab on its page, which shows the
 * replaced ones on demand. An agent's: its global memory and its notes on each project (with the
 * project). A project's: the team memory, whose entries carry their author (the agent that wrote it;
 * none for the user's own), and every agent's notes on the project, with their agent.
 */
export const listOwnerMemories = query(async (owner: { agentId: string } | { projectId: string }) => {
  const where =
    "agentId" in owner
      ? and(eq(memories.scope, "agent"), eq(memories.agentId, owner.agentId))
      : and(inArray(memories.scope, ["project", "agent"]), eq(memories.projectId, owner.projectId));
  return db
    .select({
      id: memories.id,
      scope: memories.scope,
      content: memories.content,
      source: memories.source,
      origin: memories.origin,
      status: memories.status,
      pinned: memories.pinned,
      flagReason: memories.flagReason,
      updatedAt: memories.updatedAt,
      ...lifecycleColumns,
      projectId: memories.projectId,
      projectName: projects.name,
      agentId: memories.agentId,
      agentName: agents.name,
      agentAvatar: agents.avatar,
    })
    .from(memories)
    .leftJoin(projects, eq(projects.id, memories.projectId))
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

/** Entries per level as the lists show them: active ones a newer entry did not replace; and the pending ones. */
export const getMemoryCounts = query(async () => {
  const rows = await db
    .select({ scope: memories.scope, status: memories.status, n: count() })
    .from(memories)
    .where(or(eq(memories.status, "pending"), isNull(memories.invalidatedAt)))
    .groupBy(memories.scope, memories.status);
  const counts = { global: 0, project: 0, agent: 0, pending: 0 };
  for (const r of rows) {
    if (r.status === "pending") counts.pending += r.n;
    else counts[r.scope] += r.n;
  }
  return counts;
});

/** Hybrid search across every memory (all scopes and owners), keyword only without embeddings. */
export const getMemorySearchResults = query(async (search: string, limit: number = 20) => {
  const { mode, rows } = await searchAllMemories(search, limit);
  const projectIds = [...new Set(rows.flatMap((r) => (r.projectId ? [r.projectId] : [])))];
  const agentIds = [...new Set(rows.flatMap((r) => (r.agentId ? [r.agentId] : [])))];
  const [projectRows, agentRows] = await Promise.all([
    projectIds.length
      ? db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))
      : [],
    agentIds.length
      ? db
          .select({ id: agents.id, name: agents.name, avatar: agents.avatar })
          .from(agents)
          .where(inArray(agents.id, agentIds))
      : [],
  ]);
  const projectById = new Map(projectRows.map((p) => [p.id, p]));
  const agentById = new Map(agentRows.map((a) => [a.id, a]));
  return {
    mode,
    rows: rows.map((r) => {
      const agent = r.agentId ? agentById.get(r.agentId) : undefined;
      return {
        ...r,
        projectName: (r.projectId ? projectById.get(r.projectId)?.name : null) ?? null,
        agentName: agent?.name ?? null,
        agentAvatar: agent?.avatar ?? null,
      };
    }),
  };
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

/**
 * How much of the pinned budget the pinned entries every run of `owner` gets take: the global ones, plus
 * the owner's (none: global only).
 */
export const getPinnedUsage = query(async (owner?: { agentId: string } | { projectId: string }) =>
  pinnedUsage(owner ?? null, (await getSettings()).memoryPinnedTokens),
);
