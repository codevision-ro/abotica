import { db, runs, taskComments } from "@abotica/db";
import { and, eq, gt, ne } from "@abotica/db/orm";
import { answerQuestion } from "../../src/index";
import type { Harness } from "../e2e-company";
import { hold, runsOfTask, settled, steeredNotices, taskRow, wait } from "./flow-helpers";

/** The task's first open question, asked by its agent. */
const openQuestion = (h: Harness, taskId: string) =>
  h.waitFor("the specialist's question", async () => {
    const [row] = await db
      .select()
      .from(taskComments)
      .where(and(eq(taskComments.taskId, taskId), eq(taskComments.kind, "question")));
    return row;
  });

/**
 * S06: asking without ending the run. (a) The answer reaches the asker while it still works: steered in,
 * used, no send-back. (b) The asker ended its turn first: the task waits in progress, unreported, and the
 * answer wakes it in the same conversation. (c) A real manager answers its specialist's question, or
 * forwards it when it is not its to decide and the super agent answers. In (a) and (b) the manager is kept
 * out of its conversation, so the harness's answer is the one used.
 */
export default async function askAnswer(h: Harness): Promise<void> {
  await answeredWhileRunning(h);
  await answeredAfterTurn(h);
  await managerAnswers(h);
}

async function answeredWhileRunning(h: Harness): Promise<void> {
  const [writer] = h.specialists;
  const from = await h.delegatorRun();
  await hold(h, from.conversationId!, h.manager.id);
  const task = await h.delegate({
    to: writer,
    from,
    title: "Logo colour note",
    description:
      "First call ask with the question 'Which colour should the new logo be?' and the options red and blue. Do not wait: then call task_comment on this task with 'still working, step N' once per step for N = 1 to 6, one call per step. Once you have the answer, set the task to review with an output that names the colour exactly as the answer gives it.",
  });
  const question = await openQuestion(h, task.id);
  h.check(question.questionStatus === "open", "the question is open");
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.taskId, task.id), eq(runs.status, "running")));
  const answer = await answerQuestion(question.id, "TEAL-42", "user");
  h.check(answer.delivered === "steered", `(a) the answer is steered into the running run (${answer.delivered})`);
  const done = await settled(h, task.id, "(a) the task to settle");
  const [closed] = await db.select().from(taskComments).where(eq(taskComments.id, question.id));
  h.check(closed?.questionStatus === "answered", "(a) the question is answered");
  // Taken in between two steps, or, when the run was on its last step, by the follow-up run that goes on
  // in the same conversation.
  const taskRuns = await runsOfTask(task.id);
  const steered = Boolean(run) && (await steeredNotices(run!.id)).includes("answer");
  h.check(
    steered || (taskRuns.length === 2 && taskRuns[1]!.conversationId === run?.conversationId),
    `(a) the running run took the answer (${steered ? "steered in" : "its follow-up in the same conversation"})`,
  );
  h.check((done.output ?? "").includes("TEAL-42"), "(a) the output uses the answer");
  h.check(new Set(taskRuns.map((r) => r.conversationId)).size === 1, "(a) all in one conversation");
  h.check(done.redelegations === 0, "(a) no send-back");
}

async function answeredAfterTurn(h: Harness): Promise<void> {
  const [writer] = h.specialists;
  const from = await h.delegatorRun();
  await hold(h, from.conversationId!, h.manager.id);
  const task = await h.delegate({
    to: writer,
    from,
    title: "Slogan length",
    description:
      "Call ask with the question 'How many words may the slogan have?', then end your turn at once without doing anything else. When the answer arrives, set the task to review with an output that states the number exactly as the answer gives it.",
  });
  const question = await openQuestion(h, task.id);
  const [first] = await h.waitFor("(b) the asker's run to end", async () => {
    const taskRuns = await runsOfTask(task.id);
    return taskRuns.length && taskRuns.every((r) => !["queued", "running"].includes(r.status)) ? taskRuns : null;
  });
  await wait(3_000);
  const waiting = await taskRow(task.id);
  h.check(waiting.status === "in_progress", `(b) the task waits in progress (${waiting.status})`);
  h.check(waiting.reportedAt === null, "(b) the task is not reported while it waits");

  await answerQuestion(question.id, "SEVEN-7", "user");
  const woken = await h.waitFor(
    "(b) a new run within 30 s",
    async () => {
      const [run] = await db
        .select()
        .from(runs)
        .where(and(eq(runs.taskId, task.id), ne(runs.id, first!.id)));
      return run;
    },
    { timeoutMs: 30_000 },
  );
  h.check(woken.conversationId === first!.conversationId, "(b) the answer wakes it in the same conversation");
  const done = await settled(h, task.id, "(b) the task to settle");
  h.check((done.output ?? "").includes("SEVEN-7"), "(b) the output uses the answer");
}

async function managerAnswers(h: Harness): Promise<void> {
  const [writer] = h.specialists;
  const from = await h.delegatorRun();
  const task = await h.delegate({
    to: writer,
    from,
    title: "Flyer audience",
    description:
      "Call ask with the question 'Should the flyer speak to families or to office workers?' and those two options, then end your turn. When the answer arrives, set the task to review with one line saying which audience the flyer targets.",
  });
  const question = await openQuestion(h, task.id);
  const managerRun = await h.waitFor(
    "(c) a manager run within 30 s of the question",
    async () => {
      const [run] = await db
        .select()
        .from(runs)
        .where(and(eq(runs.conversationId, from.conversationId!), gt(runs.createdAt, question.createdAt)));
      return run;
    },
    { timeoutMs: 30_000 },
  );
  h.check(managerRun.agentId === h.manager.id, "(c) the manager was woken by the question");
  const answer = await h.waitFor("(c) the manager's answer", async () => {
    const [row] = await db
      .select()
      .from(taskComments)
      .where(and(eq(taskComments.replyToId, question.id), eq(taskComments.kind, "answer")));
    return row;
  });
  // The manager answers, or forwards it when it is not its to decide and the super agent answers.
  const answeredBy =
    answer.authorAgentId === h.manager.id
      ? "the manager"
      : answer.authorAgentId === h.orchestrator.id
        ? "the super agent"
        : null;
  h.check(Boolean(answeredBy), `(c) the chain answered it (${answeredBy ?? "someone else"})`);
  await settled(h, task.id, "(c) the task to settle");
}
