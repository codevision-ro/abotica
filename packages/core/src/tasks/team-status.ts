/**
 * A snapshot of the open work in projects (team_status): who does what, how far it is and what each task
 * waits for. The super agent sees every project, a manager the ones it leads; content of projects closed
 * to the reader's models is withheld by the tool.
 */
import { agents, db, runs, taskComments, taskDependencies, tasks, taskWakeups } from "@abotica/db";
import { aliasedTable, and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "@abotica/db/orm";
import { getSettings } from "../settings/settings";
import type { Task, TaskPriority, TaskStatus } from "./tasks";

/** What keeps a task from moving now. */
export type TaskWaitingFor =
  | { kind: "dependencies"; taskIds: string[] }
  | { kind: "slot" }
  | { kind: "answer"; questionIds: string[] }
  | { kind: "wakeup" }
  | { kind: "paused"; forTaskId: string | null }
  | { kind: "retry"; at: Date }
  | { kind: "continuation"; done: number; of: number };

export type TeamStatusTask = {
  id: string;
  title: string;
  projectId: string | null;
  /** The assignee's slug; null for the user or nobody. */
  assignee: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  deadline: Date | null;
  /** Minutes past the deadline; null when it has none or is not late. */
  lateByMinutes: number | null;
  activeRun: { id: string; steps: number; startedAt: Date | null } | null;
  lastProgress: { text: string; at: Date } | null;
  /** Open questions about the task: to whom (a slug, or "user") and since when. */
  openQuestions: { id: string; to: string; since: Date }[];
  waitingFor: TaskWaitingFor[];
  /** Subtasks whose result has not come back yet. */
  unreportedSubtasks: number;
};

/** Tasks in one snapshot at most, the most urgent first: a tool result must stay readable. */
export const TEAM_STATUS_LIMIT = 100;

const OVER: TaskStatus[] = ["done", "cancelled"];

/** Minutes the task is past its deadline, or null. Done work is never late. */
export function lateByMinutes(task: Pick<Task, "deadline" | "status">, now: Date): number | null {
  if (!task.deadline || OVER.includes(task.status)) return null;
  const late = Math.floor((now.getTime() - task.deadline.getTime()) / 60_000);
  return late > 0 ? late : null;
}

/** What the platform knows the task waits for, besides its own row. */
export type WaitingFacts = {
  pendingDependencies: string[];
  openQuestions: string[];
  activeWakeup: boolean;
  retryAt: Date | null;
  hasActiveRun: boolean;
};

/**
 * What keeps the task from moving now, from its row and the facts around it. A continuation shows on an
 * open task that already went on after a step or time limit.
 */
export function waitingFor(
  task: Pick<Task, "status" | "waitingForSlotSince" | "pausedForTaskId" | "continuations">,
  facts: WaitingFacts,
  maxContinuations: number,
): TaskWaitingFor[] {
  if (OVER.includes(task.status)) return [];
  const out: TaskWaitingFor[] = [];
  if (task.status === "paused") out.push({ kind: "paused", forTaskId: task.pausedForTaskId });
  if (facts.pendingDependencies.length) out.push({ kind: "dependencies", taskIds: facts.pendingDependencies });
  if (task.waitingForSlotSince) out.push({ kind: "slot" });
  if (facts.openQuestions.length) out.push({ kind: "answer", questionIds: facts.openQuestions });
  if (facts.activeWakeup && !facts.hasActiveRun) out.push({ kind: "wakeup" });
  if (facts.retryAt) out.push({ kind: "retry", at: facts.retryAt });
  if (task.continuations > 0 && task.status === "in_progress") {
    out.push({ kind: "continuation", done: task.continuations, of: maxContinuations });
  }
  return out;
}

/** The open tasks (done and cancelled ones too with `includeDone`) of the projects, or of every project. */
export async function teamStatus(
  scope: { projectIds?: string[] },
  opts: { includeDone?: boolean } = {},
): Promise<TeamStatusTask[]> {
  if (scope.projectIds && !scope.projectIds.length) return [];
  const rows = await db
    .select({ task: tasks, assignee: agents.slug })
    .from(tasks)
    .leftJoin(agents, eq(agents.id, tasks.assigneeAgentId))
    .where(
      and(
        scope.projectIds ? inArray(tasks.projectId, scope.projectIds) : undefined,
        opts.includeDone ? undefined : notInArray(tasks.status, OVER),
      ),
    )
    // The enum is ordered low < medium < high < urgent.
    .orderBy(desc(tasks.priority), sql`${tasks.deadline} asc nulls last`, asc(tasks.createdAt))
    .limit(TEAM_STATUS_LIMIT);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.task.id);
  const addressee = aliasedTable(agents, "addressee");
  const dependency = aliasedTable(tasks, "dependency");
  const subtask = aliasedTable(tasks, "subtask");

  const [settings, active, progress, questions, dependencies, wakeups, retries, subtasks] = await Promise.all([
    getSettings(),
    db
      .select({ taskId: runs.taskId, id: runs.id, steps: runs.steps, startedAt: runs.startedAt })
      .from(runs)
      .where(and(inArray(runs.taskId, ids), inArray(runs.status, ["queued", "running", "waiting_approval"]))),
    db
      .selectDistinctOn([taskComments.taskId], {
        taskId: taskComments.taskId,
        text: taskComments.body,
        at: taskComments.createdAt,
      })
      .from(taskComments)
      .where(and(inArray(taskComments.taskId, ids), eq(taskComments.kind, "progress")))
      .orderBy(taskComments.taskId, desc(taskComments.createdAt)),
    db
      .select({
        taskId: taskComments.taskId,
        id: taskComments.id,
        to: addressee.slug,
        toUser: taskComments.addressedToUser,
        since: taskComments.createdAt,
      })
      .from(taskComments)
      .leftJoin(addressee, eq(addressee.id, taskComments.addresseeAgentId))
      .where(
        and(inArray(taskComments.taskId, ids), eq(taskComments.kind, "question"), eq(taskComments.questionStatus, "open")),
      )
      .orderBy(asc(taskComments.createdAt)),
    db
      .select({ taskId: taskDependencies.taskId, id: dependency.id })
      .from(taskDependencies)
      .innerJoin(dependency, eq(dependency.id, taskDependencies.dependsOnTaskId))
      .where(and(inArray(taskDependencies.taskId, ids), ne(dependency.status, "done"))),
    db
      .selectDistinct({ taskId: taskWakeups.taskId })
      .from(taskWakeups)
      .where(and(inArray(taskWakeups.taskId, ids), eq(taskWakeups.status, "active"))),
    db
      .select({ taskId: runs.taskId, at: runs.retryAt })
      .from(runs)
      .where(and(inArray(runs.taskId, ids), isNotNull(runs.retryAt), isNull(runs.retriedByRunId))),
    // Delegated by one of the task's runs and not reported back yet.
    db
      .select({ taskId: runs.taskId, open: count() })
      .from(subtask)
      .innerJoin(runs, eq(runs.id, subtask.delegatedByRunId))
      .where(and(inArray(runs.taskId, ids), isNull(subtask.reportedAt)))
      .groupBy(runs.taskId),
  ]);

  const now = new Date();
  return rows.map(({ task, assignee }) => {
    const run = active.find((r) => r.taskId === task.id);
    const progressed = progress.find((p) => p.taskId === task.id);
    const open = questions.filter((q) => q.taskId === task.id);
    const facts: WaitingFacts = {
      pendingDependencies: dependencies.filter((d) => d.taskId === task.id).map((d) => d.id),
      openQuestions: open.map((q) => q.id),
      activeWakeup: wakeups.some((w) => w.taskId === task.id),
      retryAt: retries.find((r) => r.taskId === task.id)?.at ?? null,
      hasActiveRun: Boolean(run),
    };
    return {
      id: task.id,
      title: task.title,
      projectId: task.projectId,
      assignee,
      status: task.status,
      priority: task.priority,
      deadline: task.deadline,
      lateByMinutes: lateByMinutes(task, now),
      activeRun: run ? { id: run.id, steps: run.steps, startedAt: run.startedAt } : null,
      lastProgress: progressed ? { text: progressed.text, at: progressed.at } : null,
      openQuestions: open.map((q) => ({ id: q.id, to: q.toUser || !q.to ? "user" : q.to, since: q.since })),
      waitingFor: waitingFor(task, facts, settings.agents.maxContinuations),
      unreportedSubtasks: subtasks.find((s) => s.taskId === task.id)?.open ?? 0,
    };
  });
}
