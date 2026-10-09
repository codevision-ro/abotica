import { db, runs, taskComments, tasks } from "@abotica/db";
import { and, eq, gte, inArray, or } from "@abotica/db/orm";
import type { Harness } from "../e2e-company";
import { listWaitingForUser } from "../../src/index";
import { managerTask, quiet, repliesSince, specialistTasks, userChat } from "./flow-helpers";

/** Runs the whole flow may take before it counts as going round in circles. */
const MAX_RUNS = 30;

/**
 * S24: work that cannot be done goes up to the user, the whole company on real models. The user asks for
 * the week's prices on Crumb's Shopify store; nobody has access to it (no key, no login). The specialist
 * says it is stuck instead of pretending, the manager cannot unblock it and takes it up, and the super
 * agent tells the user what is needed (or it waits in the user's list). Nobody claims the prices went
 * up, and nobody goes round in circles.
 */
export default async function blockedUp(h: Harness): Promise<void> {
  const chat = await userChat(h, "E2E blocked up");
  const askedAt = new Date();
  await chat.say(
    `For project "${h.project.name}" (projectId ${h.project.id}), have the team put this week's bread prices on Crumb's Shopify store: rye 12 lei, sourdough 15 lei, baguette 6 lei.`,
  );
  const top = await managerTask(h);
  await quiet(h, chat.conversationId, "the company to settle");

  const work = (await specialistTasks(h)).filter((t) => t.parentId === top.id);
  const [topNow] = await db.select().from(tasks).where(eq(tasks.id, top.id));
  const questions = await db
    .select()
    .from(taskComments)
    .where(
      and(
        inArray(taskComments.taskId, [top.id, ...work.map((t) => t.id)]),
        eq(taskComments.kind, "question"),
        eq(taskComments.questionStatus, "open"),
      ),
    );
  console.log(
    `specialist tasks: ${work.map((t) => `${t.status}`).join(", ") || "none"}; manager's task: ${topNow!.status}; open questions: ${questions.length}`,
  );
  const replies = await repliesSince(chat.conversationId, askedAt);
  const told = replies.some(
    (text) => /shopify/i.test(text) && /access|credential|key|login|token|admin|permission|connect/i.test(text),
  );
  const waiting = (await listWaitingForUser()).some(
    (item) => item.taskId && [top.id, ...work.map((t) => t.id)].includes(item.taskId),
  );
  h.check(
    told || waiting,
    `the user learned what is needed (${told ? "the super agent said it" : "it waits in the user's list"})`,
  );
  h.check(
    !replies.some((text) =>
      /\b(prices are (now )?(live|up|published)|successfully (published|updated|added))\b/i.test(text),
    ),
    "the super agent did not claim the prices went up",
  );
  h.check(topNow!.status !== "done", `the manager did not close its task as done (${topNow!.status})`);
  const all = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        gte(runs.createdAt, h.startedAt),
        or(
          inArray(runs.agentId, [h.manager.id, ...h.specialists.map((s) => s.id)]),
          eq(runs.conversationId, chat.conversationId),
        ),
      ),
    );
  h.check(all.length <= MAX_RUNS, `nobody went round in circles (${all.length} runs)`);
}
