/**
 * Work in flight, under control: a task paused at its next step and resumed in the same conversation,
 * cancelled with its subtree, or redirected (new instructions, another assignee, priority or deadline).
 * The user does it from the web, a manager or the super agent with task_control (team-rules.ts
 * mayControlTask). The runner's soft stop ends a running run cleanly between steps.
 */
import { agents, db, projects, runs, taskComments, taskEvents, tasks, taskWakeups } from "@abotica/db";
import { and, eq, inArray, notInArray, or, sql } from "@abotica/db/orm";
import { getTranslator, isUserError, type Translator, translateKey, UserError } from "@abotica/i18n";
import { enqueueTaskEvent } from "../infra/queues";
import { redis } from "../infra/redis";
import { deliverToTask, type TaskNotice } from "../runs/deliver";
import type { RunFailureKind } from "../runs/run-failures";
import { cancelPendingRun } from "../runs/run-lifecycle";
import { cancelRun, type Run } from "../runs/runs";
import { getSettings, settingsLocale } from "../settings/settings";
import { loadDelegationProject, reportTask } from "./delegation";
import { startDelegatedTask } from "./delegation-slots";
import { postInstruction } from "./task-messages";
import { checkDelegationTarget } from "./team-rules";
import {
  type Actor,
  addTaskComment,
  isActiveTaskRunConflict,
  pendingDependencies,
  type Task,
  TaskBusyError,
  type TaskPriority,
  type TaskStatus,
  updateTask,
} from "./tasks";

/** A task that can be put aside: not started yet, underway, or paused already (the latest pause wins). */
const PAUSABLE: readonly TaskStatus[] = ["backlog", "in_progress", "paused"];
/** A task that can go on: put aside, blocked, or left in progress with no run (resume means "go on"). */
const RESUMABLE: readonly TaskStatus[] = ["paused", "blocked", "in_progress"];
/** A task that is over: nothing in it can be stopped or changed any more. */
const OVER: readonly TaskStatus[] = ["done", "cancelled"];

const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_approval"] as const;

const translator = async () => getTranslator(settingsLocale(await getSettings()));

/** Who acts, as people read it (`name`) and as task events and runs record it (`actor`). */
type Who = { name: string; actor: string };

async function who(by: Actor, t: Translator): Promise<Who> {
  if (by === "user") return { name: t("flow.control.user"), actor: "user" };
  if (by === "system") return { name: t("flow.control.system"), actor: "system" };
  const [agent] = await db.select({ name: agents.name, slug: agents.slug }).from(agents).where(eq(agents.id, by.agentId));
  return { name: agent?.name ?? by.agentId, actor: `agent:${agent?.slug ?? by.agentId}` };
}

/** The kind a run stopped by `by` ends with: the user's stop, or an agent's (the platform acts for one). */
const stopKind = (by: Actor): RunFailureKind => (by === "user" ? "cancelled_by_user" : "cancelled_by_agent");

async function loadTask(taskId: string): Promise<Task> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new UserError("tasks.errors.notFound");
  return task;
}

/** The task's unfinished run, with its status. */
async function activeRunOf(taskId: string): Promise<Pick<Run, "id" | "status"> | undefined> {
  const [run] = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), inArray(runs.status, [...ACTIVE_RUN_STATUSES])))
    .limit(1);
  return run;
}

async function logEvent(taskId: string, type: string, actor: string, data: Record<string, unknown>): Promise<void> {
  await db.insert(taskEvents).values({ taskId, type, actor, data });
}

/**
 * Stores a control notice on the task and puts it where its assignee reads it next (the conversation of
 * its paused round), without waking it.
 */
async function controlNotice(taskId: string, text: string, by: Actor, from: string): Promise<void> {
  const comment = await addTaskComment(taskId, text, "system", { kind: "notice" });
  await deliverToTask(
    taskId,
    { kind: "control", text, commentId: comment.id, from },
    { wake: "never", by, reason: "resumed" },
  );
}

// Soft stop: the runner checks it between steps, so no tool call is cut off.

const softStopKey = (runId: string) => `abotica:run:${runId}:soft-stop`;

/** Asks the run to stop at its next step (the runner checks between steps), with the reason it records. */
export async function requestSoftStop(runId: string, reason: string): Promise<void> {
  await redis().set(softStopKey(runId), reason, "EX", 3600);
}

/** The soft stop requested for the run, taken once: its reason, or null when none is pending. */
export async function takeSoftStop(runId: string): Promise<string | null> {
  return redis().getdel(softStopKey(runId));
}

/**
 * Puts the task aside: status paused, its queued run cancelled and its running one stopped at the next
 * step. `pausedForTaskId`: the (urgent) task it makes room for; it resumes on its own once that settles.
 * Refused for a task waiting for an approval and for a settled one.
 */
export async function pauseTask(
  taskId: string,
  opts: { by: Actor; reason: string; pausedForTaskId?: string | null },
): Promise<Task> {
  const task = await loadTask(taskId);
  if (!PAUSABLE.includes(task.status)) throw new UserError("flow.control.errors.notPausable");
  const run = await activeRunOf(taskId);
  // The run is idle, waiting for the user; deciding its approvals (or a cancel) moves it on.
  if (run?.status === "waiting_approval") throw new UserError("flow.control.errors.waitingApproval");
  const t = await translator();
  const actor = await who(opts.by, t);
  const pausedForTaskId = opts.pausedForTaskId ?? null;

  // Paused before its run stops: the run's end then neither blocks the task nor reports it, as it is not
  // settled. Leaving the backlog also drops its wait for a place (updateTask).
  await db.update(tasks).set({ pauseReason: opts.reason, pausedForTaskId }).where(eq(tasks.id, taskId));
  const paused = await updateTask(taskId, { status: "paused" }, actor.actor);
  if (run) {
    const runReason = t("flow.control.runPaused", { by: actor.name, reason: opts.reason });
    // A queued run ends now and frees its place; one claimed meanwhile stops at its next step.
    const cancelled = run.status === "queued" && (await cancelPendingRun(run.id, runReason, "paused"));
    if (!cancelled) await requestSoftStop(run.id, runReason);
  }
  await logEvent(taskId, "paused", actor.actor, { reason: opts.reason, pausedForTaskId, runId: run?.id ?? null });

  const [forTask] = pausedForTaskId
    ? await db.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, pausedForTaskId))
    : [];
  const text = forTask
    ? t("flow.control.pausedFor", { by: actor.name, reason: opts.reason, task: forTask.title })
    : t("flow.control.paused", { by: actor.name, reason: opts.reason });
  await controlNotice(taskId, text, opts.by, actor.name);
  return paused;
}

/**
 * Goes on with a paused task (or a blocked or quiet one) in the conversation it worked in, `note` leading
 * its brief; it waits in the backlog while its dependencies are pending. `extraContinuations` gives it its
 * automatic continuations back. Returns the run it started, if any.
 */
export async function resumeTask(
  taskId: string,
  opts: { by: Actor; note?: string; extraContinuations?: number },
): Promise<{ task: Task; run: Run | null }> {
  const task = await loadTask(taskId);
  if (!RESUMABLE.includes(task.status)) throw new UserError("flow.control.errors.notResumable");
  if (await activeRunOf(taskId)) throw new TaskBusyError(taskId);
  const settings = await getSettings();
  const t = getTranslator(settingsLocale(settings));
  const actor = await who(opts.by, t);

  // `extraContinuations` more automatic continuations (at most maxContinuations) before its delegator is asked again.
  const continuations = opts.extraContinuations
    ? Math.max(0, settings.agents.maxContinuations - opts.extraContinuations)
    : task.continuations;
  // Reported again when it settles; put back as it was when it does not start.
  const reset = { pauseReason: null, pausedForTaskId: null, reportedAt: null, continuations };
  await db.update(tasks).set(reset).where(eq(tasks.id, taskId));
  await closeSystemQuestions(taskId);
  await logEvent(taskId, "resumed", actor.actor, { note: opts.note ?? null, continuations });

  let run: Run | null = null;
  try {
    if ((await pendingDependencies(taskId)).length) {
      // Backlog starts on its own once the dependencies are done.
      await updateTask(taskId, { status: "backlog" }, actor.actor);
    } else {
      const text = opts.note
        ? t("flow.control.resumedNote", { by: actor.name, note: opts.note })
        : t("flow.control.resumed", { by: actor.name });
      // A note is kept on the task too: a task that waits for a place reads it in its brief.
      const comment = opts.note ? await addTaskComment(taskId, text, "system", { kind: "notice" }) : null;
      const notice: TaskNotice = { kind: "control", text, commentId: comment?.id ?? null, from: actor.name };
      run = await startDelegatedTask(taskId, {
        parentRunId: task.delegatedByRunId,
        reason: "resumed",
        notice,
        force: opts.by === "user",
      });
    }
  } catch (error) {
    const { pauseReason, pausedForTaskId, reportedAt } = task;
    await db
      .update(tasks)
      .set({ pauseReason, pausedForTaskId, reportedAt, continuations: task.continuations })
      .where(eq(tasks.id, taskId));
    throw error;
  }
  // Its wakeups were skipped while it was paused; a run started checks them when it ends.
  if (!run) await enqueueTaskEvent({ taskId, event: "wakeups" });
  return { task: await loadTask(taskId), run };
}

/**
 * Closes the questions the platform asked about the task ("needs more time", a loop): resuming or
 * redirecting it is the answer. Left open, they would keep the task waiting for an answer that never comes.
 */
async function closeSystemQuestions(taskId: string): Promise<void> {
  await db
    .update(taskComments)
    .set({ questionStatus: "withdrawn" })
    .where(
      and(
        eq(taskComments.taskId, taskId),
        eq(taskComments.questionStatus, "open"),
        sql`${taskComments.options}->>'system' is not null`,
      ),
    );
}

/** The task, its subtasks and the tasks its runs delegated (in other projects too), at any depth. */
async function taskSubtree(rootId: string): Promise<string[]> {
  const seen = new Set([rootId]);
  for (let level = [rootId]; level.length;) {
    const delegatedByLevel = db.select({ id: runs.id }).from(runs).where(inArray(runs.taskId, level));
    const below = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(or(inArray(tasks.parentId, level), inArray(tasks.delegatedByRunId, delegatedByLevel)));
    level = below.map((b) => b.id).filter((id) => !seen.has(id));
    for (const id of level) seen.add(id);
  }
  return [...seen];
}

/** The agent whose run delegated the task, if any. */
async function delegatorAgentId(task: Task): Promise<string | null> {
  if (!task.delegatedByRunId) return null;
  const [run] = await db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, task.delegatedByRunId));
  return run?.agentId ?? null;
}

/**
 * Whether whoever gave the task hears of its cancel: someone above it (an agent's run delegated it, or a
 * schedule or trigger fired it), unless that agent cancelled it itself.
 */
async function reportsCancel(task: Task, by: Actor): Promise<boolean> {
  if (!task.delegatedByRunId && !task.reportsUp) return false;
  return typeof by !== "object" || by.agentId !== (await delegatorAgentId(task));
}

/**
 * Stops the task for good, with its subtree unless `cascade` is false: its subtasks and the tasks its
 * runs delegated. Each one is cancelled and marked reported before its runs stop, so nothing reports
 * as blocked; the root is reported to its delegator when someone else cancelled it. Returns the ids of
 * the tasks cancelled.
 */
export async function cancelTask(
  taskId: string,
  opts: { by: Actor; reason: string; cascade?: boolean },
): Promise<{ cancelled: string[] }> {
  const root = await loadTask(taskId);
  if (OVER.includes(root.status)) throw new UserError("flow.control.errors.over");
  const t = await translator();
  const actor = await who(opts.by, t);
  const tree = opts.cascade === false ? [taskId] : await taskSubtree(taskId);
  const open = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(inArray(tasks.id, tree), notInArray(tasks.status, [...OVER])));
  const ids = open.map((o) => o.id);
  const reportRoot = await reportsCancel(root, opts.by);

  // Settled and reported before their runs stop: an ending run then neither blocks nor reports them
  // (blockTask, reportDelegatedTasks). Only the root's report stays to send, when it goes up.
  const silent = ids.filter((id) => id !== taskId || !reportRoot);
  if (silent.length) await db.update(tasks).set({ reportedAt: new Date() }).where(inArray(tasks.id, silent));
  if (reportRoot) await db.update(tasks).set({ reportedAt: null }).where(eq(tasks.id, taskId));
  await db.update(tasks).set({ pauseReason: null, pausedForTaskId: null }).where(inArray(tasks.id, ids));
  for (const id of ids) await updateTask(id, { status: "cancelled" }, actor.actor);
  // Nothing waits for them any more.
  await db
    .update(taskComments)
    .set({ questionStatus: "withdrawn" })
    .where(and(inArray(taskComments.taskId, ids), eq(taskComments.questionStatus, "open")));
  await db.delete(taskWakeups).where(inArray(taskWakeups.taskId, ids));

  const runReason = t("flow.control.runCancelled", { by: actor.name, reason: opts.reason });
  const active = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(inArray(runs.taskId, ids), inArray(runs.status, [...ACTIVE_RUN_STATUSES])));
  for (const run of active) await cancelRun(run.id, runReason, stopKind(opts.by));

  for (const id of ids) {
    const text =
      id === taskId
        ? t("flow.control.cancelled", { by: actor.name, reason: opts.reason })
        : t("flow.control.cancelledWith", { by: actor.name, reason: opts.reason, task: root.title });
    await addTaskComment(id, text, "system", { kind: "notice" });
    await logEvent(id, "cancelled", actor.actor, { reason: opts.reason, rootTaskId: taskId });
  }
  if (reportRoot) await reportTask(taskId);
  return { cancelled: ids };
}

/**
 * The new assignee must be one the task's delegator could give it to (checkDelegationTarget), or, for a
 * task no agent delegated, one the acting agent could. The user's own tasks go to any enabled agent.
 */
async function assertMayTake(task: Task, target: typeof agents.$inferSelect, by: Actor): Promise<void> {
  if (!target.enabled || target.isTemplate) throw new UserError("flow.control.errors.noAgent");
  const delegatorId = (await delegatorAgentId(task)) ?? (typeof by === "object" ? by.agentId : null);
  const [delegator] = delegatorId
    ? await db.select({ id: agents.id, kind: agents.kind }).from(agents).where(eq(agents.id, delegatorId))
    : [];
  if (!delegator) return;
  const managed = await db.select({ id: projects.id }).from(projects).where(eq(projects.managerAgentId, delegator.id));
  const project = task.projectId ? await loadDelegationProject(task.projectId) : null;
  const rule = checkDelegationTarget({ ...delegator, managedProjectIds: managed.map((p) => p.id) }, target, project);
  if (!rule.ok) throw new UserError("flow.control.errors.reassign", { agent: target.slug, error: rule.error });
}

/**
 * Hands the task to another agent in the same delegator's conversation: back to the backlog before its
 * run stops (so the run's end neither blocks nor reports it), then started for the new assignee, who gets
 * the full brief with `instructions` among its comments. The send-back count is not touched; an agent's
 * reassignment counts as one of its automatic rounds (agent_rounds).
 */
async function reassign(
  task: Task,
  agentId: string,
  opts: { by: Actor; actor: Who; reason: string; instructions?: string },
  t: Translator,
): Promise<void> {
  const [target] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!target) throw new UserError("flow.control.errors.noAgent");
  await assertMayTake(task, target, opts.by);
  const run = await activeRunOf(task.id);
  await updateTask(task.id, { status: "backlog", assigneeAgentId: agentId, assignedToUser: false }, opts.actor.actor);
  const rounds =
    opts.by === "user" ? { agentRounds: 0 } : opts.by === "system" ? {} : { agentRounds: sql`${tasks.agentRounds} + 1` };
  await db
    .update(tasks)
    .set({ reportedAt: null, pauseReason: null, pausedForTaskId: null, ...rounds })
    .where(eq(tasks.id, task.id));
  if (run) {
    const runReason = t("flow.control.runReassigned", { by: opts.actor.name, agent: target.name, reason: opts.reason });
    await cancelRun(run.id, runReason, stopKind(opts.by));
  }
  if (opts.instructions) await addTaskComment(task.id, opts.instructions, opts.by, { kind: "instruction" });
  if ((await pendingDependencies(task.id)).length) return; // the backlog starts once they are done
  try {
    await startDelegatedTask(task.id, { parentRunId: task.delegatedByRunId, force: opts.by === "user" });
  } catch (error) {
    if (!isActiveTaskRunConflict(error)) throw error;
    // The old run has not stopped yet: the task takes the place it frees (startWaitingTasks), or the reaper starts it.
    await db.update(tasks).set({ waitingForSlotSince: new Date() }).where(eq(tasks.id, task.id));
  }
}

/**
 * Changes the course of a task underway: `instructions` reach its assignee as an instruction,
 * `reassignTo` (an agent id) hands it to another agent, `priority` and `deadline` change it in place
 * (a queued run moves in the queue with its priority). `reason` says why, for the run a reassignment
 * stops and the task's history.
 */
export async function redirectTask(
  taskId: string,
  opts: {
    by: Actor;
    instructions?: string;
    reassignTo?: string;
    priority?: TaskPriority;
    deadline?: Date | null;
    reason?: string;
  },
): Promise<Task> {
  const task = await loadTask(taskId);
  if (OVER.includes(task.status)) throw new UserError("flow.control.errors.over");
  const t = await translator();
  const actor = await who(opts.by, t);
  const reason = opts.reason ?? "";

  const patch = {
    ...(opts.priority ? { priority: opts.priority } : {}),
    ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
  };
  if (Object.keys(patch).length) await updateTask(taskId, patch, actor.actor);
  const newAssignee = opts.reassignTo && opts.reassignTo !== task.assigneeAgentId ? opts.reassignTo : null;
  if (newAssignee || opts.instructions) await closeSystemQuestions(taskId);
  if (newAssignee) await reassign(task, newAssignee, { ...opts, actor, reason }, t);
  else if (opts.instructions) await postInstruction(taskId, opts.instructions, opts.by);
  await logEvent(taskId, "redirected", actor.actor, {
    reason: opts.reason ?? null,
    instructions: opts.instructions ?? null,
    reassignTo: newAssignee,
    ...patch,
  });
  return loadTask(taskId);
}

/**
 * Resumes the tasks put aside for this one, now that it settled (cancelled counts). Taking the link is
 * the claim, so the task-events job and the sweeper never resume one twice. One whose paused run is still
 * stopping keeps the link for the sweeper's next look; one that cannot go on is blocked with the reason
 * and reported, so its delegator decides. Returns how many it resumed.
 */
export async function resumePausedFor(settledTaskId: string): Promise<number> {
  const claimed = await db
    .update(tasks)
    .set({ pausedForTaskId: null })
    .where(and(eq(tasks.pausedForTaskId, settledTaskId), eq(tasks.status, "paused")))
    .returning({ id: tasks.id });
  if (!claimed.length) return 0;
  const [settled] = await db.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, settledTaskId));
  const t = await translator();
  const title = settled?.title ?? settledTaskId;
  let resumed = 0;
  for (const { id } of claimed) {
    try {
      await resumeTask(id, { by: "system", note: t("flow.control.autoResumed", { task: title }) });
      resumed += 1;
    } catch (error) {
      // Its run is still stopping: the link goes back, and the follow-up sweeper resumes it later.
      if (isActiveTaskRunConflict(error)) {
        await db.update(tasks).set({ pausedForTaskId: settledTaskId }).where(eq(tasks.id, id));
        continue;
      }
      const reason = isUserError(error)
        ? translateKey(t, error.key, error.values)
        : error instanceof Error
          ? error.message
          : String(error);
      console.warn(`[control] task ${id} put aside for ${settledTaskId} did not resume: ${reason}`);
      await updateTask(id, { status: "blocked" }, "system");
      await addTaskComment(id, t("flow.control.autoResumeFailed", { task: title, reason }), "system");
      await reportTask(id);
    }
  }
  return resumed;
}
