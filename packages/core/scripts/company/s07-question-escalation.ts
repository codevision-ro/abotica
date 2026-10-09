import { conversations, db, runs, taskComments } from "@abotica/db";
import { and, eq, gt } from "@abotica/db/orm";
import { Queue } from "bullmq";
import {
  answerQuestion,
  askQuestion,
  createRedis,
  listWaitingForUser,
  QUEUE,
  sweepFollowUps,
  updateTask,
} from "../../src/index";
import type { Harness } from "../e2e-company";
import { hold, noticesIn } from "./flow-helpers";

/**
 * S07: a question nobody answers goes up. The writer's question to the manager waits (asked without a
 * wake); a sweep past questionEscalationMinutes moves it to the super agent, a sweep past
 * userEscalationMinutes to the user's list, with a notification. The user's answer reaches the asker,
 * and the manager and the super agent only hear of it.
 */
export default async function questionEscalation(h: Harness): Promise<void> {
  const [writer] = h.specialists;
  await h.setSettings("agents", { questionEscalationMinutes: 1, userEscalationMinutes: 2 });

  // The chain: the super agent gave the manager its task, the manager gave the writer its own.
  const superRun = await h.delegatorRun({ agentId: h.orchestrator.id, projectId: null });
  await db.update(conversations).set({ modelOverride: h.model }).where(eq(conversations.id, superRun.conversationId!));
  // The super agent only receives here: it must not answer the question itself.
  await hold(h, superRun.conversationId!, h.orchestrator.id);
  const managerTask = await h.delegate({
    to: h.manager,
    from: superRun,
    start: false,
    title: "Crumb's spring campaign",
    description: "Plan the spring campaign.",
  });
  const managerRun = await h.delegatorRun({ taskId: managerTask.id });
  const task = await h.delegate({
    to: writer,
    from: managerRun,
    start: false,
    title: "Spring flyer text",
    description:
      "An answer to your question about the flyer arrives here. Set the task to review with one line that repeats the answer word for word.",
  });
  // The writer worked on it once already, so the answer has a round to wake: in progress, as a task is
  // while its agent waits for an answer.
  await updateTask(task.id, { status: "in_progress" }, "e2e");
  const writerRun = await h.delegatorRun({ agentId: writer.id, taskId: task.id });
  await db.update(conversations).set({ modelOverride: h.model }).where(eq(conversations.id, writerRun.conversationId!));

  const asked = await askQuestion(
    task.id,
    { question: "Which month does the spring flyer go out?", options: ["March", "April"] },
    { agentId: writer.id },
    { runId: writerRun.id, wake: "never" },
  );
  const questionId = asked.comment.id;
  const question = async () => (await db.select().from(taskComments).where(eq(taskComments.id, questionId)))[0]!;
  h.check(asked.comment.addresseeAgentId === h.manager.id, "the question is addressed to the manager");

  await sweepFollowUps(new Date(Date.now() + 61_000));
  const up = await question();
  h.check(up.escalationLevel === 1, `escalation level 1 (${up.escalationLevel})`);
  h.check(up.addresseeAgentId === h.orchestrator.id, "the question is now the super agent's");
  h.check(
    (await noticesIn(superRun.conversationId!, "question", task.id)).length > 0,
    "a question notice reached the super agent's conversation",
  );

  await sweepFollowUps(new Date(Date.now() + 121_000));
  const top = await question();
  h.check(top.addressedToUser, "the question reached the user");
  const waiting = await listWaitingForUser();
  h.check(
    waiting.some((item) => item.kind === "question" && item.id === questionId),
    "it is in the user's waiting list",
  );
  const notifications = new Queue(QUEUE.notifications, { connection: createRedis() });
  try {
    const jobs = await notifications.getJobs(["waiting", "active", "completed", "delayed", "failed"]);
    h.check(
      jobs.some((job) => job.data?.kind === "question" && job.data?.questionId === questionId),
      "a notification job for the question was queued",
    );
  } finally {
    await notifications.close();
  }

  const answeredAt = new Date();
  const answer = await answerQuestion(questionId, "April", "user");
  h.check(["woke", "steered", "slot"].includes(answer.delivered), `the asker gets the answer (${answer.delivered})`);
  h.check(
    (await noticesIn(writerRun.conversationId!, "answer", task.id)).length > 0,
    "the answer notice is in the writer's conversation",
  );
  h.check((await noticesIn(managerRun.conversationId!, "answer", task.id)).length > 0, "the manager got an FYI");
  h.check((await noticesIn(superRun.conversationId!, "answer", task.id)).length > 0, "the super agent got an FYI");
  const woken = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(gt(runs.createdAt, answeredAt), eq(runs.conversationId, managerRun.conversationId!)));
  const superWoken = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(gt(runs.createdAt, answeredAt), eq(runs.conversationId, superRun.conversationId!)));
  h.check(woken.length === 0 && superWoken.length === 0, "the FYIs woke neither the manager nor the super agent");
}
