import { db, messages, runEvents, runs, taskComments } from "@abotica/db";
import { and, asc, eq, gt } from "@abotica/db/orm";
import { reportProgress, startRun } from "../../src/index";
import type { Harness } from "../e2e-company";
import { noticesIn, taskRow, wait } from "./flow-helpers";

/**
 * S08: progress goes up without waking anyone, unless it needs attention; the super agent answers
 * "where do things stand" from team_status. The writer's progress is stored on its task and waits in the
 * manager's conversation; progress that needs attention wakes the manager.
 */
export default async function progress(h: Harness): Promise<void> {
  const [writer] = h.specialists;
  const from = await h.delegatorRun();
  const task = await h.delegate({
    to: writer,
    from,
    start: false,
    title: "Autumn menu texts",
    description: "Write the texts of the autumn menu.",
  });
  // The writer works on it: a finished round, as a run of its own would leave.
  const writerRun = await h.delegatorRun({ agentId: writer.id, taskId: task.id });

  const before = new Date();
  await reportProgress(
    task.id,
    { summary: "Half of the menu texts are drafted", percentDone: 50 },
    { agentId: writer.id },
    {
      runId: writerRun.id,
    },
  );
  const [stored] = await db
    .select()
    .from(taskComments)
    .where(and(eq(taskComments.taskId, task.id), eq(taskComments.kind, "progress")));
  h.check(Boolean(stored), "a progress comment is on the task");
  h.check((await taskRow(task.id)).lastProgressAt !== null, "last_progress_at is set");
  h.check(
    (await noticesIn(from.conversationId!, "progress", task.id)).length === 1,
    "a progress notice waits in the manager's conversation",
  );
  await wait(10_000);
  const quiet = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.conversationId, from.conversationId!), gt(runs.createdAt, before)));
  h.check(quiet.length === 0, `the progress woke no manager run (${quiet.length})`);

  await reportProgress(
    task.id,
    { summary: "The supplier dropped pumpkins: the menu needs a new autumn dish", needsAttention: true },
    { agentId: writer.id },
    { runId: writerRun.id },
  );
  const woken = await h.waitFor(
    "a manager run for the progress that needs attention",
    async () => {
      const [run] = await db
        .select()
        .from(runs)
        .where(
          and(eq(runs.conversationId, from.conversationId!), eq(runs.agentId, h.manager.id), gt(runs.createdAt, before)),
        );
      return run;
    },
    { timeoutMs: 60_000 },
  );
  h.check(Boolean(woken), "progress that needs attention woke the manager");

  const conversationId = await h.superConversation("E2E where things stand");
  const asked = await startRun({
    agentId: h.orchestrator.id,
    trigger: "chat",
    conversationId,
    input: `How is project "${h.project.name}" going? What is open there right now?`,
  });
  await h.waitFor("the super agent's answer", async () => {
    const [run] = await db.select().from(runs).where(eq(runs.id, asked.id));
    return run && !["queued", "running"].includes(run.status) ? run : null;
  });
  const steps = await db
    .select({ data: runEvents.data })
    .from(runEvents)
    .where(and(eq(runEvents.runId, asked.id), eq(runEvents.type, "step")));
  h.check(
    steps.some((s) => ((s.data.toolCalls ?? []) as { name: string }[]).some((c) => c.name === "team_status")),
    "the super agent called team_status",
  );
  const answers = await db
    .select({ parts: messages.parts })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
    .orderBy(asc(messages.createdAt));
  const text = answers
    .flatMap((m) =>
      (m.parts as { type: string; text?: string }[]).flatMap((p) => (p.type === "text" ? [p.text ?? ""] : [])),
    )
    .join("\n");
  h.check(text.toLowerCase().includes("autumn menu"), "the answer names the task");
}
