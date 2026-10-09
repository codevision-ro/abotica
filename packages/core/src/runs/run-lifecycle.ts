import { agents, approvals, db, runEvents, runs, tasks } from "@abotica/db";
import { and, eq, inArray } from "@abotica/db/orm";
import { getTranslator, type Translator } from "@abotica/i18n";
import { publish } from "../infra/events";
import { enqueueDelegationReport, enqueueTaskEvent, notify, runJobState, type RunJobState } from "../infra/queues";
import { redis } from "../infra/redis";
import { getSettings, settingsLocale } from "../settings/settings";
import { addTaskComment, awaitsDelegatedWork, awaitsWakeup, updateTask } from "../tasks/tasks";
import type { RunFailureKind } from "./run-failures";
import { interruptRunMessage } from "./run-messages";

/**
 * Every status change of a run goes through here: the worker claims and ends the runs it executes,
 * cancels and the kill switch end the ones not executing, the reaper ends the ones nothing executes any
 * more. Each change is conditional on the status it leaves, so two of them never both apply. Safe for
 * the web app to import: no runner, sandbox or MCP runtime.
 */

type Run = typeof runs.$inferSelect;
type RunStatus = Run["status"];

export const publishRunUpdate = (run: Run) =>
  publish({
    type: "run.updated",
    runId: run.id,
    agentId: run.agentId,
    conversationId: run.conversationId,
    status: run.status,
  });

export async function logRunEvent(runId: string, type: string, data: Record<string, unknown>) {
  await db.insert(runEvents).values({ runId, type, data });
}

const resumeKey = (conversationId: string) => `abotica:conv:${conversationId}:resume`;

/** Marks a conversation to be continued once its active run ends (e.g. an approval decided meanwhile). */
export async function requestResume(conversationId: string): Promise<void> {
  await redis().set(resumeKey(conversationId), "1", "EX", 24 * 3600);
}

/** Whether the conversation was marked to be continued; clears the mark. */
export async function takeResumeRequest(conversationId: string): Promise<boolean> {
  return (await redis().getdel(resumeKey(conversationId))) !== null;
}

const heldRepliesKey = (conversationId: string) => `abotica:conv:${conversationId}:held-replies`;

/** Counts one more reply held back in a row in the conversation; returns how many that makes. */
export async function countHeldReply(conversationId: string): Promise<number> {
  const key = heldRepliesKey(conversationId);
  const held = await redis().incr(key);
  await redis().expire(key, 24 * 3600);
  return held;
}

/** A reply reached the user: the next one may be held again. */
export async function clearHeldReplies(conversationId: string): Promise<void> {
  await redis().del(heldRepliesKey(conversationId));
}

const translator = async () => getTranslator(settingsLocale(await getSettings()));

/** Side effects of an ending run: one that fails is logged and does not skip the others. */
async function attempt<T>(runId: string, what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    console.error(`[runs] ${what} for run ${runId} failed:`, error);
    return null;
  }
}

/** Moves a run out of one of `from`; null when it is in none of them any more (someone else moved it). */
async function transition(
  id: string,
  from: RunStatus[],
  patch: Partial<typeof runs.$inferInsert> & { status: RunStatus },
): Promise<Run | null> {
  const [run] = await db
    .update(runs)
    .set(patch)
    .where(and(eq(runs.id, id), inArray(runs.status, from)))
    .returning();
  if (!run) return null;
  await attempt(id, "publishing the status", () => publishRunUpdate(run));
  return run;
}

/** Reports the run's delegated task (with the others of its round) back to the delegator, through the queue. */
const reportBack = (run: Run) => attempt(run.id, "queueing its delegation report", () => enqueueDelegationReport(run.id));

/** A task left in progress by a run that ended without settling it is blocked with the reason. */
async function blockTask(run: Run, comment: (t: Translator) => string) {
  if (!run.taskId) return;
  const [task] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, run.taskId));
  if (task?.status !== "in_progress") return;
  await updateTask(run.taskId, { status: "blocked" }, "system");
  await addTaskComment(run.taskId, comment(await translator()), "system");
}

/** The pending approvals of a run that will not continue: expired, so a stale call is never approved and run. */
const expireApprovals = (runId: string) =>
  attempt(runId, "expiring its approvals", () =>
    db
      .update(approvals)
      .set({ status: "expired", decidedAt: new Date() })
      .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending"))),
  );

/**
 * Takes a queued run for execution. Null when it is gone or no longer queued (cancelled meanwhile, or
 * taken by another worker): it must not run.
 */
export function claimRun(id: string): Promise<Run | null> {
  return transition(id, ["queued"], { status: "running", startedAt: new Date() });
}

/** Ends a running run that answered (or waits for approvals); `actor` moves its task to review. */
export async function finishRun(
  run: Run,
  end: { status: "succeeded" | "waiting_approval"; output: string; error?: string | null; actor: string },
): Promise<Run | null> {
  const finished = await transition(run.id, ["running"], {
    status: end.status,
    output: end.output,
    error: end.error ?? null,
    finishedAt: new Date(),
  });
  if (!finished) return null;
  if (finished.status === "waiting_approval") return settleIfDecided(finished);
  if (finished.status === "succeeded") {
    await attempt(run.id, "moving its task to review", async () => {
      if (!finished.taskId) return;
      const [task] = await db.select().from(tasks).where(eq(tasks.id, finished.taskId));
      if (task?.status !== "in_progress") return;
      // A task waiting for a wakeup stays in progress: checked now, a condition already true fires.
      if (await awaitsWakeup(task.id)) return enqueueTaskEvent({ taskId: task.id, event: "wakeups" });
      // A task whose work was handed on stays in progress until that work is reported back here.
      if (!(await awaitsDelegatedWork(finished.conversationId))) {
        await updateTask(task.id, { status: "review", output: task.output ?? end.output }, end.actor);
      }
    });
    if (finished.trigger !== "chat" && finished.trigger !== "telegram") {
      await attempt(run.id, "notifying", () => notify({ kind: "run-finished", runId: run.id }));
    }
  }
  await reportBack(finished);
  return finished;
}

/**
 * A run whose approvals were all decided before it reached waiting_approval: decideApproval found it
 * still running and asked for a follow-up, which continues the conversation once this run's job ends.
 * The run itself must not stay waiting (it would hold its task), so it ends here, unless decideApproval
 * claimed it first now that it waits.
 */
async function settleIfDecided(run: Run): Promise<Run> {
  const [pending] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.runId, run.id), eq(approvals.status, "pending")))
    .limit(1);
  if (pending) return run;
  const settled = await transition(run.id, ["waiting_approval"], { status: "succeeded" });
  if (!settled) return run;
  if (settled.conversationId) {
    const { conversationId } = settled;
    await attempt(run.id, "asking for its continuation", () => requestResume(conversationId));
  }
  return settled;
}

/**
 * Ends a run as failed: the error and its kind are stored and logged, its pending approvals expire (a
 * worker that dies after asking leaves some), its task is blocked with the error, the user notified and
 * the delegator told. Never throws: a failure that cannot be recorded is logged, and the reaper ends the
 * run later.
 */
export async function failRun(
  run: Run,
  error: string,
  kind: RunFailureKind,
  from: RunStatus[] = ["queued", "running"],
): Promise<Run | null> {
  const failed = await attempt(run.id, "recording the failure", () =>
    transition(run.id, from, { status: "failed", error, failureKind: kind, finishedAt: new Date() }),
  );
  if (!failed) return null;
  await attempt(run.id, "logging the error", () => logRunEvent(run.id, "error", { message: error, kind }));
  await expireApprovals(run.id);
  await attempt(run.id, "blocking its task", () => blockTask(failed, (t) => t("errors.run.taskComment", { error })));
  await attempt(run.id, "notifying", () => notify({ kind: "run-finished", runId: run.id }));
  await reportBack(failed);
  return failed;
}

/** Blocks the tasks of cancelled runs, then reports them: tasks cancelled together are reported together. */
async function settleCancelled(cancelled: Run[], reason: string): Promise<void> {
  for (const run of cancelled) {
    await attempt(run.id, "blocking its task", () => blockTask(run, (t) => t("runs.lifecycle.taskCancelled", { reason })));
  }
  for (const run of cancelled) await reportBack(run);
}

/** Cancels a run that has not started or waits for approvals; its pending approvals expire. */
export async function cancelPendingRun(id: string, reason: string, kind: RunFailureKind): Promise<Run | null> {
  const run = await transition(id, ["queued", "waiting_approval"], {
    status: "cancelled",
    error: reason,
    failureKind: kind,
    finishedAt: new Date(),
  });
  if (!run) return null;
  await expireApprovals(id);
  await settleCancelled([run], reason);
  return run;
}

/** Ends a running run as cancelled: its worker aborted it, or the kill switch was on when it was claimed. */
export async function cancelClaimedRun(run: Run, reason: string, kind: RunFailureKind): Promise<Run | null> {
  const cancelled = await transition(run.id, ["running"], {
    status: "cancelled",
    error: reason,
    failureKind: kind,
    finishedAt: new Date(),
  });
  if (!cancelled) return null;
  await settleCancelled([cancelled], reason);
  return cancelled;
}

/** Cancels every queued run (the kill switch), so none of them starts. */
export async function cancelQueuedRuns(reason: string, kind: RunFailureKind): Promise<Run[]> {
  const cancelled = await db
    .update(runs)
    .set({ status: "cancelled", error: reason, failureKind: kind, finishedAt: new Date() })
    .where(eq(runs.status, "queued"))
    .returning();
  for (const run of cancelled) await attempt(run.id, "publishing the status", () => publishRunUpdate(run));
  await settleCancelled(cancelled, reason);
  return cancelled;
}

/** A run's row is inserted just before its job is added: a younger queued run may not have its job yet. */
const ENQUEUE_GRACE_MS = 60_000;
/** Opening the sandbox and the MCP servers comes before the agent's timeout starts counting. */
const OVERDUE_MARGIN_MS = 15 * 60_000;
/** Job states in which a queued run is still going to be picked up. */
const PENDING_JOB_STATES: readonly RunJobState[] = ["waiting", "prioritized", "delayed", "waiting-children", "active"];

export type StaleReason = "unqueued" | "orphaned" | "overdue";

/** The failure kind of a stale run: a run whose worker is gone was cut by its restart. */
const STALE_KINDS: Record<StaleReason, RunFailureKind> = {
  unqueued: "unqueued",
  orphaned: "worker_restarted",
  overdue: "overdue",
};

/**
 * Why nothing is going to end a run any more, or null while something will: a queued run whose job is
 * gone, a running run no worker holds an active job for (its worker crashed), or a running run past its
 * agent's timeout (its worker hangs). The job id is the run id.
 */
export function staleRunReason(
  run: Pick<Run, "status" | "createdAt" | "startedAt">,
  job: RunJobState,
  timeoutMs: number,
  now: Date,
): StaleReason | null {
  if (run.status === "queued") {
    if (now.getTime() - run.createdAt.getTime() < ENQUEUE_GRACE_MS) return null;
    return PENDING_JOB_STATES.includes(job) ? null : "unqueued";
  }
  if (run.status !== "running") return null;
  if (job !== "active") return "orphaned";
  const startedAt = (run.startedAt ?? run.createdAt).getTime();
  return now.getTime() - startedAt > timeoutMs + OVERDUE_MARGIN_MS ? "overdue" : null;
}

/**
 * Fails the runs nothing is going to end (see staleRunReason), when the worker starts and periodically.
 * Runs an active job owns are left to it, so this stays correct with several workers. An overdue or
 * orphaned run may still be executing somewhere (a worker that lost its job lock keeps going): its
 * worker is asked to abort it and finds it already ended. The answer of a run that started keeps its
 * finished steps; its interrupted tool calls are closed and a note says why it stopped. Nothing is run
 * again: a retry is the user's call, and the next run sees what was done. Returns how many runs it failed.
 */
export async function recoverRuns(now = new Date()): Promise<number> {
  const active = await db
    .select({ run: runs, limits: agents.limits })
    .from(runs)
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .where(inArray(runs.status, ["queued", "running"]));
  if (!active.length) return 0;
  const settings = await getSettings();
  const t = getTranslator(settingsLocale(settings));
  const messages: Record<StaleReason, string> = {
    unqueued: t("runs.lifecycle.unqueued"),
    orphaned: t("errors.run.workerRestarted"),
    overdue: t("runs.lifecycle.overdue"),
  };
  let failed = 0;
  for (const { run, limits } of active) {
    // A deleted agent's run (agent_id set null) still has to be recovered, with the default time limit.
    const timeoutMs = (limits ?? settings.agents.defaultLimits).timeoutMs;
    const reason = staleRunReason(run, await runJobState(run.id), timeoutMs, now);
    if (!reason) continue;
    if (!(await failRun(run, messages[reason], STALE_KINDS[reason], [run.status]))) continue;
    failed += 1;
    if (reason !== "unqueued") {
      await attempt(run.id, "closing its answer", () =>
        interruptRunMessage(run, {
          toolError: t("runs.lifecycle.toolInterrupted"),
          note: t("runs.lifecycle.interrupted", { reason: messages[reason] }),
        }),
      );
      await attempt(run.id, "asking its worker to abort it", () =>
        publish({ type: "run.cancel", runId: run.id, reason: messages[reason], kind: STALE_KINDS[reason] }),
      );
    }
  }
  return failed;
}
