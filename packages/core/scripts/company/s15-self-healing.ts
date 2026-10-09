import { db, messages, runs, taskComments, taskEvents, tasks } from "@abotica/db";
import { and, asc, eq, ne, sql } from "@abotica/db/orm";
import { publish, type Run, sweepFollowUps, type Task, taskFailureStreak, updateTask } from "../../src/index";
import { failRun } from "../../src/runs/run-lifecycle";
import type { Harness } from "../e2e-company";

const MINUTE = 60_000;
const REASON = "E2E: the provider rate limited the run";

const taskRow = async (id: string): Promise<Task> => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const runRow = async (id: string): Promise<Run> => (await db.select().from(runs).where(eq(runs.id, id)))[0]!;

/** Whether the task ever went to blocked (its task_events). */
async function wentBlocked(taskId: string): Promise<boolean> {
  const [event] = await db
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        eq(taskEvents.type, "updated"),
        sql`${taskEvents.data}->'status'->>'to' = 'blocked'`,
      ),
    );
  return Boolean(event);
}

/** A queued run of the task that no job will execute, standing in for one the worker has not claimed yet. */
async function queuedRun(task: Task, from: Run, attempt = 1): Promise<Run> {
  await updateTask(task.id, { status: "in_progress" }, "e2e");
  const [run] = await db
    .insert(runs)
    .values({
      agentId: task.assigneeAgentId,
      trigger: "delegation",
      status: "queued",
      input: "E2E: a run that fails before it starts",
      taskId: task.id,
      projectId: task.projectId,
      parentRunId: from.id,
      attempt,
    })
    .returning();
  return run!;
}

/**
 * S15: self-healing. (a) A run cut by a worker restart is retried by itself in the same conversation and
 * its task completes, with nothing blocked and nothing counted. (b) A rate-limited run gets its retry about
 * a minute later, which the sweep starts. (c) With one retry allowed, a second failure blocks the task
 * saying it gave up after the automatic retries, and the report says why.
 */
export default async function selfHealing(h: Harness): Promise<void> {
  const [writer] = h.specialists;

  // (a) Worker restart.
  const fromA = await h.delegatorRun();
  const cut = await h.delegate({
    to: writer,
    from: fromA,
    title: "Three slogans",
    description:
      "Write three short slogans for Crumb, one per step: call task_comment with 'slogan N: <slogan>' for N=1..3, one call per step. Then set the task to review with the three slogans as output.",
  });
  const first = await h.waitFor("the writer's run to be running", async () => {
    const [row] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, cut.id), eq(runs.status, "running")));
    return row;
  });
  await publish({ type: "run.cancel", runId: first.id, reason: "E2E: the worker restarts", kind: "worker_restarted" });
  const cancelled = await h.waitFor("the cut run to end", async () => {
    const row = await runRow(first.id);
    return row.status !== "running" ? row : null;
  });
  h.check(
    cancelled.status === "cancelled" && cancelled.failureKind === "worker_restarted",
    `the run is cancelled/worker_restarted (${cancelled.status}/${cancelled.failureKind})`,
  );
  h.check(Boolean(cancelled.retryAt || cancelled.retriedByRunId), "it has a retry scheduled");
  const retry = await h.waitFor(
    "the retry run",
    async () => {
      const [row] = await db
        .select()
        .from(runs)
        // Not by created_at: the database keeps microseconds, a Date only milliseconds.
        .where(and(eq(runs.taskId, cut.id), ne(runs.id, first.id)));
      return row;
    },
    { timeoutMs: 90_000 },
  );
  h.check(retry.attempt === 2, `the retry is attempt 2 (${retry.attempt})`);
  h.check(retry.conversationId === first.conversationId, "in the same conversation");
  h.check(retry.createdAt.getTime() - cancelled.finishedAt!.getTime() <= 60_000, "within 60 s");
  const completed = await h.waitFor("the task to complete", async () => {
    const row = await taskRow(cut.id);
    return row.status === "review" || row.status === "done" ? row : null;
  });
  h.check(!(await wentBlocked(cut.id)), "the task never went to blocked");
  h.check(completed.redelegations === 0, "redelegations = 0");
  h.check((await taskFailureStreak(cut.id)).failures === 0, "no failure counted by the circuit breaker");

  // (b) Rate limited: the retry is due about a minute later, and the sweep starts it.
  const fromB = await h.delegatorRun();
  const limited = await h.delegate({
    to: writer,
    from: fromB,
    title: "One slogan",
    description: "Write one short slogan for Crumb and set the task to review with it as output.",
    start: false,
  });
  const queued = await queuedRun(limited, fromB);
  const failedAt = Date.now();
  await failRun(queued, REASON, "rate_limited", ["queued"]);
  h.expectFailure(queued.id);
  const scheduled = await runRow(queued.id);
  const wait = scheduled.retryAt ? scheduled.retryAt.getTime() - failedAt : null;
  h.check(
    wait !== null && wait >= 0.9 * MINUTE - 2_000 && wait <= 1.1 * MINUTE + 2_000,
    `retry_at is about a minute later (${wait === null ? "none" : `${Math.round(wait / 1000)} s`})`,
  );
  if (scheduled.retryAt) await sweepFollowUps(new Date(scheduled.retryAt.getTime() + 1_000));
  const retried = await h.waitFor("the rate-limited run's retry", async () => {
    const [row] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, limited.id), eq(runs.attempt, 2)));
    return row;
  });
  h.check(
    (await runRow(queued.id)).retriedByRunId === retried.id,
    "the retry started after the sweep, linked to the failed run",
  );

  // (c) Retries used up: blocked, with the reason in the report.
  await h.setSettings("agents", { transientRetries: 1 });
  const fromC = await h.delegatorRun();
  const doomed = await h.delegate({
    to: writer,
    from: fromC,
    title: "Another slogan",
    description: "Not started in this scenario.",
    start: false,
  });
  const once = await queuedRun(doomed, fromC);
  await failRun(once, REASON, "rate_limited", ["queued"]);
  h.expectFailure(once.id);
  // The retry, as startRetry makes it (with no job, so the worker does not take it first).
  await db.update(runs).set({ retryAt: null }).where(eq(runs.id, once.id));
  const twice = await queuedRun(doomed, fromC, 2);
  await db.update(runs).set({ retriedByRunId: twice.id }).where(eq(runs.id, once.id));
  await failRun(twice, REASON, "rate_limited", ["queued"]);
  h.expectFailure(twice.id);

  const blocked = await taskRow(doomed.id);
  h.check(blocked.status === "blocked", `the task is blocked (${blocked.status})`);
  const [comment] = await db
    .select({ body: taskComments.body })
    .from(taskComments)
    .where(and(eq(taskComments.taskId, doomed.id), eq(taskComments.authorKind, "system")))
    .orderBy(sql`${taskComments.createdAt} desc`)
    .limit(1);
  h.check(/automatic retr/.test(comment?.body ?? ""), `it says it gave up after the automatic retries (${comment?.body})`);
  const report = await h.waitFor("the report of the blocked task", async () => {
    const rows = await db
      .select({ parts: messages.parts })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, fromC.conversationId!),
          sql`${messages.metadata}->'tasks' @> ${JSON.stringify([{ id: doomed.id }])}::jsonb`,
        ),
      )
      .orderBy(asc(messages.createdAt));
    return rows[0];
  });
  h.check(JSON.stringify(report.parts).includes(REASON), "the report text contains the reason");
}
