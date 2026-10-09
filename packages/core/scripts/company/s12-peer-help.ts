import { agents, db, messages, runs, tasks } from "@abotica/db";
import { and, asc, eq, lt, sql } from "@abotica/db/orm";
import type { Harness } from "../e2e-company";

const MARKER = "HOURS-OK";

/**
 * S12: peer help. The writer asks the researcher with ask_colleague; the researcher's profession makes it
 * answer with a marker. The help task is a subtask of the writer's, settles to done on its own, and its
 * answer goes back into the writer's conversation, which ends with the marker in its output. The manager
 * only hears of it (no wake), and the writer's task is never sent back.
 */
export default async function peerHelp(h: Harness): Promise<void> {
  const [writer, researcher] = h.specialists;
  await db
    .update(agents)
    .set({
      systemPrompt: `${researcher.systemPrompt}\n\nYou keep the bakery's facts. When a colleague asks about Crumb's opening hours, your whole answer (the output of your task) is exactly: ${MARKER}`,
    })
    .where(eq(agents.id, researcher.id));

  const from = await h.delegatorRun();
  const task = await h.delegate({
    to: writer,
    from,
    title: "Opening hours line for the website",
    description: `Write one line for Crumb's website footer with the bakery's opening hours. You do not know the hours: ask your colleague ${researcher.slug} with ask_colleague and wait for the answer (end your turn; the answer wakes you). Then set the task to review with an output that contains the answer exactly as given, word for word.`,
  });

  const help = await h.waitFor("the help task", async () => {
    const [row] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.parentId, task.id), eq(tasks.kind, "help")));
    return row;
  });
  const [askerRun] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.taskId, task.id), eq(runs.agentId, writer.id)))
    .orderBy(asc(runs.createdAt))
    .limit(1);
  h.check(help.assigneeAgentId === researcher.id, "the help task is assigned to the colleague asked");
  h.check(
    Boolean(askerRun) && help.delegatedByRunId === askerRun!.id,
    "the help task was delegated by the writer's run, under the writer's task",
  );

  const settledHelp = await h.waitFor("the help task to settle", async () => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, help.id));
    return row?.reportedAt ? row : null;
  });
  h.check(settledHelp.status === "done", `the help task settled to done on its own (${settledHelp.status})`);

  const writerConversation = askerRun?.conversationId ?? null;
  const helpAnswer = await h.waitFor("the help answer in the writer's conversation", async () => {
    if (!writerConversation) return null;
    const rows = await db
      .select({ metadata: messages.metadata, parts: messages.parts })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, writerConversation),
          sql`(${messages.metadata}->>'notice' = 'help-answer' or ${messages.metadata}->'tasks' @> ${JSON.stringify([{ id: help.id }])}::jsonb)`,
        ),
      );
    return rows[0];
  });
  h.check(JSON.stringify(helpAnswer.parts).includes(MARKER), "the help answer carries the colleague's output");

  const done = await h.waitFor("the writer's task to settle and be reported", async () => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    return row?.reportedAt && ["review", "done", "blocked"].includes(row.status) ? row : null;
  });
  h.check(Boolean(done.output?.includes(MARKER)), `the writer's output contains ${MARKER}`);
  h.check(done.redelegations === 0, "the writer's task was never sent back");

  const fyi = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, from.conversationId!),
        sql`${messages.metadata}->>'kind' = 'task-notice'`,
        sql`${messages.metadata}->>'taskId' = ${task.id}`,
      ),
    );
  h.check(fyi.length > 0, "the manager got a notice about the help request");
  // The only manager runs in its delegating conversation are the ones the writer's own report started.
  const reportedAt = done.reportedAt!;
  const woken = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(eq(runs.conversationId, from.conversationId!), eq(runs.agentId, h.manager.id), lt(runs.createdAt, reportedAt)),
    );
  h.check(woken.filter((r) => r.id !== from.id).length === 0, "the notice did not wake the manager");
}
