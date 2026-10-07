import "server-only";
import { agents, approvals, conversations, db, projects, runEvents, runs, tasks } from "@abotica/db";
import { and, asc, count, desc, eq, ne, sql, type SQL } from "@abotica/db/orm";
import { isUuid } from "@/lib/uuid";
import { query } from "@/server/query";

export const RUNS_PAGE_SIZE = 50;

const RUN_STATUSES = ["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled"] as const;
const RUN_TRIGGERS = ["chat", "telegram", "task", "schedule", "webhook", "event", "delegation", "system"] as const;

type RunStatus = (typeof RUN_STATUSES)[number];
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

type RunFilters = {
  status?: string;
  agent?: string;
  trigger?: string;
  project?: string;
  page?: number;
};

/** Columns needed by every run row in lists (dashboard, runs table). */
export const runRowColumns = {
  id: runs.id,
  status: runs.status,
  trigger: runs.trigger,
  provider: runs.provider,
  model: runs.model,
  steps: runs.steps,
  inputTokens: runs.inputTokens,
  outputTokens: runs.outputTokens,
  costUsd: runs.costUsd,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
  createdAt: runs.createdAt,
  agentId: runs.agentId,
  agentName: agents.name,
  agentAvatar: agents.avatar,
  projectId: runs.projectId,
  projectName: projects.name,
};

export const getRunPage = query(async (filters: RunFilters) => {
  const where: SQL[] = [];
  if (filters.status && (RUN_STATUSES as readonly string[]).includes(filters.status)) {
    where.push(eq(runs.status, filters.status as RunStatus));
  }
  if (filters.trigger && (RUN_TRIGGERS as readonly string[]).includes(filters.trigger)) {
    where.push(eq(runs.trigger, filters.trigger as RunTrigger));
  }
  if (isUuid(filters.agent)) where.push(eq(runs.agentId, filters.agent));
  if (isUuid(filters.project)) where.push(eq(runs.projectId, filters.project));
  const condition = where.length ? and(...where) : undefined;
  const page = Math.max(1, filters.page ?? 1);

  const [rows, [total]] = await Promise.all([
    db
      .select(runRowColumns)
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(projects, eq(projects.id, runs.projectId))
      .where(condition)
      .orderBy(desc(runs.createdAt))
      .limit(RUNS_PAGE_SIZE)
      .offset((page - 1) * RUNS_PAGE_SIZE),
    db.select({ n: count() }).from(runs).where(condition),
  ]);
  return { rows, total: total?.n ?? 0, page, pageCount: Math.max(1, Math.ceil((total?.n ?? 0) / RUNS_PAGE_SIZE)) };
});

export type RunRow = Awaited<ReturnType<typeof getRunPage>>["rows"][number];

export const getRunFilterOptions = query(async () => {
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

export const getRunDetail = query(async (id: string) => {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select({
      run: runs,
      agent: { id: agents.id, name: agents.name, avatar: agents.avatar, slug: agents.slug },
      project: { id: projects.id, name: projects.name },
      task: { id: tasks.id, title: tasks.title },
      conversation: { id: conversations.id, title: conversations.title, channel: conversations.channel },
    })
    .from(runs)
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .leftJoin(conversations, eq(conversations.id, runs.conversationId))
    .where(eq(runs.id, id));
  if (!row) return null;

  const [events, runApprovals, children, parent] = await Promise.all([
    db.select().from(runEvents).where(eq(runEvents.runId, id)).orderBy(asc(runEvents.id)),
    db.select().from(approvals).where(eq(approvals.runId, id)).orderBy(asc(approvals.createdAt)),
    db
      .select(runRowColumns)
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(projects, eq(projects.id, runs.projectId))
      .where(eq(runs.parentRunId, id))
      .orderBy(asc(runs.createdAt)),
    row.run.parentRunId
      ? db
          .select({ id: runs.id, status: runs.status, agentName: agents.name, agentAvatar: agents.avatar })
          .from(runs)
          .leftJoin(agents, eq(agents.id, runs.agentId))
          .where(eq(runs.id, row.run.parentRunId))
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  return { ...row, events, approvals: runApprovals, children, parent };
});

export const listApprovalHistory = query(async (limit: number = 100) => {
  return db
    .select({
      id: approvals.id,
      runId: approvals.runId,
      toolName: approvals.toolName,
      status: approvals.status,
      reason: approvals.reason,
      decidedAt: approvals.decidedAt,
      createdAt: approvals.createdAt,
      agentName: agents.name,
      agentAvatar: agents.avatar,
    })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .where(ne(approvals.status, "pending"))
    .orderBy(desc(sql`coalesce(${approvals.decidedAt}, ${approvals.createdAt})`))
    .limit(limit);
});
