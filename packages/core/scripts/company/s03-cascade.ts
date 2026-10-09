import { db, runs, taskComments, taskEvents, tasks } from "@abotica/db";
import { and, eq, gte, inArray, sql } from "@abotica/db/orm";
import { ConversationBusyError, startRun } from "../../src/index";
import type { Harness } from "../e2e-company";
import { noticesIn, settled, steeredNotices } from "./flow-helpers";

/**
 * S03: a change of plan cascades down. The user asks the super agent for ten bakery names; while the
 * specialist works, the user changes the plan. The super agent puts the change on the manager's task
 * instead of delegating again, the manager gets it as a notice and passes it on to the specialist (an
 * instruction or a redirect), and the final names all follow it. Nothing is sent back.
 */
export default async function cascade(h: Harness): Promise<void> {
  const conversationId = await h.superConversation("E2E cascade");
  const say = async (input: string) => {
    try {
      await startRun({ agentId: h.orchestrator.id, trigger: "chat", conversationId, input });
    } catch (error) {
      // The super agent is busy: the message waits for its next step or its follow-up.
      if (!(error instanceof ConversationBusyError)) throw error;
    }
  };
  await say(
    `For project "${h.project.name}" (projectId ${h.project.id}), have the team come up with 10 name ideas for Crumb's new bread line. The specialist should post each name with its own task_comment, one call per name, and then deliver the 10 names in the output, one per line.`,
  );

  const managerTask = await h.waitFor("the manager's task", async () => {
    const [row] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.assigneeAgentId, h.manager.id), gte(tasks.createdAt, h.startedAt)));
    return row;
  });
  const specialistTask = await h.waitFor("the specialist's task to be running", async () => {
    const [row] = await db
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(runs, eq(runs.taskId, tasks.id))
      .where(
        and(
          eq(tasks.parentId, managerTask.id),
          inArray(
            tasks.assigneeAgentId,
            h.specialists.map((s) => s.id),
          ),
          eq(runs.status, "running"),
        ),
      );
    return row?.task;
  });
  await say("Change of plan: every name must start with the letter K.");

  const instruction = await h.waitFor("the super agent's instruction on the manager's task", async () => {
    const [row] = await db
      .select()
      .from(taskComments)
      .where(
        and(
          eq(taskComments.taskId, managerTask.id),
          eq(taskComments.authorAgentId, h.orchestrator.id),
          eq(taskComments.kind, "instruction"),
        ),
      );
    return row;
  });
  h.check(Boolean(instruction), "the super agent put the change on the manager's task as an instruction");

  await h.waitFor("the manager to receive the notice", async () => {
    const managerRuns = await db.select().from(runs).where(eq(runs.taskId, managerTask.id));
    for (const run of managerRuns) {
      if ((await steeredNotices(run.id)).includes("instruction")) return true;
      if (run.conversationId && (await noticesIn(run.conversationId, "instruction", managerTask.id)).length) return true;
    }
    return false;
  });
  h.check(true, "the manager received the instruction notice (steered or woken)");

  const passedOn = await h.waitFor(
    "the manager to pass the change on to the specialist",
    async () => {
      const [comment] = await db
        .select({ id: taskComments.id })
        .from(taskComments)
        .innerJoin(tasks, eq(tasks.id, taskComments.taskId))
        .where(
          and(
            eq(tasks.parentId, managerTask.id),
            eq(taskComments.authorAgentId, h.manager.id),
            eq(taskComments.kind, "instruction"),
          ),
        );
      const [redirected] = await db
        .select({ id: taskEvents.id })
        .from(taskEvents)
        .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
        .where(and(eq(tasks.parentId, managerTask.id), eq(taskEvents.type, "redirected")));
      return comment ?? redirected;
    },
    { timeoutMs: 5 * 60_000 },
  );
  h.check(Boolean(passedOn), "the manager steered the specialist (an instruction or a redirect) within 5 minutes");

  const managerTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.assigneeAgentId, h.manager.id), gte(tasks.createdAt, h.startedAt)));
  h.check(managerTasks.length === 1, `the manager got exactly one task (${managerTasks.length})`);

  const latestDelivery = async () => {
    const [latest] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.parentId, managerTask.id), inArray(tasks.status, ["review", "done"])))
      .orderBy(sql`${tasks.updatedAt} desc`)
      .limit(1);
    return latest?.output ? latest : null;
  };
  await h.waitFor("the specialist to deliver", latestDelivery);
  // The output read once the work is over: a first version may go to review before the change is in.
  await settled(h, specialistTask.id, "the specialist's task to settle").catch(() => null);
  const final = (await latestDelivery())!;
  // The names are the list's items: a heading or a closing line around them is not a name.
  const lines = (final.output ?? "").split("\n").filter((line) => line.trim());
  const items = lines.filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line));
  const names = (items.length >= 10 ? items : lines).map((line) =>
    line
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
      .replace(/^\*\*/, "")
      .trim(),
  );
  h.check(names.length >= 10, `the output has the names (${names.length} lines)`);
  h.check(
    names.every((name) => /^K/i.test(name)),
    `every name starts with K (${names.filter((n) => !/^K/i.test(n)).join(", ") || "all do"})`,
  );
  const sentBack = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(gte(tasks.createdAt, h.startedAt), sql`${tasks.redelegations} > 0`));
  h.check(sentBack.length === 0, "no task was sent back");
}
