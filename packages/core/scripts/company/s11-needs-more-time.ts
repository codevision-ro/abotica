import { agents, db, runs, taskComments, taskEvents, tasks } from "@abotica/db";
import { and, asc, eq, notInArray, sql } from "@abotica/db/orm";
import { answerQuestion, taskFailureStreak, type Task } from "../../src/index";
import type { Harness } from "../e2e-company";

const MAX_STEPS = 3;
const MAX_CONTINUATIONS = 2;

const taskRow = async (id: string): Promise<Task> => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;

/**
 * S11: needs more time. The writer may make 3 steps a run and its brief needs 13, so its run stops at
 * the step limit. It goes on by itself twice in the same conversation (maxContinuations 2), then the
 * manager is asked whether it gets more time, while the task stays in progress and unreported. The
 * manager decides (answers "continue" or resumes it with extraContinuations; the harness answers for it
 * when it does not within a few minutes), the continuations start over and the task reaches review,
 * with no failure counted and no send-back.
 */
export default async function needsMoreTime(h: Harness): Promise<void> {
  await h.setSettings("agents", { maxContinuations: MAX_CONTINUATIONS });
  const [writer] = h.specialists;
  await db
    .update(agents)
    .set({ limits: { ...writer.limits, maxSteps: MAX_STEPS } })
    .where(eq(agents.id, writer.id));

  const from = await h.delegatorRun();
  const task = await h.delegate({
    to: writer,
    from,
    title: "Twelve bakery facts",
    description:
      "Post 12 short facts about bread, one per step: call task_comment with 'fact N: <the fact>' for N=1..12, exactly one tool call per step and never several calls in one step. When all 12 are posted, set the task to review with the output 'twelve facts posted'.",
  });

  const question = await h.waitFor(
    "the needs-more-time question",
    async () => {
      const [row] = await db
        .select()
        .from(taskComments)
        .where(
          and(
            eq(taskComments.taskId, task.id),
            eq(taskComments.kind, "question"),
            sql`${taskComments.options}->>'system' = 'needs-more-time'`,
          ),
        );
      return row;
    },
    { timeoutMs: 10 * 60_000 },
  );

  const stopped = await db.select().from(runs).where(eq(runs.taskId, task.id)).orderBy(asc(runs.createdAt));
  h.check(
    stopped.length === MAX_CONTINUATIONS + 1,
    `${MAX_CONTINUATIONS + 1} runs before the question (${stopped.length})`,
  );
  h.check(new Set(stopped.map((r) => r.conversationId)).size === 1, "all of them in one conversation");
  h.check(
    stopped.every((r) => r.status === "succeeded" && r.failureKind === "step_limit"),
    `each succeeded with failure_kind step_limit (${stopped.map((r) => `${r.status}/${r.failureKind}`).join(", ")})`,
  );
  const asked = await taskRow(task.id);
  h.check(asked.continuations === MAX_CONTINUATIONS, `continuations = ${MAX_CONTINUATIONS} (${asked.continuations})`);
  h.check(asked.status === "in_progress" && !asked.reportedAt, "the task is in progress and unreported");
  h.check(question.addresseeAgentId === h.manager.id, "the question went to the manager");
  h.check(
    JSON.stringify(question.options?.options) === JSON.stringify(["continue", "redirect", "cancel"]),
    "it offers continue, redirect and cancel",
  );

  // The manager decides; if it has not within a few minutes, the harness answers for it.
  const decided = await h
    .waitFor(
      "the manager's decision",
      async () => {
        const [answered] = await db
          .select({ status: taskComments.questionStatus })
          .from(taskComments)
          .where(and(eq(taskComments.id, question.id), eq(taskComments.questionStatus, "answered")));
        if (answered) return "answered";
        const [resumed] = await db
          .select({ id: taskEvents.id })
          .from(taskEvents)
          .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.type, "resumed")));
        return resumed ? "resumed" : null;
      },
      { timeoutMs: 4 * 60_000 },
    )
    .catch(async () => {
      await answerQuestion(question.id, "continue", { agentId: h.manager.id });
      return "answered by the harness";
    });
  console.log(`decision: ${decided}`);

  const reset = await h.waitFor("the continuations to start over", async () => {
    const row = await taskRow(task.id);
    const [later] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.taskId, task.id),
          notInArray(
            runs.id,
            stopped.map((r) => r.id),
          ),
        ),
      );
    return later && row.continuations < MAX_CONTINUATIONS ? row : null;
  });
  h.check(reset.continuations < MAX_CONTINUATIONS, `continuations were reset (${reset.continuations})`);

  const done = await h.waitFor(
    "the task to reach review",
    async () => {
      const row = await taskRow(task.id);
      return row.status === "review" || row.status === "done" ? row : null;
    },
    { timeoutMs: 10 * 60_000 },
  );
  h.check(true, `the task reached ${done.status}`);
  h.check(!(await taskFailureStreak(task.id)).open, "the circuit breaker stayed closed");
  h.check(done.redelegations === 0, "the task was never sent back");
}
