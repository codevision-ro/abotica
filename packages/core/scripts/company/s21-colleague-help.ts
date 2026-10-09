import { agents, db, messages, taskComments, tasks } from "@abotica/db";
import { and, asc, eq, gte, sql } from "@abotica/db/orm";
import type { Harness } from "../e2e-company";
import { quiet, taskRow, textOf } from "./flow-helpers";

const YEAR = "1987";
const FOUNDER = "Ilona Varga";

/**
 * S21: a specialist needs something only a colleague has, and nobody tells it how to get it. The
 * researcher keeps Crumb's records (its role on the team says so); the manager gives the writer an
 * "About us" text that needs the founding year and the founder, which the writer does not know. However
 * it goes (asking the colleague, asking the manager, who finds out), the facts reach the writer, the
 * one who helped hears back that it is settled, the manager learns how it went, and the text carries the
 * real facts, not invented ones.
 */
export default async function colleagueHelp(h: Harness): Promise<void> {
  const [writer, researcher] = h.specialists;
  await db
    .update(agents)
    .set({
      role: "Researcher. Keeps Crumb's company records: history, founders, suppliers.",
      systemPrompt: `${researcher.systemPrompt}\n\nCrumb's company records (you keep them; nobody else on the team has them): Crumb was founded in ${YEAR} by ${FOUNDER}, in Cluj. Its first product was a rye loaf.`,
    })
    .where(eq(agents.id, researcher.id));

  const from = await h.delegatorRun();
  const task = await h.delegate({
    to: writer,
    from,
    title: "About us text",
    description:
      "Write a two-sentence 'About us' text for Crumb's website. It must name the year Crumb was founded and its founder. Do not guess either: get the real facts.",
  });

  await quiet(h, from.conversationId!, "the company to finish", 12 * 60_000);
  const done = await taskRow(task.id);
  h.check(["review", "done"].includes(done.status), `the writer's task settled (${done.status})`);
  h.check(
    (done.output ?? "").includes(YEAR) && (done.output ?? "").includes(FOUNDER),
    `the text has the real facts (${done.output ?? "no output"})`,
  );

  // How the facts travelled.
  const helped = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.parentId, task.id), eq(tasks.kind, "help")));
  const asked = await db
    .select()
    .from(taskComments)
    .where(and(eq(taskComments.taskId, task.id), eq(taskComments.kind, "question")));
  const managerTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.assigneeAgentId, researcher.id), gte(tasks.createdAt, h.startedAt), sql`${tasks.kind} <> 'help'`));
  const path = [
    helped.length ? `asked the researcher (${helped.length} help task)` : null,
    asked.length ? `asked a question (${asked.map((q) => q.questionStatus).join(", ")})` : null,
    managerTasks.length ? `the manager had the researcher look it up (${managerTasks.length} task)` : null,
  ].filter(Boolean);
  h.check(path.length > 0, `the facts came from the team: ${path.join("; ") || "no request was made"}`);
  for (const help of helped) {
    h.check(help.status === "done", `the help task is done (${help.status})`);
    h.check(
      (help.output ?? "").includes(YEAR) || (help.output ?? "").includes(FOUNDER),
      "the researcher's answer carries the records",
    );
  }
  for (const question of asked) {
    h.check(question.questionStatus === "answered", `the writer's question was answered (${question.questionStatus})`);
  }

  // The manager heard how it went: the writer's report reached its conversation.
  const report = await db
    .select({ parts: messages.parts })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, from.conversationId!),
        sql`${messages.metadata}->'tasks' @> ${JSON.stringify([{ id: task.id }])}::jsonb`,
      ),
    )
    .orderBy(asc(messages.createdAt));
  h.check(report.length > 0, "the writer's result reached the manager");
  h.check(
    report.some((m) => textOf(m.parts).includes(FOUNDER)),
    "the report the manager got carries the facts",
  );
}
