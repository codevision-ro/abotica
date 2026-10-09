import { db, runs, taskComments, taskEvents, tasks } from "@abotica/db";
import { and, eq, gte, inArray, sql } from "@abotica/db/orm";
import type { Harness } from "../e2e-company";
import { managerTask, quiet, repliesSince, specialistTasks, steeredNotices, userChat } from "./flow-helpers";

/**
 * S20: the direction changes while a specialist works, the whole company on real models. The user asks
 * the super agent for an Instagram post about the summer lemonade; once the specialist is at work, the
 * user changes direction: the post is about the new pumpkin bread instead. The change goes down the
 * chain (super agent to manager to specialist), the specialist's work follows it, and the super agent
 * tells the user the result. What reached whom is in the transcript.
 */
export default async function directionChange(h: Harness): Promise<void> {
  const chat = await userChat(h, "E2E direction change");
  await chat.say(
    `For project "${h.project.name}" (projectId ${h.project.id}), have the team write an Instagram post about Crumb's summer lemonade: eight short lines. The specialist should post each line with its own task_comment as it goes, one call per line, and then deliver the eight lines in the output.`,
  );
  const top = await managerTask(h);
  const working = await h.waitFor("a specialist at work", async () => {
    const [row] = await db
      .select({ task: tasks, runId: runs.id })
      .from(tasks)
      .innerJoin(runs, eq(runs.taskId, tasks.id))
      .where(and(eq(tasks.parentId, top.id), eq(runs.status, "running")));
    return row;
  });

  const changedAt = new Date();
  await chat.say("Change of direction: forget the lemonade. The post must be about Crumb's new pumpkin bread instead.");

  const passedOn = await h.waitFor(
    "the manager to change the specialist's direction",
    async () => {
      const [instruction] = await db
        .select({ id: taskComments.id, taskId: taskComments.taskId })
        .from(taskComments)
        .innerJoin(tasks, eq(tasks.id, taskComments.taskId))
        .where(
          and(
            eq(tasks.parentId, top.id),
            eq(taskComments.authorAgentId, h.manager.id),
            eq(taskComments.kind, "instruction"),
            gte(taskComments.createdAt, changedAt),
          ),
        );
      if (instruction) return `an instruction on its task`;
      const [redirect] = await db
        .select({ id: taskEvents.id })
        .from(taskEvents)
        .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
        .where(and(eq(tasks.parentId, top.id), eq(taskEvents.type, "redirected"), gte(taskEvents.createdAt, changedAt)));
      if (redirect) return "a redirect";
      const [fresh] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.parentId, top.id), gte(tasks.createdAt, changedAt)));
      return fresh ? "a new task" : null;
    },
    { timeoutMs: 6 * 60_000 },
  );
  h.check(true, `the manager passed the change down (${passedOn})`);

  await quiet(h, chat.conversationId, "the company to finish");
  const delivered = (await specialistTasks(h)).filter(
    (t) => t.parentId === top.id && ["review", "done"].includes(t.status),
  );
  const final = delivered.at(-1);
  h.check(Boolean(final?.output), `a specialist delivered (${delivered.length} task(s))`);
  h.check(/pumpkin/i.test(final?.output ?? ""), "the delivered post is about the pumpkin bread");
  h.check(!/lemonade/i.test(final?.output ?? ""), "and no longer about the lemonade");
  // The specialist working when the change came took it into that run or the next one.
  const steered = (await steeredNotices(working.runId)).length > 0;
  const later = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, working.task.id), gte(runs.createdAt, changedAt)));
  h.check(
    steered || later.length > 0 || working.task.id !== final?.id,
    `the specialist at work got the change (${steered ? "steered into its run" : later.length ? "a new run of its task" : "its task replaced"})`,
  );

  const replies = await repliesSince(chat.conversationId, changedAt);
  h.check(
    replies.some((text) => /pumpkin/i.test(text)),
    `the super agent told the user about the pumpkin post (${replies.length} replies)`,
  );
  const [sentBack] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        gte(tasks.createdAt, h.startedAt),
        inArray(
          tasks.assigneeAgentId,
          h.specialists.map((s) => s.id),
        ),
        sql`${tasks.redelegations} > 0`,
      ),
    );
  h.check(!sentBack, "no task was sent back");
}
