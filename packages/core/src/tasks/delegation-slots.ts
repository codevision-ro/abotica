import { agents, db, runs, tasks } from "@abotica/db";
import { and, asc, count, eq, inArray, isNotNull, isNull, notExists, or } from "@abotica/db/orm";
import { getTranslator, isUserError, translateKey, UserError } from "@abotica/i18n";
import { withLock } from "../infra/redis";
import { getSettings, settingsLocale } from "../platform/settings";
import { type Run, startTaskRun } from "../runs/runs";
import { addTaskComment, isActiveTaskRunConflict, type Task, updateTask } from "./tasks";

/**
 * Places for delegated work. The tasks delegated from one conversation run at most
 * `parallelDelegations` at a time, so a round of delegations cannot spend a plan's limit at once. A
 * place is held by a queued or running run of one of them. A task delegated while every place is taken
 * waits in the backlog (tasks.waitingForSlotSince) and starts, oldest first, once one frees up: when a
 * run of the conversation's delegated tasks ends (reportDelegatedTasks), or from the reaper. Decisions
 * for one conversation are taken under a lock, so two of them at once cannot give out the same place.
 */

/** Free places, never below zero: lowering the setting leaves the runs going and only holds new starts. */
export const freePlaces = (limit: number, busy: number): number => Math.max(0, limit - busy);

const lockKey = (conversationId: string) => `abotica:conv:${conversationId}:delegation-slots`;

/** The runs of a conversation; the tasks they delegated share its places. */
const runsOf = (conversationId: string) =>
  db.select({ id: runs.id }).from(runs).where(eq(runs.conversationId, conversationId));

/** Places taken in the conversation. */
async function busyPlaces(conversationId: string): Promise<number> {
  const [row] = await db
    .select({ busy: count() })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(inArray(runs.status, ["queued", "running"]), inArray(tasks.delegatedByRunId, runsOf(conversationId))));
  return row?.busy ?? 0;
}

/** The conversation whose places a task takes: the one of the run that delegated it. */
async function delegatingConversation(taskId: string): Promise<string | null> {
  const [row] = await db
    .select({ conversationId: runs.conversationId })
    .from(tasks)
    .innerJoin(runs, eq(runs.id, tasks.delegatedByRunId))
    .where(eq(tasks.id, taskId));
  return row?.conversationId ?? null;
}

/**
 * Starts a delegated task when its conversation has a free place; otherwise it waits for one, in the
 * backlog, and this returns null. A task no conversation delegated has no places to share: it starts.
 * startTaskRun's refusals reach the caller as they are.
 */
export async function startDelegatedTask(taskId: string, opts: { parentRunId?: string | null } = {}): Promise<Run | null> {
  const conversationId = await delegatingConversation(taskId);
  if (!conversationId) return startTaskRun(taskId, opts);
  return withLock(lockKey(conversationId), async () => {
    const { parallelDelegations } = await getSettings();
    if (freePlaces(parallelDelegations, await busyPlaces(conversationId))) return startTaskRun(taskId, opts);
    await db.update(tasks).set({ waitingForSlotSince: new Date() }).where(eq(tasks.id, taskId));
    await updateTask(taskId, { status: "backlog" }, "system");
    return null;
  });
}

/**
 * Takes the oldest task waiting for a place in the conversation, or one whose delegating conversation
 * is gone (`conversationId` null). Clearing the mark is the claim: a task is taken once, however many
 * look at the same time.
 */
async function claimOldestWaiting(conversationId: string | null): Promise<Task | null> {
  const delegatedThere = conversationId
    ? inArray(tasks.delegatedByRunId, runsOf(conversationId))
    : or(
        isNull(tasks.delegatedByRunId),
        notExists(
          db
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.id, tasks.delegatedByRunId), isNotNull(runs.conversationId))),
        ),
      );
  const oldest = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(isNotNull(tasks.waitingForSlotSince), delegatedThere))
    .orderBy(asc(tasks.waitingForSlotSince))
    .limit(1)
    .for("update", { skipLocked: true });
  const [task] = await db
    .update(tasks)
    .set({ waitingForSlotSince: null })
    .where(and(inArray(tasks.id, oldest), isNotNull(tasks.waitingForSlotSince)))
    .returning();
  return task ?? null;
}

/** A disabled assignee's run would only fail in the worker; the task is blocked before that. */
async function assertAssigneeEnabled(task: Task): Promise<void> {
  if (!task.assigneeAgentId) return; // startTaskRun refuses it with its own reason
  const [agent] = await db
    .select({ slug: agents.slug, enabled: agents.enabled })
    .from(agents)
    .where(eq(agents.id, task.assigneeAgentId));
  if (agent && !agent.enabled) throw new UserError("errors.run.agentDisabled", { agent: agent.slug });
}

/** What came of a claimed task: started here, started by the user meanwhile (`taken`), or neither. */
type StartOutcome = "started" | "taken" | "not-started";

/**
 * Starts a claimed task. One that cannot start (its runs keep failing, its assignee is gone or
 * disabled, it waits for dependencies again) is blocked with the reason, so its round settles and is
 * reported instead of waiting forever.
 */
async function startClaimed(task: Task): Promise<StartOutcome> {
  try {
    await assertAssigneeEnabled(task);
    await startTaskRun(task.id, { parentRunId: task.delegatedByRunId });
    return "started";
  } catch (error) {
    // The user started it since it was claimed: that run holds the place.
    if (isActiveTaskRunConflict(error)) return "taken";
    if (isUserError(error) && error.key === "tasks.errors.notFound") return "not-started";
    const t = getTranslator(settingsLocale(await getSettings()));
    const reason = isUserError(error)
      ? translateKey(t, error.key, error.values)
      : error instanceof Error
        ? error.message
        : String(error);
    console.warn(`[delegation] waiting task ${task.id} did not start: ${reason}`);
    await updateTask(task.id, { status: "blocked" }, "system");
    await addTaskComment(task.id, t("tasks.slots.startFailed", { reason }), "system");
    return "not-started";
  }
}

/**
 * Starts the conversation's waiting tasks, oldest first, while it has free places. Called when a run of
 * one of its delegated tasks ends, before the round is checked for a report. Returns how many started.
 */
export async function startWaitingTasks(conversationId: string): Promise<number> {
  return withLock(lockKey(conversationId), async () => {
    const { parallelDelegations } = await getSettings();
    let free = freePlaces(parallelDelegations, await busyPlaces(conversationId));
    let started = 0;
    while (free > 0) {
      const task = await claimOldestWaiting(conversationId);
      if (!task) break;
      const outcome = await startClaimed(task);
      if (outcome === "not-started") continue;
      free -= 1;
      if (outcome === "started") started += 1;
    }
    return started;
  });
}

/**
 * The reaper's safety net: starts waiting tasks wherever places are free (a report job that never ran,
 * a worker restart). A task whose delegating conversation is gone has no places left to wait for: it
 * starts. Returns how many started.
 */
export async function startAllWaitingTasks(): Promise<number> {
  const waiting = await db
    .selectDistinct({ conversationId: runs.conversationId })
    .from(tasks)
    .leftJoin(runs, eq(runs.id, tasks.delegatedByRunId))
    .where(isNotNull(tasks.waitingForSlotSince));
  let started = 0;
  for (const { conversationId } of waiting) {
    if (conversationId) {
      started += await startWaitingTasks(conversationId);
      continue;
    }
    for (let task = await claimOldestWaiting(null); task; task = await claimOldestWaiting(null)) {
      if ((await startClaimed(task)) === "started") started += 1;
    }
  }
  return started;
}
