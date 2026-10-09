import { agents, db, files, messages, runs, taskComments, tasks } from "@abotica/db";
import { and, asc, eq, sql } from "@abotica/db/orm";
import { addTaskComment, type Task, updateTask } from "../../src/index";
import type { Harness } from "../e2e-company";
import { settled } from "./flow-helpers";

const CSV = "bread,loaves\nrye,12\nsourdough,7\nbaguette,30";

const taskRow = async (id: string): Promise<Task> => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;

/** Alert notices about `taskId` in a conversation, with their text. */
async function alerts(conversationId: string | null, taskId: string) {
  if (!conversationId) return [];
  return db
    .select({ parts: messages.parts })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        sql`${messages.metadata}->>'notice' = 'alert'`,
        sql`${messages.metadata}->>'taskId' = ${taskId}`,
      ),
    );
}

/**
 * S14: handoffs and dependencies (needs a sandbox). The writer's task produces data.csv; once it is done,
 * the file is copied to the task waiting on it before that one starts, so the researcher's first brief
 * lists it and its answer comes from it. A dependency that gets blocked alerts the delegator of the task
 * waiting on it. A dependent whose assignee is disabled is blocked with the reason and reported at once
 * when its dependency is done.
 */
export default async function handoffs(h: Harness): Promise<void> {
  const [writer, researcher] = h.specialists;

  // 1. The handoff.
  const from = await h.delegatorRun();
  const producer = await h.delegate({
    to: writer,
    from,
    title: "Sales data file",
    description: `In your workspace, write a file named data.csv with exactly these four lines:\n${CSV}\nThen give it with file_share (path data.csv), and set the task to review with the output 'data.csv written'.`,
  });
  const consumer = await h.delegate({
    to: researcher,
    from,
    title: "Best-selling bread",
    description:
      "The file data.csv in your inputs lists loaves sold per bread. Read it and set the task to review with an output naming the bread that sold the most loaves and how many.",
    dependsOn: [producer.id],
    start: false,
  });

  // As a delegator does: it reviews the result once the run ended (and reported), then marks it done.
  await settled(h, producer.id, "the producer's task to settle", 8 * 60_000);
  await updateTask(producer.id, { status: "done" }, "e2e");

  const copy = await h.waitFor("data.csv handed to the waiting task", async () => {
    const [row] = await db
      .select()
      .from(files)
      .where(and(eq(files.taskId, consumer.id), eq(files.name, "data.csv")));
    return row;
  });
  const producerRunIds = (await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, producer.id))).map((r) => r.id);
  h.check(
    Boolean(copy.runId && producerRunIds.includes(copy.runId)),
    "a files row on the waiting task with run_id = the done task's run",
  );

  const consumerRun = await h.waitFor("the waiting task's first run", async () => {
    const [row] = await db.select().from(runs).where(eq(runs.taskId, consumer.id)).orderBy(asc(runs.createdAt)).limit(1);
    return row;
  });
  h.check(consumerRun.input.includes("data.csv"), "its first run's input lists the file's path");
  const answered = await h.waitFor(
    "the waiting task to settle",
    async () => {
      const row = await taskRow(consumer.id);
      return ["review", "done", "blocked"].includes(row.status) ? row : null;
    },
    { timeoutMs: 8 * 60_000 },
  );
  h.check(/baguette/i.test(answered.output ?? "") && /30/.test(answered.output ?? ""), "its output reflects the CSV");

  // 2. A dependency gets blocked: the delegator of the task waiting on it, in another conversation, hears.
  const fromA = await h.delegatorRun();
  const fromB = await h.delegatorRun();
  const blocker = await h.delegate({
    to: writer,
    from: fromA,
    title: "Supplier price list",
    description: "Not started in this scenario.",
    start: false,
  });
  const waiting = await h.delegate({
    to: researcher,
    from: fromB,
    title: "Compare supplier prices",
    description: "Not started in this scenario.",
    dependsOn: [blocker.id],
    start: false,
  });
  await addTaskComment(blocker.id, "The supplier's portal is down, so there is no price list to read.", {
    agentId: writer.id,
  });
  await updateTask(blocker.id, { status: "blocked" }, "e2e");
  const alert = await h.waitFor("the dependency alert", async () => (await alerts(fromB.conversationId, waiting.id))[0], {
    timeoutMs: 30_000,
  });
  h.check(JSON.stringify(alert.parts).includes("Compare supplier prices"), "the alert names the waiting task");

  // 3. A dependent that cannot start: its assignee is disabled when its dependency is done.
  const fromC = await h.delegatorRun();
  const first = await h.delegate({
    to: writer,
    from: fromC,
    title: "Opening hours",
    description: "Not started in this scenario.",
    start: false,
  });
  const second = await h.delegate({
    to: researcher,
    from: fromC,
    title: "Opening hours poster",
    description: "Not started in this scenario.",
    dependsOn: [first.id],
    start: false,
  });
  await db.update(agents).set({ enabled: false }).where(eq(agents.id, researcher.id));
  try {
    await updateTask(first.id, { status: "done" }, "e2e");
    const blocked = await h.waitFor(
      "the dependent to be blocked and reported",
      async () => {
        const row = await taskRow(second.id);
        return row.status === "blocked" && row.reportedAt ? row : null;
      },
      { timeoutMs: 30_000 },
    );
    const [reason] = await db
      .select({ body: taskComments.body })
      .from(taskComments)
      .where(and(eq(taskComments.taskId, blocked.id), eq(taskComments.authorKind, "system")));
    h.check(/disabled/i.test(reason?.body ?? ""), `it is blocked with the reason (${reason?.body ?? "no comment"})`);
    const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, second.id)).limit(1);
    h.check(!run, "no run was started for it");
  } finally {
    await db.update(agents).set({ enabled: true }).where(eq(agents.id, researcher.id));
  }
}
