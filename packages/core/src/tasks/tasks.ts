import {
  agents,
  db,
  runs,
  taskComments,
  taskDependencies,
  taskEvents,
  taskPullRequests,
  tasks,
  taskWakeups,
  type Tx,
} from "@abotica/db";
import { and, count, desc, eq, inArray, isNull, max, ne, sql } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { publish } from "../infra/events";
import { enqueueTaskEvent } from "../infra/queues";
import { claimFiles, fileIdsOwnedBy, removeFileBytes, type StoredFile } from "../files/files";
import type { RunFailureKind } from "../runs/run-failures";

export type Task = typeof tasks.$inferSelect;
export type TaskStatus = Task["status"];
export type TaskPriority = Task["priority"];

export const TASK_STATUSES: TaskStatus[] = ["backlog", "in_progress", "blocked", "review", "done"];
export const TASK_PRIORITIES: TaskPriority[] = ["low", "medium", "high", "urgent"];

type Queryable = typeof db | Tx;

async function emit(task: Task, event: "created" | "done") {
  await publish({ type: "task.updated", taskId: task.id, projectId: task.projectId });
  await enqueueTaskEvent({ taskId: task.id, event });
}

async function nextPosition(projectId: string | null, status: TaskStatus, q: Queryable = db): Promise<number> {
  const [row] = await q
    .select({ value: max(tasks.position) })
    .from(tasks)
    .where(and(projectId ? eq(tasks.projectId, projectId) : isNull(tasks.projectId), eq(tasks.status, status)));
  return (row?.value ?? 0) + 1024;
}

export async function createTask(
  input: {
    title: string;
    description?: string;
    projectId?: string | null;
    parentId?: string | null;
    status?: TaskStatus;
    priority?: TaskPriority;
    deadline?: Date | null;
    assigneeAgentId?: string | null;
    assignedToUser?: boolean;
    dependsOn?: string[];
    /** The run delegating the task; its conversation gets the result back. */
    delegatedByRunId?: string | null;
  },
  actor = "user",
): Promise<Task> {
  const status = input.status ?? "backlog";
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  // One transaction: a bad dependency must not leave behind a task that never starts.
  const task = await db.transaction(async (tx) => {
    if (dependsOn.length) {
      const found = await tx.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, dependsOn));
      if (found.length !== dependsOn.length) throw new UserError("tasks.errors.dependencyNotFound");
    }
    const [row] = await tx
      .insert(tasks)
      .values({
        title: input.title,
        description: input.description ?? "",
        projectId: input.projectId ?? null,
        parentId: input.parentId ?? null,
        status,
        priority: input.priority ?? "medium",
        deadline: input.deadline ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        assignedToUser: input.assignedToUser ?? false,
        position: await nextPosition(input.projectId ?? null, status, tx),
        createdBy: actor,
        delegatedByRunId: input.delegatedByRunId ?? null,
      })
      .returning();
    if (!row) throw new Error("Task insert failed");
    // Nothing depends on a new task yet, so its dependencies cannot close a cycle.
    if (dependsOn.length) {
      await tx.insert(taskDependencies).values(dependsOn.map((d) => ({ taskId: row.id, dependsOnTaskId: d })));
    }
    await tx.insert(taskEvents).values({ taskId: row.id, type: "created", actor, data: {} });
    return row;
  });
  await emit(task, "created");
  return task;
}

/** Dependencies of the task that are not done yet. */
export async function pendingDependencies(taskId: string, q: Queryable = db): Promise<{ id: string; title: string }[]> {
  return q
    .select({ id: tasks.id, title: tasks.title })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(and(eq(taskDependencies.taskId, taskId), ne(tasks.status, "done")));
}

/** A task starts only once everything it depends on is done. */
export async function assertTaskDependenciesDone(taskId: string, tx?: Tx): Promise<void> {
  const pending = await pendingDependencies(taskId, tx);
  if (pending.length) {
    throw new UserError("tasks.errors.pendingDependencies", { titles: pending.map((p) => p.title).join(", ") });
  }
}

/** Whether `taskId` depending on `dependsOnTaskId` closes a loop: `taskId` is among its dependencies, at any depth. */
export async function wouldCreateDependencyCycle(
  taskId: string,
  dependsOnTaskId: string,
  q: Queryable = db,
): Promise<boolean> {
  if (taskId === dependsOnTaskId) return true;
  // UNION (not UNION ALL) drops rows already reached, so a loop already in the table still ends the walk.
  const rows = await q.execute(sql`
    with recursive reached(id) as (
      select depends_on_task_id from task_dependencies where task_id = ${dependsOnTaskId}
      union
      select d.depends_on_task_id from task_dependencies d join reached r on d.task_id = r.id
    )
    select 1 from reached where id = ${taskId} limit 1`);
  return rows.length > 0;
}

/** Makes `taskId` wait for `dependsOnTaskId`; refuses missing tasks and loops. */
export async function addTaskDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
  if (taskId === dependsOnTaskId) throw new UserError("tasks.errors.selfDependency");
  await db.transaction(async (tx) => {
    // Serializes dependency writes, so two opposite links added at once cannot both pass the check.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('task_dependencies'))`);
    const found = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.id, [taskId, dependsOnTaskId]));
    if (found.length !== 2) throw new UserError("tasks.errors.notFound");
    if (await wouldCreateDependencyCycle(taskId, dependsOnTaskId, tx)) {
      throw new UserError("tasks.errors.circularDependency");
    }
    await tx.insert(taskDependencies).values({ taskId, dependsOnTaskId }).onConflictDoNothing();
  });
}

/**
 * Whether tasks delegated from this conversation are still to be reported to it. A task run that
 * handed work on is not finished when its turn ends: it continues when the report arrives.
 */
export async function awaitsDelegatedWork(conversationId: string | null): Promise<boolean> {
  if (!conversationId) return false;
  const [open] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(runs, eq(runs.id, tasks.delegatedByRunId))
    .where(and(eq(runs.conversationId, conversationId), isNull(tasks.reportedAt)))
    .limit(1);
  return Boolean(open);
}

/** Whether the task waits for a wakeup (task_wait): a run of it that ends stays in progress until one fires. */
export async function awaitsWakeup(taskId: string): Promise<boolean> {
  const [active] = await db
    .select({ id: taskWakeups.id })
    .from(taskWakeups)
    .where(and(eq(taskWakeups.taskId, taskId), eq(taskWakeups.status, "active")))
    .limit(1);
  return Boolean(active);
}

/** Run statuses that still work on their task: a run waiting for an approval continues once it is decided. */
const ACTIVE_TASK_RUN_STATUSES = ["queued", "running", "waiting_approval"] as const;

/** The task's unfinished run, if any. */
export async function activeTaskRun(taskId: string): Promise<{ id: string } | undefined> {
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), inArray(runs.status, [...ACTIVE_TASK_RUN_STATUSES])))
    .limit(1);
  return run;
}

/** Raised by startRun when the task already has a queued or running run. */
export class TaskBusyError extends UserError {
  constructor(readonly taskId: string) {
    super("tasks.errors.alreadyRunning");
  }
}

/** Counted failed runs in a row after which a task's runs no longer start on their own. */
export const CIRCUIT_BREAKER_FAILURES = 3;
/** Failures of the setup (key, provider, model): the next run fails the same way, so one is enough. */
const SETUP_FAILURES = new Set<RunFailureKind>(["provider_auth", "provider_not_allowed", "no_model"]);
/** Failures that say nothing about the task or its setup: passing, or the user's own stop. */
const UNCOUNTED_FAILURES = new Set<RunFailureKind>([
  "rate_limited",
  "worker_restarted",
  "unqueued",
  "overdue",
  "cancelled_by_user",
  "kill_switch",
]);
/** Recent runs the breaker looks at; an open breaker is never more than a few runs back. */
const STREAK_WINDOW = 20;

type RunOutcome = Pick<typeof runs.$inferSelect, "agentId" | "status" | "failureKind" | "error">;

/** A task's recent failed runs: `open` while its runs must not start on their own. */
export type FailureStreak = { failures: number; reason: string | null; open: boolean };

type Streak = FailureStreak & { setup: boolean };
const NO_FAILURES: Streak = { failures: 0, reason: null, open: false, setup: false };

/** One run's effect on the streak before it: null when it changes nothing. */
function nextStreak(streak: Streak, run: RunOutcome): Streak | null {
  if (run.status === "succeeded") return NO_FAILURES;
  // A cancel is someone's decision (the user's or a manager's), not a failure of the task.
  if (run.status !== "failed") return null;
  if (!run.failureKind || UNCOUNTED_FAILURES.has(run.failureKind)) return null;
  const failures = streak.failures + 1;
  const setup = SETUP_FAILURES.has(run.failureKind);
  return { failures, reason: run.error, setup, open: setup || failures >= CIRCUIT_BREAKER_FAILURES };
}

/**
 * The circuit breaker of a task, from its runs oldest first. Failed runs of the current assignee count
 * in a row; a success resets them, while transient failures, the user's stops and runs from before
 * failure kinds were recorded are skipped. The breaker also resets when the assignee changes (only the
 * current one's runs count) and when a run starts while it is open, which only the user does.
 */
export function failureStreak(history: RunOutcome[], assigneeAgentId: string | null): FailureStreak {
  let streak = NO_FAILURES;
  for (const run of history) {
    if (run.agentId !== assigneeAgentId) {
      streak = NO_FAILURES;
      continue;
    }
    // A run started while the breaker was open was forced: it begins a new streak.
    if (streak.open) streak = NO_FAILURES;
    streak = nextStreak(streak, run) ?? streak;
  }
  return { failures: streak.failures, reason: streak.reason, open: streak.open };
}

/** The task's circuit breaker now (see failureStreak); closed for a task that does not exist. */
export async function taskFailureStreak(taskId: string): Promise<FailureStreak> {
  const [task] = await db.select({ assigneeAgentId: tasks.assigneeAgentId }).from(tasks).where(eq(tasks.id, taskId));
  if (!task) return { failures: 0, reason: null, open: false };
  const recent = await db
    .select({ agentId: runs.agentId, status: runs.status, failureKind: runs.failureKind, error: runs.error })
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt))
    .limit(STREAK_WINDOW);
  return failureStreak(recent.reverse(), task.assigneeAgentId);
}

/**
 * Raised by startTaskRun when the task's circuit breaker is open: its runs keep failing, so delegations
 * and dependents no longer start it. The user still can.
 */
export class TaskCircuitOpenError extends UserError {
  constructor(
    readonly taskId: string,
    readonly streak: FailureStreak,
  ) {
    super("tasks.errors.circuitOpen", { failures: streak.failures, reason: streak.reason ?? "-" });
  }
}

/**
 * The user started the task: with a person in between, its pull requests get their automatic fix
 * rounds back (pull-requests.ts), as those count only the wake-ups no one stepped into.
 */
export async function resetFixRounds(taskId: string): Promise<void> {
  await db.update(taskPullRequests).set({ fixRounds: 0 }).where(eq(taskPullRequests.taskId, taskId));
}

/** Column values are equal; dates (the deadline) compare by time, since each read makes a new Date. */
function sameValue(a: unknown, b: unknown): boolean {
  return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
}

/** Whether starting a run failed because the task already has one queued or running (runs_one_active_per_task). */
export function isActiveTaskRunConflict(error: unknown): boolean {
  for (
    let e = error as { code?: string; constraint_name?: string; cause?: unknown } | undefined;
    e;
    e = e.cause as typeof e
  ) {
    if (e instanceof TaskBusyError) return true;
    if (e.code === "23505" && e.constraint_name === "runs_one_active_per_task") return true;
  }
  return false;
}

export async function updateTask(
  id: string,
  patch: Partial<
    Pick<
      Task,
      | "title"
      | "description"
      | "status"
      | "priority"
      | "deadline"
      | "assigneeAgentId"
      | "assignedToUser"
      | "position"
      | "output"
      | "projectId"
    >
  >,
  actor = "user",
): Promise<Task> {
  const [before] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!before) throw new Error(`Task ${id} not found`);

  const values: Partial<Task> = { ...patch };
  if (patch.status && patch.status !== before.status) {
    values.completedAt = patch.status === "done" ? new Date() : null;
    if (patch.position === undefined) values.position = await nextPosition(before.projectId, patch.status);
  }
  const [task] = await db.update(tasks).set(values).where(eq(tasks.id, id)).returning();
  if (!task) throw new Error(`Task ${id} not found`);

  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
    if (key !== "position" && !sameValue(before[key], task[key])) changes[key] = { from: before[key], to: task[key] };
  }
  if (Object.keys(changes).length) {
    await db.insert(taskEvents).values({ taskId: id, type: "updated", actor, data: changes });
  }
  if (task.status === "done" && before.status !== "done") await emit(task, "done");
  else {
    await publish({ type: "task.updated", taskId: task.id, projectId: task.projectId });
    // Tasks may wait for this one to reach a status (task_status wakeups).
    if (task.status !== before.status) await enqueueTaskEvent({ taskId: id, event: "status" });
  }
  return task;
}

/** Who writes a comment: the user, an agent, or the platform itself (e.g. a note about a failed run). */
type CommentAuthor = "user" | "system" | { agentId: string };

export async function addTaskComment(taskId: string, body: string, author: CommentAuthor) {
  const [comment] = await db
    .insert(taskComments)
    .values(
      typeof author === "string"
        ? { taskId, body, authorKind: author }
        : { taskId, body, authorKind: "agent", authorAgentId: author.agentId },
    )
    .returning();
  await publish({ type: "task.updated", taskId, projectId: null });
  return comment!;
}

/** The task and all its subtasks, at any depth. */
async function taskTreeIds(rootId: string): Promise<string[]> {
  const ids = [rootId];
  for (let level = [rootId]; level.length;) {
    level = (await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.parentId, level))).map((t) => t.id);
    ids.push(...level);
  }
  return ids;
}

/** Gives the user's pending uploads to a task; its agent finds them in the workspace's inputs. */
export async function attachTaskFiles(taskId: string, fileIds: string[]): Promise<StoredFile[]> {
  if (!fileIds.length) throw new UserError("files.errors.noFiles");
  const [task] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new UserError("tasks.errors.notFound");
  return claimFiles(fileIds, { taskId });
}

/** Deletes a task with its subtasks (the database cascades them) and their files. */
export async function deleteTask(id: string): Promise<Task | null> {
  const fileIds = await fileIdsOwnedBy({ taskIds: await taskTreeIds(id) });
  const [task] = await db.delete(tasks).where(eq(tasks.id, id)).returning();
  if (!task) return null;
  await removeFileBytes(fileIds);
  await publish({ type: "task.updated", taskId: id, projectId: task.projectId });
  return task;
}

/** Tasks whose dependencies are all done; used to decide what can start. */
export async function unblockedDependents(taskId: string): Promise<Task[]> {
  const dependents = await db
    .select({ id: taskDependencies.taskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.dependsOnTaskId, taskId));
  if (!dependents.length) return [];
  const ids = dependents.map((d) => d.id);
  const pending = await db
    .select({ taskId: taskDependencies.taskId })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(and(inArray(taskDependencies.taskId, ids), ne(tasks.status, "done")));
  const blocked = new Set(pending.map((p) => p.taskId));
  const ready = ids.filter((id) => !blocked.has(id));
  if (!ready.length) return [];
  return db.select().from(tasks).where(inArray(tasks.id, ready)).orderBy(desc(tasks.priority));
}

/** How many tasks are in each status; statuses without tasks are left out. */
export async function countTasksByStatus(): Promise<Partial<Record<TaskStatus, number>>> {
  const rows = await db.select({ status: tasks.status, count: count() }).from(tasks).groupBy(tasks.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

/** Most recently updated tasks that are not done, with the assigned agent's name. */
export async function listOpenTasks(limit: number) {
  return db
    .select({ title: tasks.title, status: tasks.status, priority: tasks.priority, agent: agents.name })
    .from(tasks)
    .leftJoin(agents, eq(agents.id, tasks.assigneeAgentId))
    .where(ne(tasks.status, "done"))
    .orderBy(desc(tasks.updatedAt))
    .limit(limit);
}
