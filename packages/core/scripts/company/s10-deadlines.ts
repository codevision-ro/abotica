import { conversations, db, messages, runEvents, runs, taskEvents, tasks } from "@abotica/db";
import { and, asc, eq, gt, ne, sql } from "@abotica/db/orm";
import { sweepFollowUps, type Task, updateTask } from "../../src/index";
import type { Harness } from "../e2e-company";

const MINUTE = 60_000;
/** Long enough that the worker's own sweep (real time) never finds the quiet task stale during the run. */
const STALE_MINUTES = 30;
const ESCALATION_MINUTES = 1;

/** Notices of `kind` about `taskId` in a conversation. */
async function notices(conversationId: string | null, taskId: string, kind: string) {
  if (!conversationId) return [];
  return db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        sql`${messages.metadata}->>'kind' = 'task-notice'`,
        sql`${messages.metadata}->>'notice' = ${kind}`,
        sql`${messages.metadata}->>'taskId' = ${taskId}`,
      ),
    );
}

const taskRow = async (id: string): Promise<Task> => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;

const followUps = (taskId: string) =>
  db
    .select({ data: taskEvents.data })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, "followed-up")))
    .orderBy(asc(taskEvents.createdAt), asc(taskEvents.id));

/**
 * S10: deadlines and quiet tasks. The super agent gave the manager a task, and the manager gave the
 * writer one due in 5 minutes. The sweep, moved in time, reminds the writer, alerts the manager once the
 * deadline passed (which wakes it), then the super agent once it stays missed; a new deadline clears all
 * three. A task left in progress with nothing moving it is followed up twice with the manager, then once
 * with the user, then never again.
 */
export default async function deadlines(h: Harness): Promise<void> {
  await h.setSettings("agents", { staleTaskMinutes: STALE_MINUTES, deadlineEscalationMinutes: ESCALATION_MINUTES });
  const [writer] = h.specialists;

  // The chain: super agent -> manager (task M) -> writer (task T).
  const superRun = await h.delegatorRun({ agentId: h.orchestrator.id });
  await db.update(conversations).set({ modelOverride: h.model }).where(eq(conversations.id, superRun.conversationId!));
  const managerTask = await h.delegate({
    to: h.manager,
    from: superRun,
    title: "Newsletter for October",
    description: "Get the October newsletter written by the team.",
    start: false,
  });
  await updateTask(managerTask.id, { status: "in_progress" }, "e2e");
  const managerRun = await h.delegatorRun({ taskId: managerTask.id });

  // A quiet task first, while no run is going: in progress, no run, nothing pending. All four sweeps run
  // before the woken manager can react. It is delegated from a conversation of its own.
  const quietFrom = await h.delegatorRun({ taskId: managerTask.id });
  const quiet = await h.delegate({
    to: writer,
    from: quietFrom,
    title: "Quiet task",
    description: "A placeholder for the scenario: set the task to review with the output 'ok'.",
    start: false,
  });
  await updateTask(quiet.id, { status: "in_progress" }, "e2e");
  const since = (await taskRow(quiet.id)).activityAt.getTime();
  const stale = (n: number) => new Date(since + n * (STALE_MINUTES + 1) * MINUTE);
  for (const n of [1, 2, 3, 4]) await sweepFollowUps(stale(n));

  const sent = (await followUps(quiet.id)).map((e) => e.data as { count: number; to: string });
  h.check(
    JSON.stringify(sent.map((e) => [e.count, e.to])) ===
      JSON.stringify([
        [1, "superior"],
        [2, "superior"],
        [3, "user"],
      ]),
    `follow-ups 1 and 2 went to the manager, the third to the user, then none (${JSON.stringify(sent)})`,
  );
  h.check((await taskRow(quiet.id)).followUps === 3, "the quiet task counts 3 follow-ups");
  h.check(
    (await notices(quietFrom.conversationId, quiet.id, "alert")).length === 2,
    "two follow-up alerts reached the manager's conversation",
  );

  const deadline = new Date(Date.now() + 5 * MINUTE);
  const task = await h.delegate({
    to: writer,
    from: managerRun,
    title: "October newsletter intro",
    deadline,
    description:
      "Write a three-sentence intro for Crumb's October newsletter. Work in steps: call task_comment with 'step N' once per step for N=1..6, one call per step, then set the task to review with the intro as output.",
  });

  const running = await h.waitFor("the writer's run to be running", async () => {
    const [row] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, task.id), eq(runs.status, "running")));
    return row;
  });

  // Reminder: due well before the deadline; delivered into the active run (steered) or its conversation.
  await sweepFollowUps(new Date(deadline.getTime() - MINUTE));
  h.check(Boolean((await taskRow(task.id)).deadlineRemindedAt), "the deadline reminder was sent");
  const reminded = await h.waitFor("the reminder in the writer's run", async () => {
    const [steered] = await db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(
        and(
          eq(runEvents.runId, running.id),
          eq(runEvents.type, "steered"),
          sql`jsonb_path_exists(${runEvents.data}, '$.messages[*] ? (@.notice == "reminder")')`,
        ),
      );
    if (steered) return "steered";
    return (await notices(running.conversationId, task.id, "reminder")).length ? "stored in its conversation" : null;
  });
  h.check(true, `the reminder reached the writer (${reminded})`);

  // Missed, then escalated: both sweeps before the woken manager can move the deadline.
  const missedAt = new Date(deadline.getTime() + 1_000);
  await sweepFollowUps(missedAt);
  await sweepFollowUps(new Date(missedAt.getTime() + ESCALATION_MINUTES * MINUTE + 1_000));
  const late = await taskRow(task.id);
  h.check(Boolean(late.deadlineMissedAt), "deadline_missed_at is set");
  h.check(Boolean(late.deadlineEscalatedAt), "deadline_escalated_at is set");
  h.check(
    (await notices(managerRun.conversationId, task.id, "alert")).length >= 1,
    "an alert about the missed deadline is in the manager's conversation",
  );
  const managerWoken = await h.waitFor("a manager run woken by the alert", async () => {
    const [row] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.conversationId, managerRun.conversationId!),
          gt(runs.createdAt, managerRun.createdAt),
          ne(runs.id, managerRun.id),
        ),
      );
    return row;
  });
  h.check(Boolean(managerWoken), "a manager run started for the missed deadline");
  h.check(
    (await notices(superRun.conversationId, task.id, "alert")).length >= 1,
    "the escalation alert is in the super agent's conversation",
  );

  // A new deadline gets its own reminder, miss and escalation.
  await updateTask(task.id, { deadline: new Date(Date.now() + 60 * MINUTE) }, "e2e");
  const moved = await taskRow(task.id);
  h.check(
    !moved.deadlineRemindedAt && !moved.deadlineMissedAt && !moved.deadlineEscalatedAt,
    "a new deadline clears the reminder, miss and escalation",
  );
}
