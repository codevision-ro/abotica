import { conversations, db, runs, tasks } from "@abotica/db";
import { and, eq, ne } from "@abotica/db/orm";
import { createConversation, postInstruction } from "../../src/index";
import type { Harness } from "../e2e-company";
import { hold, reportsIn, runsOfTask, settled, taskRow } from "./flow-helpers";

/**
 * S02: a comment wakes an idle task. The writer's task settles in review with v1; its manager comments
 * "change the output to v2": a new run starts in the conversation of the previous one, the task comes
 * back to review with v2 and is reported a second time, with no send-back and one agent round counted.
 * Variant: the user's comment on a blocked task whose runs keep failing goes past the circuit breaker
 * and counts no agent round.
 */
export default async function commentWakes(h: Harness): Promise<void> {
  const [writer] = h.specialists;
  const from = await h.delegatorRun();
  // The manager is kept out of its conversation, so it does not mark the task done meanwhile.
  await hold(h, from.conversationId!, h.manager.id);
  const task = await h.delegate({
    to: writer,
    from,
    title: "Version line",
    description:
      "Set this task to review with the output exactly: v1. If a later instruction changes the output, set it to review again with the new output.",
  });
  await settled(h, task.id, "the task to settle with v1");
  const [first] = await runsOfTask(task.id);
  await h.waitFor("the first report", async () => (await taskRow(task.id)).reportedAt);

  const posted = await postInstruction(task.id, "Change the output to v2.", { agentId: h.manager.id });
  h.check(posted.comment.kind === "instruction", "the manager's comment is an instruction");
  const woken = await h.waitFor(
    "a new run of the task within 30 s",
    async () => {
      const [run] = await db
        .select()
        .from(runs)
        .where(and(eq(runs.taskId, task.id), ne(runs.id, first!.id)));
      return run;
    },
    { timeoutMs: 30_000 },
  );
  h.check(woken.conversationId === first!.conversationId, "it continues the conversation of the previous run");
  const again = await h.waitFor("the task to come back to review with v2", async () => {
    const row = await taskRow(task.id);
    return row.status === "review" && (row.output ?? "").includes("v2") ? row : null;
  });
  h.check(again.status === "review", `the task is in review again (${again.status})`);
  h.check(again.redelegations === 0, "no send-back was counted");
  h.check(again.agentRounds === 1, `one agent round was counted (${again.agentRounds})`);
  const reports = await h.waitFor("the second report", async () => {
    const found = (await reportsIn(from.conversationId!)).filter((r) => r.taskIds.includes(task.id));
    return found.length >= 2 ? found : null;
  });
  h.check(reports.length === 2, `two reports in the manager's conversation (${reports.length})`);

  await userOnBrokenTask(h);
}

/** The variant: a blocked task with an open circuit breaker, woken by the user's comment. */
async function userOnBrokenTask(h: Harness): Promise<void> {
  const [writer] = h.specialists;
  const from = await h.delegatorRun();
  await hold(h, from.conversationId!, h.manager.id);
  const task = await h.delegate({
    to: writer,
    from,
    start: false,
    title: "Repair line",
    description: "Set this task to review with the output exactly: FIXED.",
  });
  const conversation = await createConversation({ agentId: writer.id, channel: "internal", title: "E2E broken task" });
  h.track.conversation(conversation.id);
  await db.update(conversations).set({ modelOverride: h.model }).where(eq(conversations.id, conversation.id));
  for (let i = 0; i < 5; i++) {
    const [failed] = await db
      .insert(runs)
      .values({
        agentId: writer.id,
        trigger: "delegation",
        status: "failed",
        failureKind: "other",
        error: "E2E: a failure that keeps coming back",
        input: "E2E",
        conversationId: conversation.id,
        taskId: task.id,
        projectId: h.project.id,
        startedAt: new Date(),
        finishedAt: new Date(),
      })
      .returning();
    h.expectFailure(failed!.id);
  }
  await db.update(tasks).set({ status: "blocked", agentRounds: 4 }).where(eq(tasks.id, task.id));

  const posted = await postInstruction(task.id, "The access is fixed now: finish the task.", "user");
  h.check(posted.delivered === "woke", `the user's comment wakes the task past its breaker (${posted.delivered})`);
  const done = await settled(h, task.id, "the repaired task to settle");
  h.check((done.output ?? "").includes("FIXED"), "the repaired task finished");
  h.check(done.agentRounds === 0, `the user's comment counts no agent round (${done.agentRounds})`);
}
