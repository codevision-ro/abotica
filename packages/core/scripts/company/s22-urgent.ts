import { db, runs, taskEvents, tasks } from "@abotica/db";
import { and, asc, eq, gte, inArray, sql } from "@abotica/db/orm";
import type { Harness } from "../e2e-company";
import { firstSettledAt, managerTask, quiet, repliesSince, specialistTasks, userChat } from "./flow-helpers";

/**
 * S22: an emergency, the whole company on real models. The team works on a long plan for the autumn
 * shop window; the user then asks the super agent for an apology about a burnt batch, right now, before
 * anything else. The urgent work goes down with a higher priority; if it lands on the specialist busy
 * with the plan, the plan is put aside (paused) and goes on by itself afterwards. The apology is
 * finished before the plan, the plan is finished too, and the user hears about both.
 */
export default async function urgent(h: Harness): Promise<void> {
  const chat = await userChat(h, "E2E urgent");
  await chat.say(
    `For project "${h.project.name}" (projectId ${h.project.id}), have the team write a 10-point plan for Crumb's autumn shop window. The specialist should post each point with its own task_comment as it goes, one call per point, then deliver the 10 points in the output.`,
  );
  const top = await managerTask(h);
  const busy = await h.waitFor("the specialist at work on the plan", async () => {
    const [row] = await db
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(runs, eq(runs.taskId, tasks.id))
      .where(and(eq(tasks.parentId, top.id), eq(runs.status, "running")));
    return row?.task;
  });

  const urgentAt = new Date();
  await chat.say(
    "Urgent, before anything else: the team must write today's apology to our customers for the burnt sourdough batch, a short paragraph for the shop door and Instagram. It comes before the window plan.",
  );

  const apology = await h.waitFor(
    "the urgent task",
    async () => {
      const [row] = await db
        .select()
        .from(tasks)
        .where(
          and(
            inArray(
              tasks.assigneeAgentId,
              h.specialists.map((s) => s.id),
            ),
            gte(tasks.createdAt, urgentAt),
          ),
        )
        .orderBy(asc(tasks.createdAt))
        .limit(1);
      return row;
    },
    { timeoutMs: 6 * 60_000 },
  );
  h.check(["urgent", "high"].includes(apology.priority), `the apology went out as ${apology.priority}`);
  const sameSpecialist = apology.assigneeAgentId === busy.assigneeAgentId;
  const [parked] = await db
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, busy.id),
        eq(taskEvents.type, "updated"),
        sql`${taskEvents.data}->'status'->>'to' = 'paused'`,
      ),
    );
  console.log(
    `the apology went to ${sameSpecialist ? "the specialist busy with the plan" : "the free specialist"}; the plan was ${parked ? "put aside" : "not paused"}`,
  );

  await quiet(h, chat.conversationId, "the company to finish");
  const [apologyDone] = await db.select().from(tasks).where(eq(tasks.id, apology.id));
  const plans = (await specialistTasks(h)).filter(
    (t) => t.id === busy.id || (t.parentId === top.id && t.id !== apology.id),
  );
  const plan = plans.find((t) => ["review", "done"].includes(t.status) && t.output);
  h.check(["review", "done"].includes(apologyDone!.status), `the apology was delivered (${apologyDone!.status})`);
  h.check(/sourdough|batch|sorry|apolog/i.test(apologyDone!.output ?? ""), "it is the apology");
  h.check(Boolean(plan), `the plan was finished as well (${plans.map((t) => t.status).join(", ")})`);
  const apologyAt = await firstSettledAt(apology.id);
  const planAt = plan ? await firstSettledAt(plan.id) : null;
  h.check(Boolean(apologyAt && (!planAt || apologyAt <= planAt)), "the apology was finished first");
  if (sameSpecialist) h.check(Boolean(parked), "the plan was put aside for the apology");

  const replies = await repliesSince(chat.conversationId, urgentAt);
  h.check(
    replies.some((text) => /sourdough|apolog|sorry/i.test(text)),
    `the super agent gave the user the apology (${replies.length} replies)`,
  );
}
