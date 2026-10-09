import { agents, db, runs, tasks } from "@abotica/db";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, notExists, or, sql } from "@abotica/db/orm";
import { errorMessage, isUserError, UserError } from "@abotica/i18n";
import { withLock } from "../infra/redis";
import { getSettings, settingsTranslator } from "../settings/settings";
import { type Run, startTaskRun, type StartTaskRunOptions } from "../runs/runs";
import { addTaskComment, isActiveTaskRunConflict, type Task, type TaskPriority, updateTask } from "./tasks";

/**
 * Places for delegated work. The tasks delegated from one conversation run at most
 * `parallelDelegations` at a time, so a round of delegations cannot spend a plan's limit at once. A
 * place is held by a queued or running run of one of them. A task delegated while every place is taken
 * waits in the backlog (tasks.waitingForSlotSince) and starts once one frees up, the most urgent first
 * and, among equals, the one waiting longest: when a run of the conversation's delegated tasks ends
 * (reportDelegatedTasks), or from the reaper. Urgent work does not wait behind the cap: with
 * agents.urgentOverflow it takes a place over it (see mayTakePlace). Decisions for one conversation are
 * taken under a lock, so two of them at once cannot give out the same place.
 */

/** Places of a conversation: its cap, the places taken, and how many of those urgent tasks hold. */
type Places = { limit: number; busy: number; urgent: number };

/**
 * Whether a task of `priority` may take a place now: a free one under the cap, or, for urgent work with
 * `urgentOverflow` on, one over the cap while fewer than `limit` urgent runs already went over it. So the
 * ceiling is twice the cap, and only urgent work reaches it. Lowering the cap leaves the runs going and
 * only holds new starts.
 */
export function mayTakePlace(priority: TaskPriority, places: Places, urgentOverflow: boolean): boolean {
  if (places.busy < places.limit) return true;
  if (priority !== "urgent" || !urgentOverflow) return false;
  const overCap = Math.min(places.urgent, places.busy - places.limit);
  return overCap < places.limit;
}

const lockKey = (conversationId: string) => `abotica:conv:${conversationId}:delegation-slots`;

/** The runs of a conversation; the tasks they delegated share its places. */
const runsOf = (conversationId: string) =>
  db.select({ id: runs.id }).from(runs).where(eq(runs.conversationId, conversationId));

/** Places taken in the conversation, with the cap from the settings. */
async function places(conversationId: string, limit: number): Promise<Places> {
  const [row] = await db
    .select({ busy: count(), urgent: count(sql`case when ${tasks.priority} = 'urgent' then 1 end`) })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(inArray(runs.status, ["queued", "running"]), inArray(tasks.delegatedByRunId, runsOf(conversationId))));
  return { limit, busy: row?.busy ?? 0, urgent: row?.urgent ?? 0 };
}

/** The conversation whose places a task takes (the one of the run that delegated it), and the task's priority. */
async function delegatingConversation(
  taskId: string,
): Promise<{ conversationId: string | null; priority: TaskPriority } | null> {
  const [row] = await db
    .select({ conversationId: runs.conversationId, priority: tasks.priority })
    .from(tasks)
    .innerJoin(runs, eq(runs.id, tasks.delegatedByRunId))
    .where(eq(tasks.id, taskId));
  return row ?? null;
}

/**
 * Starts a delegated task when its conversation has a place for it (mayTakePlace); otherwise it waits for
 * one, in the backlog, and this returns null. A task no conversation delegated has no places to share: it
 * starts. `opts` go to startTaskRun as they are; its refusals reach the caller as they are.
 */
export async function startDelegatedTask(taskId: string, opts: StartTaskRunOptions = {}): Promise<Run | null> {
  const origin = await delegatingConversation(taskId);
  const conversationId = origin?.conversationId;
  if (!origin || !conversationId) return startTaskRun(taskId, opts);
  return withLock(lockKey(conversationId), async () => {
    const { parallelDelegations, urgentOverflow } = (await getSettings()).agents;
    const taken = await places(conversationId, parallelDelegations);
    if (mayTakePlace(origin.priority, taken, urgentOverflow)) return startTaskRun(taskId, opts);
    await db.update(tasks).set({ waitingForSlotSince: new Date() }).where(eq(tasks.id, taskId));
    await updateTask(taskId, { status: "backlog" }, "system");
    return null;
  });
}

/**
 * Takes the next task waiting for a place in the conversation, or one whose delegating conversation is
 * gone (`conversationId` null): the most urgent first, then the one waiting longest; `urgentOnly` for a
 * place over the cap. Clearing the mark is the claim: a task is taken once, however many look at the
 * same time.
 */
async function claimNextWaiting(conversationId: string | null, urgentOnly = false): Promise<Task | null> {
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
  // The enum is ordered low < medium < high < urgent.
  const next = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(isNotNull(tasks.waitingForSlotSince), delegatedThere, urgentOnly ? eq(tasks.priority, "urgent") : undefined))
    .orderBy(desc(tasks.priority), asc(tasks.waitingForSlotSince))
    .limit(1)
    .for("update", { skipLocked: true });
  const [task] = await db
    .update(tasks)
    .set({ waitingForSlotSince: null })
    .where(and(inArray(tasks.id, next), isNotNull(tasks.waitingForSlotSince)))
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
    const t = await settingsTranslator();
    const reason = errorMessage(t, error);
    console.warn(`[delegation] waiting task ${task.id} did not start: ${reason}`);
    await updateTask(task.id, { status: "blocked" }, "system");
    await addTaskComment(task.id, t("tasks.slots.startFailed", { reason }), "system");
    return "not-started";
  }
}

/**
 * Starts the conversation's waiting tasks, the most urgent first, while it has places for them: free ones
 * for any task, places over the cap for urgent ones (mayTakePlace). Called when a run of one of its
 * delegated tasks ends, before the round is checked for a report. Returns how many started.
 */
export async function startWaitingTasks(conversationId: string): Promise<number> {
  return withLock(lockKey(conversationId), async () => {
    const { parallelDelegations, urgentOverflow } = (await getSettings()).agents;
    const taken = await places(conversationId, parallelDelegations);
    let started = 0;
    for (;;) {
      const free = taken.busy < taken.limit;
      if (!free && !mayTakePlace("urgent", taken, urgentOverflow)) break;
      const task = await claimNextWaiting(conversationId, !free);
      if (!task) break;
      const outcome = await startClaimed(task);
      if (outcome === "not-started") continue;
      taken.busy += 1;
      if (task.priority === "urgent") taken.urgent += 1;
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
    for (let task = await claimNextWaiting(null); task; task = await claimNextWaiting(null)) {
      if ((await startClaimed(task)) === "started") started += 1;
    }
  }
  return started;
}
