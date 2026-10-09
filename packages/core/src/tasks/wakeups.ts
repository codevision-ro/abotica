/**
 * Task wakeups: an agent ends its run with task_wait ("wake me when X") and its task stays in progress
 * until X holds; then its assignee gets a new run, with a system comment naming what it waited for.
 * Every check goes through the task-events queue, one at a time: a timer or an expiry coming due (a
 * delayed job), the task's run ending, its pull request changing (prs-sync), a task it waits on changing
 * status. The rules are pure (wakeup-rules.ts); this applies them. A runaway limit or an expiry stops a
 * wakeup and tells the user; with nothing else waking the agent, the task is blocked.
 */
import { db, taskComments, taskEvents, taskPullRequests, tasks, taskWakeups, type TaskWakeupCondition } from "@abotica/db";
import { and, asc, count, eq, gte, inArray, ne, sql } from "@abotica/db/orm";
import { getTranslator, isUserError, translateKey, UserError } from "@abotica/i18n";
import { publish } from "../infra/events";
import { enqueueTaskEvent, notify, scheduleWakeupCheck } from "../infra/queues";
import { getSettings, settingsLocale } from "../settings/settings";
import { startTaskRun } from "../runs/runs";
import { pullRequestLabel } from "./pull-requests";
import { SETTLED_TASK_STATUSES } from "./delegation-report";
import { activeTaskRun, addTaskComment, awaitingReportTo, awaitsWakeup, TaskBusyError, updateTask } from "./tasks";
import {
  armedFingerprint,
  decideWakeup,
  firedState,
  MAX_WAKES_PER_HOUR,
  nextDueAt,
  runChain,
  WAKE_RATE_WINDOW_MS,
  type Wakeup,
  type WakeupDecision,
  type WakeupFacts,
  type WakeupKind,
  type WakeupRule,
  type WakeupView,
  wakeupCondition,
  wakeupKey,
} from "./wakeup-rules";

/**
 * The task event a wake run leaves, with the run and the chain behind it: the rate guard counts them,
 * and a wakeup the run sets carries its chain on.
 */
const WOKEN_EVENT = "woken";
type WokenData = { runId: string; wakeups: string[]; chain: string[] };

type TaskInfo = Pick<typeof tasks.$inferSelect, "id" | "title" | "status" | "projectId">;

/** Comment and notice text in the configured language, times in the configured time zone. */
async function commentText() {
  const settings = await getSettings();
  const locale = settingsLocale(settings);
  const t = getTranslator(locale);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: settings.general.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const describe = (view: WakeupView) => {
    const { key, values } = wakeupCondition(view, {
      time: (date) => time.format(date),
      status: (status) => t(`common.taskStatus.${status}`),
    });
    return t(`tasks.wakeups.condition.${key}`, values);
  };
  return { t, describe };
}

// Reads

/** The pull requests, subtasks and watched tasks the wakeups' conditions read. */
async function loadFacts(taskId: string, rules: Pick<WakeupRule, "kind" | "condition">[]): Promise<WakeupFacts> {
  const pullRequestIds = rules.flatMap((r) => (r.condition.pullRequestId ? [r.condition.pullRequestId] : []));
  const watchedIds = rules.flatMap((r) => (r.kind === "task_status" && r.condition.taskId ? [r.condition.taskId] : []));
  const [pullRequests, subtasks, watched] = await Promise.all([
    pullRequestIds.length
      ? db
          .select({
            id: taskPullRequests.id,
            state: taskPullRequests.state,
            checks: taskPullRequests.checks,
            headSha: taskPullRequests.headSha,
          })
          .from(taskPullRequests)
          .where(inArray(taskPullRequests.id, pullRequestIds))
      : [],
    rules.some((r) => r.kind === "subtasks_done")
      ? db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(eq(tasks.parentId, taskId))
      : [],
    watchedIds.length
      ? db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(inArray(tasks.id, watchedIds))
      : [],
  ]);
  return {
    pullRequests: new Map(pullRequests.map((p) => [p.id, p])),
    subtasks,
    taskStatuses: new Map(watched.map((w) => [w.id, w.status])),
  };
}

/** The chain behind a run: the wakeups that led to it with no person in between; empty for any other run. */
async function runWakeChain(run: { id: string; taskId: string | null } | null): Promise<string[]> {
  if (!run?.taskId) return [];
  const [event] = await db
    .select({ data: taskEvents.data })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, run.taskId),
        eq(taskEvents.type, WOKEN_EVENT),
        sql`${taskEvents.data}->>'runId' = ${run.id}`,
      ),
    )
    .limit(1);
  return (event?.data as WokenData | undefined)?.chain ?? [];
}

async function wakesSince(taskId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, WOKEN_EVENT), gte(taskEvents.createdAt, since)));
  return row?.count ?? 0;
}

/** The wakeups with what their conditions refer to: the pull request's label and link, the watched task's title. */
async function toViews(rows: Wakeup[]): Promise<WakeupView[]> {
  const pullRequestIds = rows.flatMap((r) => (r.condition.pullRequestId ? [r.condition.pullRequestId] : []));
  const taskIds = rows.flatMap((r) => (r.condition.taskId ? [r.condition.taskId] : []));
  const [pullRequests, watched] = await Promise.all([
    pullRequestIds.length
      ? db
          .select({
            id: taskPullRequests.id,
            provider: taskPullRequests.provider,
            number: taskPullRequests.number,
            url: taskPullRequests.url,
          })
          .from(taskPullRequests)
          .where(inArray(taskPullRequests.id, pullRequestIds))
      : [],
    taskIds.length ? db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(inArray(tasks.id, taskIds)) : [],
  ]);
  return rows.map((row) => {
    const pr = pullRequests.find((p) => p.id === row.condition.pullRequestId);
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      pausedReason: row.pausedReason,
      notes: row.notes,
      condition: row.condition,
      nextCheckAt: row.nextCheckAt,
      expiresAt: row.expiresAt,
      fires: row.fires,
      maxFires: row.maxFires,
      createdAt: row.createdAt,
      pullRequest: pr ? { label: pullRequestLabel(pr), url: pr.url } : null,
      watchedTask: watched.find((w) => w.id === row.condition.taskId) ?? null,
    };
  });
}

/** What the task waits for or stopped waiting for, oldest first; one-time wakeups that fired are history. */
export async function listTaskWakeups(taskId: string): Promise<WakeupView[]> {
  const rows = await db
    .select()
    .from(taskWakeups)
    .where(and(eq(taskWakeups.taskId, taskId), ne(taskWakeups.status, "fired")))
    .orderBy(asc(taskWakeups.createdAt));
  return toViews(rows);
}

// Writes

export type WakeupRequest = {
  taskId: string;
  /** The agent asking: the task's assignee. */
  agentId: string;
  /** The run asking; the chain behind it carries over to the wakeup. */
  run: { id: string; taskId: string | null } | null;
  kind: WakeupKind;
  condition: TaskWakeupCondition;
  notes: string;
  /** A timer's first time. */
  at: Date | null;
  expiresAt: Date | null;
  /** 1 for a one-time wakeup. */
  maxFires: number;
};

/** A wakeup with a time is looked at then, even if nothing else happens. */
async function scheduleDue(wakeup: Pick<Wakeup, "id" | "taskId" | "nextCheckAt" | "expiresAt">): Promise<void> {
  const due = nextDueAt(wakeup);
  if (due) await scheduleWakeupCheck(wakeup.taskId, wakeup.id, due);
}

/**
 * Sets a wakeup on a task, or re-arms the one waiting for the same condition (wakeupKey): active again,
 * its fires counted from zero, the chain of the asking run instead of its old one. Checked right away:
 * a condition already true fires once the task has no run going (the asking run, when it is the task's).
 */
export async function armWakeup(request: WakeupRequest): Promise<Wakeup> {
  const { taskId, kind, condition } = request;
  const now = new Date();
  const [chain, facts] = await Promise.all([runWakeChain(request.run), loadFacts(taskId, [{ kind, condition }])]);
  const values = {
    agentId: request.agentId,
    createdByRunId: request.run?.id ?? null,
    condition,
    notes: request.notes,
    nextCheckAt: request.at,
    expiresAt: request.expiresAt,
    maxFires: request.maxFires,
    fires: 0,
    chain,
    fingerprint: armedFingerprint({ kind, condition, nextCheckAt: request.at }, facts, now),
    status: "active" as const,
    pausedReason: null,
  };
  const [wakeup] = await db
    .insert(taskWakeups)
    .values({ ...values, taskId, kind, key: wakeupKey(kind, condition) })
    .onConflictDoUpdate({ target: [taskWakeups.taskId, taskWakeups.key], set: values })
    .returning();
  await scheduleDue(wakeup!);
  await enqueueTaskEvent({ taskId, event: "wakeups" });
  await publish({ type: "task.updated", taskId, projectId: null });
  return wakeup!;
}

/**
 * The user cancels a wakeup. A task that waited only for it, with no run going, leaves in progress for
 * review, as its last run would have left it.
 */
export async function cancelWakeup(taskId: string, wakeupId: string): Promise<void> {
  const [removed] = await db
    .delete(taskWakeups)
    .where(and(eq(taskWakeups.id, wakeupId), eq(taskWakeups.taskId, taskId)))
    .returning({ status: taskWakeups.status });
  if (!removed) throw new UserError("tasks.errors.wakeupNotFound");
  const [task] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
  const waitedOnlyForIt =
    removed.status === "active" &&
    task?.status === "in_progress" &&
    !(await awaitsWakeup(taskId)) &&
    !(await activeTaskRun(taskId));
  if (waitedOnlyForIt) await updateTask(taskId, { status: "review" }, "user");
  else await publish({ type: "task.updated", taskId, projectId: null });
}

// Checks

type Stopped = { rule: Wakeup; decision: Extract<WakeupDecision, { action: "pause" | "expire" }> };
type Firing = { rule: Wakeup; fingerprint: string };

/**
 * Pauses or expires the wakeups that stopped and tells the agent (a comment) and the user (a notice).
 * `block`: no other wakeup is left to move the task on, so it is blocked for the user.
 */
async function stopWakeups(task: TaskInfo, stopped: Stopped[], block: boolean): Promise<void> {
  for (const { rule, decision } of stopped) {
    await db
      .update(taskWakeups)
      .set(decision.action === "pause" ? { status: "paused", pausedReason: decision.reason } : { status: "expired" })
      .where(eq(taskWakeups.id, rule.id));
  }
  const { t, describe } = await commentText();
  const views = await toViews(stopped.map((s) => s.rule));
  const items = stopped
    .map(({ rule, decision }, i) => {
      const why = t(`tasks.wakeups.stopped.${decision.action === "pause" ? decision.reason : "expired"}`, {
        maxFires: rule.maxFires,
        max: MAX_WAKES_PER_HOUR,
      });
      return `- ${describe(views[i]!)}: ${why}`;
    })
    .join("\n");
  const blocked = block ? `\n${t("tasks.wakeups.comments.blocked")}` : "";
  await addTaskComment(task.id, `${t("tasks.wakeups.comments.stopped", { items })}${blocked}`, "system");
  if (block && task.status !== "blocked") await updateTask(task.id, { status: "blocked" }, "system");
  await notify({
    kind: "text",
    text: `${t("tasks.wakeups.notices.stopped", { title: task.title, items })}${blocked}`,
    projectId: task.projectId,
  });
}

/**
 * Wakes the task's assignee for the wakeups that fired: one comment naming each (with the agent's notes)
 * and one run. A run that started meanwhile leaves them for its end; a start refused for a reason the
 * user has to fix (open circuit, unfinished dependencies, no assignee) counts them as fired and tells the user.
 */
async function fireWakeups(task: TaskInfo, firing: Firing[], now: Date): Promise<void> {
  const { t, describe } = await commentText();
  const views = await toViews(firing.map((f) => f.rule));
  const items = firing
    .map(({ rule }, i) => {
      const line = `- ${describe(views[i]!)}`;
      return rule.notes ? `${line}\n  ${t("tasks.wakeups.comments.notes", { notes: rule.notes })}` : line;
    })
    .join("\n");
  const comment = await addTaskComment(task.id, t("tasks.wakeups.comments.woken", { items }), "system");
  let runId: string | null = null;
  try {
    runId = (await startTaskRun(task.id)).id;
  } catch (error) {
    if (error instanceof TaskBusyError || !isUserError(error)) {
      // Started meanwhile, or a failure that may pass: the comment goes, the next check fires them again.
      await db.delete(taskComments).where(eq(taskComments.id, comment.id));
      if (error instanceof TaskBusyError) return;
      throw error;
    }
    const reason = translateKey(t, error.key, error.values);
    console.warn(`[wakeups] task ${task.id} not woken: ${reason}`);
    await notify({
      kind: "text",
      text: t("tasks.wakeups.notices.notWoken", { title: task.title, reason }),
      projectId: task.projectId,
    });
  }
  const wakeups = firing.map((f) => f.rule.id);
  await db.transaction(async (tx) => {
    for (const { rule, fingerprint } of firing) {
      await tx
        .update(taskWakeups)
        .set(firedState(rule, fingerprint, now))
        .where(eq(taskWakeups.id, rule.id));
    }
    if (runId) {
      const data: WokenData = { runId, wakeups, chain: runChain(firing.map((f) => f.rule)) };
      await tx.insert(taskEvents).values({ taskId: task.id, type: WOKEN_EVENT, actor: "system", data });
    }
  });
}

/**
 * task_status wakeups on a task their agent delegated, reached a settled status whose report is still to
 * come: that report brings the result back to the delegating conversation, which continues, so a wake run
 * would process it a second time in parallel. task_wait refuses such waits; this covers older ones.
 */
async function coveredByReport(firing: Firing[]): Promise<Firing[]> {
  const candidates = firing.filter(
    ({ rule }) =>
      rule.kind === "task_status" &&
      rule.agentId &&
      rule.condition.taskId &&
      rule.condition.status &&
      SETTLED_TASK_STATUSES.includes(rule.condition.status),
  );
  const covered: Firing[] = [];
  for (const f of candidates) {
    if ((await awaitingReportTo(f.rule.agentId!, [f.rule.condition.taskId!])).length) covered.push(f);
  }
  return covered;
}

/** Wakeups that hold but need no run: counted as fired, so they do not fire again for the same facts. */
async function consumeWakeups(firing: Firing[], now: Date): Promise<void> {
  for (const { rule, fingerprint } of firing) {
    await db
      .update(taskWakeups)
      .set(firedState(rule, fingerprint, now))
      .where(eq(taskWakeups.id, rule.id));
  }
}

/**
 * Checks a task's active wakeups and applies what they decide (decideWakeup): fingerprints kept current,
 * stopped ones paused or expired, the ones that hold woken together in one run. A task with a run going
 * is checked again when it ends, a paused one when it is resumed; a done or cancelled task waits for
 * nothing, so its wakeups go.
 */
export async function checkTaskWakeups(taskId: string, now = new Date()): Promise<void> {
  const [task] = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task) return;
  if (task.status === "done" || task.status === "cancelled") {
    const ended = await db.delete(taskWakeups).where(eq(taskWakeups.taskId, taskId)).returning({ id: taskWakeups.id });
    if (ended.length) await publish({ type: "task.updated", taskId, projectId: task.projectId });
    return;
  }
  if (task.status === "paused") return;
  const rules = await db
    .select()
    .from(taskWakeups)
    .where(and(eq(taskWakeups.taskId, taskId), eq(taskWakeups.status, "active")));
  if (!rules.length || (await activeTaskRun(taskId))) return;

  const [facts, wakesLastHour] = await Promise.all([
    loadFacts(taskId, rules),
    wakesSince(taskId, new Date(now.getTime() - WAKE_RATE_WINDOW_MS)),
  ]);
  const firing: Firing[] = [];
  const stopped: Stopped[] = [];
  for (const rule of rules) {
    const decision = decideWakeup(rule, facts, { now, wakesLastHour });
    if (decision.action === "fire") firing.push({ rule, fingerprint: decision.fingerprint });
    else if (decision.action !== "wait") stopped.push({ rule, decision });
    else if (decision.fingerprint !== rule.fingerprint) {
      await db.update(taskWakeups).set({ fingerprint: decision.fingerprint }).where(eq(taskWakeups.id, rule.id));
    }
  }
  // Blocked only when every wakeup of the task stopped: none is left to move it on.
  if (stopped.length) await stopWakeups(task, stopped, stopped.length === rules.length);
  const covered = await coveredByReport(firing);
  if (covered.length) await consumeWakeups(covered, now);
  const waking = firing.filter((f) => !covered.includes(f));
  if (waking.length) await fireWakeups(task, waking, now);
  if (stopped.length || firing.length) await publish({ type: "task.updated", taskId, projectId: task.projectId });

  // The next look at the ones still waiting; a time already asked for adds no second job.
  const waiting = await db
    .select()
    .from(taskWakeups)
    .where(and(eq(taskWakeups.taskId, taskId), eq(taskWakeups.status, "active")));
  for (const wakeup of waiting) await scheduleDue(wakeup);
}

/**
 * A task's status changed: checks its own wakeups (a done task's end), its parent's (subtasks_done) and
 * those of the tasks waiting for it to reach a status. One that fails is logged and does not stop the others.
 */
export async function checkWakeupsWaitingOn(taskId: string): Promise<void> {
  const [task] = await db.select({ parentId: tasks.parentId }).from(tasks).where(eq(tasks.id, taskId));
  const watchers = await db
    .selectDistinct({ taskId: taskWakeups.taskId })
    .from(taskWakeups)
    .where(
      and(
        eq(taskWakeups.status, "active"),
        eq(taskWakeups.kind, "task_status"),
        sql`${taskWakeups.condition}->>'taskId' = ${taskId}`,
      ),
    );
  const ids = new Set([taskId, ...(task?.parentId ? [task.parentId] : []), ...watchers.map((w) => w.taskId)]);
  for (const id of ids) {
    await checkTaskWakeups(id).catch((error: unknown) =>
      console.error(`[wakeups] checking the wakeups of task ${id} failed:`, error),
    );
  }
}
