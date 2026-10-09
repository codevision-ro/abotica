import { agents, db, runs, taskDependencies, tasks } from "@abotica/db";
import { and, asc, eq } from "@abotica/db/orm";
import type { Harness } from "../e2e-company";
import { firstSettledAt, managerTask, quiet, repliesSince, specialistTasks, userChat } from "./flow-helpers";

const STARTER = "Bubbles";
const HOURS = "36";

/**
 * S23: one specialist's work feeds another's, the whole company on real models. The user asks for a blog
 * post written from the facts of Crumb's own sourdough, which only the researcher keeps. The manager
 * plans it as research first and writing second (a dependency, or the second task given once the first
 * is back); the writer starts only once the research is done, gets it, and the post carries the
 * researcher's facts. The super agent tells the user the result.
 */
export default async function handoffChain(h: Harness): Promise<void> {
  const [writer, researcher] = h.specialists;
  await db
    .update(agents)
    .set({
      role: "Researcher. Keeps Crumb's company records, including its bakery processes.",
      systemPrompt: `${researcher.systemPrompt}\n\nCrumb's records on its own sourdough (only you have them): the starter is called "${STARTER}", the dough ferments for ${HOURS} hours, and the loaves bake at 250 °C on stone.`,
    })
    .where(eq(agents.id, researcher.id));

  const chat = await userChat(h, "E2E handoff chain");
  const askedAt = new Date();
  await chat.say(
    `For project "${h.project.name}" (projectId ${h.project.id}): get the facts about Crumb's own sourdough from our records, then have a blog post of about 80 words written from those facts.`,
  );
  const top = await managerTask(h);
  await quiet(h, chat.conversationId, "the company to finish");

  const work = (await specialistTasks(h)).filter((t) => t.parentId === top.id);
  const research = work.find((t) => t.assigneeAgentId === researcher.id);
  const post = work.findLast((t) => t.assigneeAgentId === writer.id && ["review", "done"].includes(t.status));
  h.check(Boolean(research), "the researcher got the research");
  h.check(Boolean(post), "the writer delivered the post");
  if (!research || !post) return;
  h.check(
    (research.output ?? "").includes(STARTER),
    `the research carries the records (${(research.output ?? "").slice(0, 120)})`,
  );

  const [dependency] = await db
    .select()
    .from(taskDependencies)
    .where(and(eq(taskDependencies.taskId, post.id), eq(taskDependencies.dependsOnTaskId, research.id)));
  const [firstWrite] = await db
    .select({ createdAt: runs.createdAt })
    .from(runs)
    .where(eq(runs.taskId, post.id))
    .orderBy(asc(runs.createdAt))
    .limit(1);
  const researchEnded = (await firstSettledAt(research.id))?.getTime();
  h.check(
    Boolean(firstWrite && researchEnded && firstWrite.createdAt.getTime() >= researchEnded),
    `the writer started after the research was done (${dependency ? "a dependency" : "given once the research came back"})`,
  );
  h.check(
    (post.output ?? "").includes(STARTER) && (post.output ?? "").includes(HOURS),
    `the post carries the researcher's facts (${(post.output ?? "").slice(0, 160)})`,
  );
  const [topNow] = await db.select().from(tasks).where(eq(tasks.id, top.id));
  h.check(["review", "done"].includes(topNow!.status), `the manager closed its task (${topNow!.status})`);

  const replies = await repliesSince(chat.conversationId, askedAt);
  h.check(
    replies.some((text) => text.includes(STARTER)),
    `the super agent gave the user the post (${replies.length} replies)`,
  );
}
