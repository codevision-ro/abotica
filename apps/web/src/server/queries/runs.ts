import "server-only";
import { agents, approvals, conversations, db, projects, runEvents, runs, runStatus, runTrigger, tasks } from "@abotica/db";
import { and, asc, count, desc, eq, ne, sql, type SQL } from "@abotica/db/orm";
import { isUuid } from "@/lib/uuid";
import { listProjectOptions } from "./projects";
import { query } from "@/server/query";

export const RUNS_PAGE_SIZE = 50;

type RunStatus = (typeof runStatus.enumValues)[number];
type RunTrigger = (typeof runTrigger.enumValues)[number];

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

/** Run rows with their agent and project, as the lists show them. */
const selectRunRows = () =>
  db
    .select(runRowColumns)
    .from(runs)
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(projects, eq(projects.id, runs.projectId));

export const getRunPage = query(async (filters: RunFilters) => {
  const where: SQL[] = [];
  if (filters.status && (runStatus.enumValues as readonly string[]).includes(filters.status)) {
    where.push(eq(runs.status, filters.status as RunStatus));
  }
  if (filters.trigger && (runTrigger.enumValues as readonly string[]).includes(filters.trigger)) {
    where.push(eq(runs.trigger, filters.trigger as RunTrigger));
  }
  if (isUuid(filters.agent)) where.push(eq(runs.agentId, filters.agent));
  if (isUuid(filters.project)) where.push(eq(runs.projectId, filters.project));
  const condition = where.length ? and(...where) : undefined;
  const page = Math.max(1, filters.page ?? 1);

  const [rows, [total]] = await Promise.all([
    selectRunRows()
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
    listProjectOptions(),
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
    selectRunRows().where(eq(runs.parentRunId, id)).orderBy(asc(runs.createdAt)),
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

export const APPROVALS_PAGE_SIZE = 50;

/** One page of the decided approvals, the latest decision first. */
export const getApprovalHistoryPage = query(async (page: number = 1) => {
  const p = Math.max(1, page);
  const decided = ne(approvals.status, "pending");
  const [rows, [total]] = await Promise.all([
    db
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
      .where(decided)
      .orderBy(desc(sql`coalesce(${approvals.decidedAt}, ${approvals.createdAt})`), desc(approvals.id))
      .limit(APPROVALS_PAGE_SIZE)
      .offset((p - 1) * APPROVALS_PAGE_SIZE),
    db.select({ n: count() }).from(approvals).where(decided),
  ]);
  return { rows, total: total?.n ?? 0, page: p };
});
