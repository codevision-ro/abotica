import "server-only";
import { listFiles, TASK_PRIORITIES, type TaskPriority } from "@abotica/core";
import { agents, db, projects, runs, tasks } from "@abotica/db";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, ne, or, sql, type SQL } from "@abotica/db/orm";
import { isUuid } from "@/lib/uuid";
import { query } from "@/server/query";

const DONE_WINDOW_DAYS = 14;

type TaskFilters = {
  q?: string;
  project?: string;
  assignee?: string;
  priority?: string;
  showAllDone?: boolean;
};

export type BoardTask = Awaited<ReturnType<typeof listBoardTasks>>[number];
export type TaskOptions = Awaited<ReturnType<typeof getTaskOptions>>;
export type TaskDetailData = NonNullable<Awaited<ReturnType<typeof getTaskDetail>>>;

/** Top-level tasks for the board and list views, with the counters shown on cards. */
export const listBoardTasks = query(async (filters: TaskFilters) => {
  const conds: SQL[] = [isNull(tasks.parentId)];
  if (filters.q?.trim()) conds.push(ilike(tasks.title, `%${filters.q.trim()}%`));
  if (isUuid(filters.project)) conds.push(eq(tasks.projectId, filters.project));
  if (isUuid(filters.assignee)) conds.push(eq(tasks.assigneeAgentId, filters.assignee));
  if (filters.priority && (TASK_PRIORITIES as string[]).includes(filters.priority)) {
    conds.push(eq(tasks.priority, filters.priority as TaskPriority));
  }
  if (!filters.showAllDone) {
    const cutoff = new Date(Date.now() - DONE_WINDOW_DAYS * 86_400_000);
    conds.push(or(ne(tasks.status, "done"), isNull(tasks.completedAt), gte(tasks.completedAt, cutoff))!);
  }

  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      position: tasks.position,
      deadline: tasks.deadline,
      completedAt: tasks.completedAt,
      assignedToUser: tasks.assignedToUser,
      projectId: tasks.projectId,
      projectName: projects.name,
      agentId: agents.id,
      agentName: agents.name,
      agentAvatar: agents.avatar,
      subtaskTotal: sql<number>`(select count(*)::int from tasks s where s.parent_id = ${tasks.id})`,
      subtaskDone: sql<number>`(select count(*)::int from tasks s where s.parent_id = ${tasks.id} and s.status = 'done')`,
      commentCount: sql<number>`(select count(*)::int from task_comments c where c.task_id = ${tasks.id})`,
      hasActiveRun: sql<boolean>`exists(select 1 from runs r where r.task_id = ${tasks.id} and r.status in ('queued', 'running', 'waiting_approval'))`,
    })
    .from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(agents, eq(agents.id, tasks.assigneeAgentId))
    .where(and(...conds))
    .orderBy(asc(tasks.position), asc(tasks.createdAt));
});

/** Data for selects: projects, agents and open tasks (for dependencies and parent). */
export const getTaskOptions = query(async () => {
  const [projectRows, agentRows, openTasks] = await Promise.all([
    db.select({ id: projects.id, name: projects.name }).from(projects).orderBy(asc(projects.name)),
    db
      .select({
        id: agents.id,
        slug: agents.slug,
        name: agents.name,
        avatar: agents.avatar,
        assignable: sql<boolean>`${agents.enabled} and not ${agents.isTemplate}`,
      })
      .from(agents)
      .orderBy(desc(agents.isOrchestrator), asc(agents.name)),
    db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, parentId: tasks.parentId })
      .from(tasks)
      .where(ne(tasks.status, "done"))
      .orderBy(desc(tasks.createdAt))
      .limit(500),
  ]);
  return { projects: projectRows, agents: agentRows, openTasks };
});

export const getTaskDetail = query(async (id: string) => {
  if (!isUuid(id)) return null;
  const task = await db.query.tasks.findFirst({
    where: (t, { eq }) => eq(t.id, id),
    with: {
      project: { columns: { id: true, name: true } },
      assignee: { columns: { id: true, name: true, slug: true, avatar: true } },
      parent: { columns: { id: true, title: true, status: true } },
      subtasks: {
        columns: { id: true, title: true, status: true, priority: true },
        with: { assignee: { columns: { id: true, name: true, avatar: true } } },
        orderBy: (s, { asc }) => [asc(s.createdAt)],
      },
      dependencies: { with: { dependsOn: { columns: { id: true, title: true, status: true } } } },
      comments: {
        with: { author: { columns: { id: true, name: true, slug: true, avatar: true } } },
        orderBy: (c, { asc }) => [asc(c.createdAt)],
      },
      events: { orderBy: (e, { asc }) => [asc(e.createdAt)] },
    },
  });
  if (!task) return null;

  const [taskRuns, taskFiles] = await Promise.all([
    db
      .select({
        id: runs.id,
        status: runs.status,
        trigger: runs.trigger,
        costUsd: runs.costUsd,
        createdAt: runs.createdAt,
        agentName: agents.name,
        agentAvatar: agents.avatar,
      })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .where(eq(runs.taskId, id))
      .orderBy(desc(runs.createdAt))
      .limit(50),
    listFiles({ taskId: id }),
  ]);
  // Who added each file: the user, or the agent that produced it.
  const agentIds = [...new Set(taskFiles.flatMap((f) => (f.agentId ? [f.agentId] : [])))];
  const agentRows = agentIds.length
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
    : [];
  const agentNames = new Map(agentRows.map((a) => [a.id, a.name]));
  const files = taskFiles.map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    source: f.source,
    agentName: f.agentId ? (agentNames.get(f.agentId) ?? null) : null,
    createdAt: f.createdAt,
  }));

  return { ...task, runs: taskRuns, files };
});
