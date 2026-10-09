import { approvals, db, runs, taskComments, taskEvents, tasks } from "@abotica/db";
import { and, eq, gte } from "@abotica/db/orm";
import { Queue } from "bullmq";
import {
  addTaskComment,
  answerQuestion,
  createRedis,
  createTask,
  listWaitingForUser,
  type NotificationJob,
  notify,
  QUEUE,
  sendWaitingReminders,
  startDelegatedTask,
} from "../../src/index";
import type { Harness } from "../e2e-company";

const HOUR = 3_600_000;

/** Text notifications queued since `since`, newest first (the worker may have sent them already). */
async function textNotifications(since: Date): Promise<string[]> {
  const queue = new Queue<NotificationJob>(QUEUE.notifications, { connection: createRedis() });
  try {
    const jobs = await queue.getJobs(["waiting", "active", "completed", "failed", "delayed"], 0, 200);
    return jobs
      .filter((j) => j.timestamp >= since.getTime() && j.data.kind === "text")
      .map((j) => (j.data.kind === "text" ? j.data.text : ""));
  } finally {
    await queue.close();
  }
}

/**
 * S17: one list of what waits for the user. An approval, a question that reached the user and a task
 * assigned to them are all in listWaitingForUser; a sweep after reminderHours sends one notification
 * listing the three and marks them reminded, and a second sweep in the same window sends nothing. The
 * user's answer takes the question off the list and reaches the asker, who finishes with it.
 *
 * The reminder sweeps run on the whole database: other items already waiting in the dev install are
 * listed and marked too (their next reminder comes about an hour later).
 */
export default async function waitingForYou(h: Harness): Promise<void> {
  const [writer] = h.specialists;
  const stamp = Date.now().toString(36);
  await h.setSettings("reports", { reminderHours: 1 });

  // An approval: pending on a run of the manager's.
  const run = await h.delegatorRun();
  const [approval] = await db
    .insert(approvals)
    .values({
      runId: run.id,
      agentId: h.manager.id,
      approvalId: `e2e-s17-${stamp}`,
      toolName: `e2e_tool_${stamp}`,
      toolCallId: `e2e-s17-${stamp}`,
      input: { note: "E2E approval" },
    })
    .returning();

  // A question that reached the user, on the writer's task; the writer waits for it.
  const asker = await h.delegate({
    to: writer,
    title: `Logo colour ${stamp}`,
    description:
      "You asked the user which colour the bakery's logo should be. Until the answer arrives there is nothing " +
      "to do: end your turn at once. When the answer arrives, write only the colour as your output and set " +
      "this task to review.",
    start: false,
  });
  const question = await addTaskComment(
    asker.id,
    `Which colour should the logo be? (${stamp})`,
    { agentId: writer.id },
    { kind: "question", questionStatus: "open", addressedToUser: true, options: { options: ["blue", "green"] } },
  );
  await notify({ kind: "question", questionId: question.id });
  await startDelegatedTask(asker.id, { parentRunId: asker.delegatedByRunId });

  // A task for the user.
  const mine = await createTask(
    { title: `Call the flour supplier ${stamp}`, projectId: h.project.id, assignedToUser: true },
    "e2e",
  );
  h.track.task(mine.id);

  const listed = (await listWaitingForUser()).filter((i) => [approval!.id, question.id, mine.id].includes(i.id));
  h.check(listed.length === 3, `listWaitingForUser has the three items (${listed.length})`);
  h.check(
    new Set(listed.map((i) => i.kind)).size === 3 &&
      listed.some((i) => i.kind === "approval") &&
      listed.some((i) => i.kind === "question") &&
      listed.some((i) => i.kind === "task"),
    `of three kinds (${listed.map((i) => i.kind).join(", ")})`,
  );

  // The asker's first run ends while its question is open: the task waits, unreported.
  const waiting = await h.waitFor("the writer's first run to end", async () => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, asker.id));
    const [active] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.taskId, asker.id), eq(runs.status, "succeeded")));
    return active && row ? row : null;
  });
  h.check(waiting.status === "in_progress" && !waiting.reportedAt, `the asker waits in progress (${waiting.status})`);

  const sweepAt = new Date(Date.now() + HOUR + 60_000);
  const since = new Date();
  const sent = await sendWaitingReminders(sweepAt);
  h.check(sent >= 3, `the reminder sweep lists the items (${sent})`);
  const texts = await h.waitFor("the reminder notification", async () => {
    const found = (await textNotifications(since)).filter((text) => text.includes(stamp));
    return found.length ? found : null;
  });
  h.check(texts.length === 1, `one notification (${texts.length})`);
  const text = texts[0] ?? "";
  h.check(
    [`e2e_tool_${stamp}`, `Which colour should the logo be? (${stamp})`, `Call the flour supplier ${stamp}`].every((s) =>
      text.includes(s),
    ),
    "the notification lists all three",
  );
  const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, approval!.id));
  const [questionRow] = await db.select().from(taskComments).where(eq(taskComments.id, question.id));
  const reminded = await db
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, mine.id), eq(taskEvents.type, "user-reminded")));
  h.check(
    Boolean(approvalRow?.remindedAt && questionRow?.remindedAt) && reminded.length === 1,
    "reminded_at is set on the approval and the question, and the task is marked reminded",
  );

  const again = await sendWaitingReminders(new Date(sweepAt.getTime() + 60_000));
  h.check(again === 0, `a second sweep in the same window sends nothing (${again})`);
  const remindedAgain = await db
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, mine.id), eq(taskEvents.type, "user-reminded")));
  h.check(remindedAgain.length === 1, "the task was not reminded twice");

  // The user answers.
  const answeredAt = new Date();
  await answerQuestion(question.id, "blue", "user");
  const after = await listWaitingForUser();
  h.check(!after.some((i) => i.id === question.id), "the answered question left the list");
  const [closed] = await db.select().from(taskComments).where(eq(taskComments.id, question.id));
  h.check(closed?.questionStatus === "answered", `the question is answered (${closed?.questionStatus})`);
  const done = await h.waitFor(
    "the asker to finish with the answer",
    async () => {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, asker.id));
      return row && ["review", "done"].includes(row.status) ? row : null;
    },
    { timeoutMs: 3 * 60_000 },
  );
  const woken = await db
    .select({ id: runs.id, conversationId: runs.conversationId })
    .from(runs)
    .where(and(eq(runs.taskId, asker.id), gte(runs.createdAt, answeredAt)));
  h.check(woken.length >= 1, `the answer woke the asker (${woken.length} run)`);
  h.check(/blue/i.test(done.output ?? ""), `the asker used the answer (${done.output ?? "no output"})`);
}
