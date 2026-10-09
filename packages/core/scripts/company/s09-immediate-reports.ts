import { db, tasks } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { startDelegatedTask } from "../../src/index";
import type { Harness } from "../e2e-company";
import { hold, reportsIn, runsOfTask, settled, taskRow } from "./flow-helpers";

/**
 * S09: each result goes up as soon as its task settles. A short and a long task from one manager
 * conversation: the short one is reported alone, before the long one's run ends. With a report group,
 * the two come back in one report once both settled. The manager is kept out of its conversation, so it
 * changes nothing on the tasks while the reports arrive.
 */
export default async function immediateReports(h: Harness): Promise<void> {
  const [writer, researcher] = h.specialists;
  const SHORT = "Set this task to review right away with the output SHORT-DONE. Nothing else.";
  const LONG =
    "Work in eight steps: call task_comment on this task with 'step N' once per step, for N = 1 to 8, one call per step. Then set the task to review with the output LONG-DONE.";

  const from = await h.delegatorRun();
  await hold(h, from.conversationId!, h.manager.id);
  const t1 = await h.delegate({ to: writer, from, title: "Short task", description: SHORT });
  const t2 = await h.delegate({ to: researcher, from, title: "Long task", description: LONG });
  await settled(h, t1.id, "the short task to settle");
  const first = await h.waitFor("the short task's report", async () =>
    (await reportsIn(from.conversationId!)).find((r) => r.taskIds.includes(t1.id)),
  );
  await settled(h, t2.id, "the long task to settle");
  const longRun = (await runsOfTask(t2.id)).at(-1)!;
  h.check(first.taskIds.length === 1, `the short task's report lists it alone (${first.taskIds.length})`);
  h.check(
    Boolean(longRun.finishedAt) && first.createdAt < longRun.finishedAt!,
    "the short task was reported before the long task's run ended",
  );
  await h.waitFor("the long task's own report", async () =>
    (await reportsIn(from.conversationId!)).find((r) => r.taskIds.includes(t2.id)),
  );

  const together = await h.delegatorRun();
  await hold(h, together.conversationId!, h.manager.id);
  const t3 = await h.delegate({
    to: writer,
    from: together,
    start: false,
    title: "Short grouped task",
    description: SHORT,
  });
  const t4 = await h.delegate({
    to: researcher,
    from: together,
    start: false,
    title: "Long grouped task",
    description: LONG,
  });
  await db.update(tasks).set({ reportGroup: "g" }).where(eq(tasks.id, t3.id));
  await db.update(tasks).set({ reportGroup: "g" }).where(eq(tasks.id, t4.id));
  for (const t of [t3, t4]) await startDelegatedTask(t.id, { parentRunId: together.id });
  await settled(h, t3.id, "the short grouped task to settle");
  await settled(h, t4.id, "the long grouped task to settle");
  await h.waitFor(
    "both grouped tasks reported",
    async () => (await taskRow(t3.id)).reportedAt && (await taskRow(t4.id)).reportedAt,
  );
  const reports = (await reportsIn(together.conversationId!)).filter(
    (r) => r.taskIds.includes(t3.id) || r.taskIds.includes(t4.id),
  );
  h.check(reports.length === 1, `one report for the group (${reports.length})`);
  h.check(reports[0]?.taskIds.length === 2, "it lists both tasks");
  const lastEnd = Math.max(
    ...(await Promise.all([t3, t4].map(async (t) => (await runsOfTask(t.id)).at(-1)!.finishedAt?.getTime() ?? 0))),
  );
  h.check((reports[0]?.createdAt.getTime() ?? 0) >= lastEnd, "it came after both settled");
}
