/**
 * Keeps the company moving without anyone watching: one sweep a minute (maintenance kind "followups")
 * escalates unanswered questions, sends deadline reminders and alerts, follows up quiet tasks, starts
 * due retries, reminds the user of what waits for them and resumes work put aside for settled tasks.
 * Each step claims its rows, so the sweep is idempotent and safe on several workers. onRunEnded decides
 * what happens after a task's run stops short of settling it; startRetry starts an automatic retry.
 */
import { db, runs, taskComments, taskEvents, tasks, taskWakeups } from "@abotica/db";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "@abotica/db/orm";
import { getTranslator, isUserError, translateKey } from "@abotica/i18n";
import { neutralizeMarkers } from "../agents/untrusted";
import { notify } from "../infra/queues";
import { deliverToConversation, deliverToSuperior, deliverToTask } from "../runs/deliver";
import { isLimitStop } from "../runs/run-lifecycle";
import { ConversationBusyError, noticeMessage, type Run, startContinuation } from "../runs/runs";
import { getSettings, settingsLocale } from "../settings/settings";
import type { AppSettings } from "../settings/settings-schema";
import { chainOfCommand } from "./chain";
import { resumePausedFor } from "./control";
import { reportTask } from "./delegation";
import { SETTLED_TASK_STATUSES } from "./delegation-report";
import { startDelegatedTask } from "./delegation-slots";
import { alertDependents } from "./handoffs";
import { escalateQuestion, systemQuestion } from "./task-messages";
import {
  activeTaskRun,
  addTaskComment,
  awaitsAnswer,
  awaitsDelegatedWork,
  awaitsWakeup,
  isActiveTaskRunConflict,
  type Task,
  updateTask,
} from "./tasks";
import { sendWaitingReminders } from "./waiting-for-user";

/** Who notices come from, as people read it. */
const FROM = "Abotica";
const MINUTE_MS = 60_000;
/** Follow-ups of a quiet task that go to its superior; the next one goes to the user, and then no more. */
const FOLLOW_UPS_UP = 2;
/** A task in review or blocked is left untouched this many times staleTaskMinutes before it is brought up. */
const SETTLED_STALE_FACTOR = 3;
/** Statuses of a task that is over: no deadline, follow-up or retry concerns it any more. */
const CLOSED: Task["status"][] = ["done", "cancelled"];
const ACTIVE_RUN_STATUSES: Run["status"][] = ["queued", "running", "waiting_approval"];

const minutesBetween = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / MINUTE_MS));

/** A duration for an agent to read: "45 min", "3 h 20 min", "2 d 4 h". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return hours % 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : `${Math.floor(hours / 24)} d`;
}

/**
 * When a task's deadline reminder is due: a fifth of the time it was given before the deadline, at
 * least 10 minutes and at most a day. remindDeadlines asks the same in SQL.
 */
export function deadlineReminderAt(createdAt: Date, deadline: Date): Date {
  const lead = Math.min(Math.max(0.2 * (deadline.getTime() - createdAt.getTime()), 10 * MINUTE_MS), 24 * 60 * MINUTE_MS);
  return new Date(deadline.getTime() - lead);
}

/** Runs `fn` for each row; one that fails is logged and does not keep the others from their turn. */
async function each<T>(rows: T[], what: (row: T) => string, fn: (row: T) => Promise<unknown>): Promise<void> {
  for (const row of rows) {
    try {
      await fn(row);
    } catch (error) {
      console.error(`[followups] ${what(row)} failed:`, error);
    }
  }
}

const logTaskEvent = (taskId: string, type: string, data: Record<string, unknown>) =>
  db.insert(taskEvents).values({ taskId, type, actor: "system", data });

const quote = (task: Pick<Task, "id" | "title">) => `"${neutralizeMarkers(task.title)}" (${task.id})`;

/** One sweep at `now` (injected by the tests to move time forward). */
export async function sweepFollowUps(now: Date = new Date()): Promise<void> {
  const settings = await getSettings();
  const steps: [string, () => Promise<unknown>][] = [
    ["escalating questions", () => escalateQuestions(now)],
    ["deadline reminders", () => remindDeadlines(now)],
    ["missed deadlines", () => alertMissedDeadlines(now)],
    ["deadline escalations", () => escalateMissedDeadlines(now, settings)],
    ["quiet tasks", () => followUpQuietTasks(now, settings)],
    ["review reminders", () => remindReviews(now, settings)],
    ["blocked escalations", () => escalateBlocked(now, settings)],
    ["due retries", () => startDueRetries(now)],
    ["user reminders", () => sendWaitingReminders(now)],
    ["work put aside", () => resumeSettledPauses()],
  ];
  // A step that fails (its query, or a module not ready) leaves the others their turn; it runs again next minute.
  for (const [what, step] of steps) {
    try {
      await step();
    } catch (error) {
      console.error(`[followups] ${what} failed:`, error);
    }
  }
}

/** 1. Open questions whose time is up go one level up (task-messages.ts escalateQuestion claims each). */
async function escalateQuestions(now: Date) {
  const due = await db
    .select({ id: taskComments.id })
    .from(taskComments)
    .where(and(eq(taskComments.questionStatus, "open"), lte(taskComments.escalateAt, now)));
  await each(
    due,
    (q) => `escalating question ${q.id}`,
    (q) => escalateQuestion(q.id, now),
  );
}

/**
 * 2. The assignee hears that the deadline comes (deadlineReminderAt), once per deadline. It takes it in
 * at its next step, or reads it at its next run: the reminder wakes no one.
 */
async function remindDeadlines(now: Date) {
  const due = await db
    .update(tasks)
    .set({ deadlineRemindedAt: now })
    .where(
      and(
        isNull(tasks.deadlineRemindedAt),
        isNotNull(tasks.deadline),
        gt(tasks.deadline, now),
        notInArray(tasks.status, CLOSED),
        sql`${tasks.deadline} - least(greatest((${tasks.deadline} - ${tasks.createdAt}) * 0.2, interval '10 minutes'), interval '1 day') <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .returning();
  await each(
    due,
    (t) => `reminding task ${t.id} of its deadline`,
    async (task) => {
      const left = minutesBetween(now, task.deadline!);
      await logTaskEvent(task.id, "deadline-reminded", { deadline: task.deadline!.toISOString() });
      const text = `The deadline is ${task.deadline!.toISOString()}, in ${formatMinutes(left)}. Finish what matters most first. If it cannot be done in time, tell whoever gave you the task now (report_progress with needsAttention, or ask).`;
      await deliverToTask(
        task.id,
        { kind: "reminder", text, from: FROM },
        { wake: "never", by: "system", reason: "instruction" },
      );
    },
  );
}

/** The choices a superior has about late work, in every alert about it. */
const LATE_OPTIONS =
  "Decide now: extend the deadline (task_update deadline), raise its priority, put other work aside for it, redirect it, or cancel it (task_control).";

/** 3. A deadline passed with the task still open: whoever gave it hears, and is woken to decide. */
async function alertMissedDeadlines(now: Date) {
  const missed = await db
    .update(tasks)
    .set({ deadlineMissedAt: now })
    .where(and(isNull(tasks.deadlineMissedAt), lt(tasks.deadline, now), notInArray(tasks.status, CLOSED)))
    .returning();
  await each(
    missed,
    (t) => `alerting about task ${t.id}'s missed deadline`,
    async (task) => {
      const late = formatMinutes(minutesBetween(task.deadline!, now));
      await logTaskEvent(task.id, "deadline-missed", { deadline: task.deadline!.toISOString() });
      const text = `Task ${quote(task)} missed its deadline (${task.deadline!.toISOString()}): late by ${late}, status ${task.status}. ${LATE_OPTIONS}`;
      await deliverToSuperior(task.id, { kind: "alert", text, from: FROM }, { wake: "now" });
    },
  );
}

/**
 * Tells the level above the task's superior (chainOfCommand[1]): an agent gets the alert in the
 * conversation where it gave the work on, which wakes it; the user gets `userText` as a notification.
 * Nothing when the user is the task's superior already.
 */
async function alertAbove(task: Task, text: string, userText: string): Promise<"agent" | "user" | "none"> {
  const [superior, above] = await chainOfCommand(task.id, 2);
  if (superior?.kind !== "agent" || !above) return "none";
  if (above.kind === "user") {
    await notify({ kind: "text", text: userText, projectId: task.projectId });
    return "user";
  }
  await deliverToConversation({
    conversationId: above.conversationId,
    agentId: above.agent.id,
    message: noticeMessage(task, { kind: "alert", text, from: FROM }),
    wake: "now",
    run: { taskId: above.taskId, projectId: null, trigger: above.trigger, parentRunId: above.runId },
    contentProjectIds: task.projectId ? [task.projectId] : [],
  });
  return "agent";
}

const translator = async () => getTranslator(settingsLocale(await getSettings()));

/** 4. Still late deadlineEscalationMinutes after the miss: the level above the superior hears. */
async function escalateMissedDeadlines(now: Date, settings: AppSettings) {
  const since = new Date(now.getTime() - settings.agents.deadlineEscalationMinutes * MINUTE_MS);
  const late = await db
    .update(tasks)
    .set({ deadlineEscalatedAt: now })
    .where(and(isNull(tasks.deadlineEscalatedAt), lte(tasks.deadlineMissedAt, since), notInArray(tasks.status, CLOSED)))
    .returning();
  const t = await translator();
  await each(
    late,
    (task) => `escalating task ${task.id}'s missed deadline`,
    async (task) => {
      const minutes = minutesBetween(task.deadline!, now);
      const text = `Task ${quote(task)} is still late by ${formatMinutes(minutes)} (deadline ${task.deadline!.toISOString()}), and whoever gave it has not moved it. ${LATE_OPTIONS}`;
      const to = await alertAbove(
        task,
        text,
        t("notifications.followups.deadlineEscalated", { task: task.title, minutes }),
      );
      await logTaskEvent(task.id, "deadline-escalated", { to });
    },
  );
}

/** A task's latest run, for a follow-up that says how its work stopped. */
async function lastRun(taskId: string) {
  const [run] = await db
    .select({ id: runs.id, status: runs.status, failureKind: runs.failureKind, error: runs.error })
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return run ?? null;
}

/**
 * Nothing is going to move the task: no run of it is active or due for a retry, no wakeup, question or
 * delegated work is pending, and it does not wait for a delegation place.
 */
const nothingMoves = () => [
  notExists(
    db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.taskId, tasks.id),
          or(inArray(runs.status, ACTIVE_RUN_STATUSES), and(isNotNull(runs.retryAt), isNull(runs.retriedByRunId))),
        ),
      ),
  ),
  notExists(
    db
      .select({ id: taskWakeups.id })
      .from(taskWakeups)
      .where(and(eq(taskWakeups.taskId, tasks.id), eq(taskWakeups.status, "active"))),
  ),
  notExists(
    db
      .select({ id: taskComments.id })
      .from(taskComments)
      .where(and(eq(taskComments.taskId, tasks.id), eq(taskComments.questionStatus, "open"))),
  ),
  // Work it handed on that is still to be reported back to it (as awaitsDelegatedWork, by its runs).
  sql`not exists (select 1 from ${tasks} as sub join ${runs} as d on d.id = sub.delegated_by_run_id where d.task_id = ${tasks.id} and sub.reported_at is null)`,
  isNull(tasks.waitingForSlotSince),
];

/**
 * 5. A task in progress that nothing moves and nobody touched for staleTaskMinutes: whoever gave it hears
 * (with a wake) twice, staleTaskMinutes apart, then the user once, and then nothing more. Any activity
 * on the task starts the count over (tasks.ts touchTask).
 */
async function followUpQuietTasks(now: Date, settings: AppSettings) {
  const stale = new Date(now.getTime() - settings.agents.staleTaskMinutes * MINUTE_MS);
  const due = and(
    eq(tasks.status, "in_progress"),
    isNotNull(tasks.assigneeAgentId),
    lt(tasks.activityAt, stale),
    lte(tasks.followUps, FOLLOW_UPS_UP),
    or(isNull(tasks.followedUpAt), lte(tasks.followedUpAt, stale)),
  );
  const candidates = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(due, ...nothingMoves()));
  if (!candidates.length) return;
  // The claim: a task followed up meanwhile (another sweep) no longer matches.
  const claimed = await db
    .update(tasks)
    .set({ followUps: sql`${tasks.followUps} + 1`, followedUpAt: now })
    .where(
      and(
        inArray(
          tasks.id,
          candidates.map((c) => c.id),
        ),
        due,
      ),
    )
    .returning();
  const t = await translator();
  await each(
    claimed,
    (task) => `following up quiet task ${task.id}`,
    async (task) => {
      const minutes = minutesBetween(task.activityAt, now);
      if (task.followUps > FOLLOW_UPS_UP) {
        await notify({
          kind: "text",
          text: t("notifications.followups.quietTask", { task: task.title, minutes }),
          projectId: task.projectId,
        });
        return logTaskEvent(task.id, "followed-up", { count: task.followUps, to: "user" });
      }
      const run = await lastRun(task.id);
      const ended = run
        ? `Its last run (${run.id}) ended ${run.status}${run.failureKind ? ` (${run.failureKind})` : ""}${run.error ? `: ${run.error.slice(0, 300)}` : ""}.`
        : "It has had no run yet.";
      const text = `Task ${quote(task)} has been quiet for ${formatMinutes(minutes)}: it is in progress, but nothing works on it and nothing it waits for is pending. ${ended} Decide now: steer it with a task_comment, resume or redirect it, or cancel it (task_control). Follow-up ${task.followUps} of ${FOLLOW_UPS_UP}; after that the user is told.`;
      await deliverToSuperior(task.id, { kind: "alert", text, from: FROM }, { wake: "now" });
      await logTaskEvent(task.id, "followed-up", { count: task.followUps, to: "superior" });
    },
  );
}

/**
 * Claims the delegated tasks in `status` nobody touched for SETTLED_STALE_FACTOR times staleTaskMinutes
 * and not brought up since (follow_ups stays 1 until any activity).
 */
async function claimStaleSettled(now: Date, settings: AppSettings, status: "review" | "blocked") {
  const stale = new Date(now.getTime() - SETTLED_STALE_FACTOR * settings.agents.staleTaskMinutes * MINUTE_MS);
  return db
    .update(tasks)
    .set({ followUps: 1, followedUpAt: now })
    .where(
      and(eq(tasks.status, status), isNotNull(tasks.delegatedByRunId), lt(tasks.activityAt, stale), eq(tasks.followUps, 0)),
    )
    .returning();
}

/** 5b. A delegated task its delegator leaves in review gets one reminder, which wakes the delegator. */
async function remindReviews(now: Date, settings: AppSettings) {
  const waiting = await claimStaleSettled(now, settings, "review");
  await each(
    waiting,
    (task) => `reminding the delegator of task ${task.id}`,
    async (task) => {
      const text = `Task ${quote(task)} has waited in review for ${formatMinutes(minutesBetween(task.activityAt, now))}. Review it now: mark it done, or send it back with what to fix.`;
      await deliverToSuperior(task.id, { kind: "reminder", text, from: FROM }, { wake: "now" });
      await logTaskEvent(task.id, "followed-up", { count: 1, to: "superior", status: "review" });
    },
  );
}

/** 5c. A delegated task left blocked goes one level above its delegator, once. */
async function escalateBlocked(now: Date, settings: AppSettings) {
  const blocked = await claimStaleSettled(now, settings, "blocked");
  const t = await translator();
  await each(
    blocked,
    (task) => `escalating blocked task ${task.id}`,
    async (task) => {
      const minutes = minutesBetween(task.activityAt, now);
      const text = `Task ${quote(task)} has been blocked for ${formatMinutes(minutes)}, and whoever gave it has not acted on it (task_get shows why it is blocked). Decide now: unblock it with an answer or an instruction, redirect it, or cancel it (task_control).`;
      const to = await alertAbove(task, text, t("notifications.followups.blockedTask", { task: task.title, minutes }));
      await logTaskEvent(task.id, "followed-up", { count: 1, to, status: "blocked" });
    },
  );
}

/** 6. The safety net of the retries: one whose delayed job was lost starts here. */
async function startDueRetries(now: Date) {
  const due = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(lte(runs.retryAt, now), isNull(runs.retriedByRunId)));
  await each(
    due,
    (r) => `retrying run ${r.id}`,
    (r) => startRetry(r.id),
  );
}

/** 8. The safety net of putting work aside: work paused for a task that settled meanwhile goes on. */
async function resumeSettledPauses() {
  const paused = await db
    .selectDistinct({ id: tasks.pausedForTaskId })
    .from(tasks)
    .where(and(eq(tasks.status, "paused"), isNotNull(tasks.pausedForTaskId)));
  const ids = paused.flatMap((p) => (p.id ? [p.id] : []));
  if (!ids.length) return;
  const settled = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(inArray(tasks.id, ids), inArray(tasks.status, [...SETTLED_TASK_STATUSES])));
  await each(
    settled,
    (s) => `resuming the work paused for task ${s.id}`,
    (s) => resumePausedFor(s.id),
  );
}

/**
 * Starts the automatic retry of a run that failed for a passing reason (run-lifecycle.ts scheduleRetry),
 * once: the retry is claimed by clearing runs.retryAt. A task run goes on with its task, in the
 * conversation it worked in, when the task still waits for it (in progress, no run); one that cannot
 * start is blocked with the reason and reported. A run without a task (a chat cut by a restart) goes on
 * in its conversation, unless a newer run is there already. Returns the new run, or null.
 */
export async function startRetry(runId: string): Promise<Run | null> {
  const [run] = await db
    .update(runs)
    .set({ retryAt: null })
    .where(and(eq(runs.id, runId), isNotNull(runs.retryAt), isNull(runs.retriedByRunId)))
    .returning();
  if (!run) return null;
  const retry = run.taskId ? await retryTask(run, run.taskId) : await retryConversation(run);
  if (retry) await db.update(runs).set({ retriedByRunId: retry.id }).where(eq(runs.id, run.id));
  return retry;
}

async function retryTask(run: Run, taskId: string): Promise<Run | null> {
  const [task] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
  // Settled, paused or given back meanwhile: whoever did that decides what comes next.
  if (task?.status !== "in_progress") return null;
  try {
    return await startDelegatedTask(taskId, {
      reason: "retry",
      parentRunId: run.id,
      trigger: run.trigger,
      attempt: run.attempt + 1,
    });
  } catch (error) {
    if (isActiveTaskRunConflict(error)) return null; // it was started meanwhile
    const t = await translator();
    const reason = isUserError(error)
      ? translateKey(t, error.key, error.values)
      : error instanceof Error
        ? error.message
        : String(error);
    await updateTask(taskId, { status: "blocked" }, "system");
    await addTaskComment(taskId, t("notifications.followups.retryNotStarted", { reason }), "system");
    await reportTask(taskId);
    return null;
  }
}

/**
 * Runs started after `run`, never `run` itself: a Date read back from the database has lost the
 * microseconds Postgres keeps, so `run` is later than its own truncated created_at.
 */
const newerThan = (run: Run) => and(gte(runs.createdAt, run.createdAt), ne(runs.id, run.id));

async function retryConversation(run: Run): Promise<Run | null> {
  if (!run.conversationId || !run.agentId) return null;
  const [newer] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.conversationId, run.conversationId), newerThan(run)))
    .limit(1);
  if (newer) return null;
  try {
    return await startContinuation({
      agentId: run.agentId,
      trigger: run.trigger,
      conversationId: run.conversationId,
      projectId: run.projectId,
      parentRunId: run.id,
      attempt: run.attempt + 1,
    });
  } catch (error) {
    if (error instanceof ConversationBusyError) return null; // the conversation went on meanwhile
    throw error;
  }
}

/** The choices of a question the platform asks about a task that stopped short. */
const STOPPED_OPTIONS = ["continue", "redirect", "cancel"];

/**
 * After a task's run ended: a run stopped at its step or time limit goes on by itself up to
 * maxContinuations, then asks its delegator; a loop asks at once; a passing failure was scheduled for a
 * retry. Called before the run's delegation report, which is skipped unless this returns "none". The
 * task goes on only when nothing else will move it (an answer, a wakeup, delegated work) and no newer
 * run took it over; none of this touches the circuit breaker or the send-back count.
 */
export async function onRunEnded(run: Run): Promise<"continued" | "asked" | "retry-scheduled" | "none"> {
  if (run.retryAt && !run.retriedByRunId) return "retry-scheduled";
  if (run.status !== "succeeded" || !run.taskId || !isLimitStop(run.failureKind)) return "none";
  const [task] = await db.select().from(tasks).where(eq(tasks.id, run.taskId));
  if (task?.status !== "in_progress" || !task.assigneeAgentId) return "none";
  if (await activeTaskRun(task.id)) return "none";
  const [newer] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, task.id), newerThan(run)))
    .limit(1);
  if (newer) return "none";
  if ((await awaitsAnswer(task.id)) || (await awaitsWakeup(task.id)) || (await awaitsDelegatedWork(run.conversationId))) {
    return "none";
  }
  const why = run.error ? ` (${run.error})` : "";
  if (run.failureKind === "loop") {
    await systemQuestion(task.id, {
      system: "loop",
      text: `Task ${quote(task)} stopped because its agent kept repeating the same tool calls${why}. Its work so far is kept. Should it continue (with what it needs to change), be redirected with new instructions, or be cancelled?`,
      options: STOPPED_OPTIONS,
    });
    return "asked";
  }
  const { maxContinuations } = (await getSettings()).agents;
  const [claimed] = await db
    .update(tasks)
    .set({ continuations: sql`${tasks.continuations} + 1` })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "in_progress"), lt(tasks.continuations, maxContinuations)))
    .returning({ continuations: tasks.continuations });
  if (claimed) {
    await logTaskEvent(task.id, "continued", {
      runId: run.id,
      kind: run.failureKind,
      continuation: claimed.continuations,
      of: maxContinuations,
    });
    try {
      await startDelegatedTask(task.id, { reason: "continue", parentRunId: run.id, trigger: run.trigger });
    } catch (error) {
      if (isActiveTaskRunConflict(error)) return "none"; // started meanwhile: that run goes on with it
      throw error;
    }
    return "continued";
  }
  const limit = run.failureKind === "timeout" ? "time limit" : "step limit";
  await systemQuestion(task.id, {
    system: "needs-more-time",
    text: `Task ${quote(task)} reached its ${limit} again${why} after ${maxContinuations} automatic continuation${maxContinuations === 1 ? "" : "s"}, and is not finished. Its work so far is kept. Should it continue for more rounds, be redirected with new instructions, or be cancelled?`,
    options: STOPPED_OPTIONS,
  });
  return "asked";
}

/**
 * A task settled (task-events "done" or "status"): its automatic continuations start over, work put
 * aside for it resumes (control.ts resumePausedFor), and when it is blocked or cancelled the delegators
 * of the tasks waiting on it hear that those cannot start (handoffs.ts alertDependents).
 */
export async function onTaskSettled(taskId: string): Promise<void> {
  const [task] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
  if (!task || !SETTLED_TASK_STATUSES.includes(task.status)) return;
  await db
    .update(tasks)
    .set({ continuations: 0 })
    .where(and(eq(tasks.id, taskId), gt(tasks.continuations, 0)));
  await resumePausedFor(taskId);
  if (task.status === "blocked" || task.status === "cancelled") await alertDependents(taskId, task.status);
}
