import { db, runs, taskComments } from "@abotica/db";
import { and, eq } from "@abotica/db/orm";
import { postInstruction } from "../../src/index";
import type { Harness } from "../e2e-company";
import { runsOfTask, settled, steeredNotices, stepsOf } from "./flow-helpers";

const MARKER = "PINEAPPLE";

/**
 * S01: an instruction reaches a working agent between its steps. While the writer works through a
 * multi-step brief, the user puts an instruction on its task: the running run takes it in (a `steered`
 * event carrying the instruction notice), the comment is marked delivered into that run, and the task's
 * output follows it, all in one run and without a send-back.
 */
export default async function instructionSteered(h: Harness): Promise<void> {
  const [writer] = h.specialists;
  const task = await h.delegate({
    to: writer,
    title: "Six steps of bakery notes",
    description:
      "Work in six steps: call task_comment on this task with the text 'step N' once per step, for N = 1 to 6, one call per step. Then set the task to review with an output listing six short ideas for Crumb's shop window, one per line.",
  });

  const run = await h.waitFor("the writer's run to take its first step", async () => {
    const [active] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, task.id), eq(runs.status, "running")));
    return active && (await stepsOf(active.id)) >= 1 ? active : null;
  });
  const posted = await postInstruction(task.id, `Include the word ${MARKER} in your output.`, "user");
  h.check(posted.delivered === "steered", `the instruction is steered into the running run (${posted.delivered})`);

  const done = await settled(h, task.id, "the task to settle");
  h.check(
    (await steeredNotices(run.id)).includes("instruction"),
    "a steered event on that run carries the instruction notice",
  );
  const [comment] = await db.select().from(taskComments).where(eq(taskComments.id, posted.comment.id));
  h.check(comment?.kind === "instruction", `the comment is an instruction (${comment?.kind})`);
  h.check(comment?.deliveredRunId === run.id, "the comment is marked delivered into that run");
  h.check(Boolean(comment?.deliveredMessageId), "the comment names the message that carried it");
  const taskRuns = await runsOfTask(task.id);
  h.check(taskRuns.length === 1, `the task has exactly one run (${taskRuns.length})`);
  h.check(new RegExp(MARKER, "i").test(done.output ?? ""), `the output contains ${MARKER}`);
  h.check(done.redelegations === 0, "the task was never sent back");
}
