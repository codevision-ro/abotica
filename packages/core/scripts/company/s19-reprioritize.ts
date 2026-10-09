import { db, runs } from "@abotica/db";
import { and, eq } from "@abotica/db/orm";
import { Queue } from "bullmq";
import { createRedis, QUEUE, redirectTask } from "../../src/index";
import type { Harness } from "../e2e-company";

const LONG_BRIEF =
  "Write eight short lines about Crumb's rye bread, one per step: call task_comment on this task with 'line N: <text>' for N = 1 to 8, exactly one call per step. Only after the eighth, set the task to review with all eight lines as output.";

/**
 * S19: re-prioritizing. With one run at a time and a long run holding the worker, a low task's run waits
 * in the queue with priority 5. Raising the task to urgent moves its queued job: the BullMQ job's
 * priority becomes 2, and so does runs.priority.
 */
export default async function reprioritize(h: Harness): Promise<void> {
  const [writer, researcher] = h.specialists;
  await h.setSettings("system", { runConcurrency: 1 });
  const occupier = await h.delegate({ to: writer, title: "Rye bread lines", description: LONG_BRIEF });
  await h.waitFor("the long run to hold the worker", async () => {
    const [run] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, occupier.id), eq(runs.status, "running")));
    return run;
  });

  const task = await h.delegate({
    to: researcher,
    title: "Say OK",
    description: "Set this task to review with the output OK. Nothing else is needed.",
    priority: "low",
  });
  const [queued] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.taskId, task.id), eq(runs.status, "queued")));
  h.check(Boolean(queued), "the low task's run waits in the queue");
  if (!queued) return;

  const queue = new Queue(QUEUE.runs, { connection: createRedis() });
  try {
    const before = await queue.getJob(queued.id);
    h.check(
      queued.priority === 5 && before?.priority === 5,
      `it is queued with priority 5 (${queued.priority}/${before?.priority})`,
    );

    await redirectTask(task.id, { by: "user", priority: "urgent", reason: "the client needs it now" });

    const after = await queue.getJob(queued.id);
    const [row] = await db.select().from(runs).where(eq(runs.id, queued.id));
    h.check(after?.priority === 2, `the BullMQ job's priority is now 2 (${after?.priority})`);
    h.check(row?.priority === 2, `runs.priority is now 2 (${row?.priority})`);
    h.check(row?.status === "queued", "the run itself is still the same queued run");
  } finally {
    await queue.close();
  }
}
