import { db, runs, taskComments, taskEvents, tasks } from "@abotica/db";
import { and, eq, gte, inArray, ne } from "@abotica/db/orm";
import { Queue } from "bullmq";
import { loadRunContext } from "../../src/agents/context";
import { peerTools } from "../../src/agents/tools/peers";
import { createRedis, createTask, type NotificationJob, postInstruction, QUEUE, type Task } from "../../src/index";
import type { Harness } from "../e2e-company";
import { hold } from "./flow-helpers";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = { toolCallId: "e2e-s18", messages: [], context: {} };
/** Agent wakes allowed per task before the user steps in: the lowest bound, so the guard trips after two. */
const MAX_AUTO_ROUNDS = 2;

/** Text notifications queued since `since` (the worker may have sent them already). */
async function textNotifications(since: Date): Promise<string[]> {
  const queue = new Queue<NotificationJob>(QUEUE.notifications, { connection: createRedis() });
  try {
    const jobs = await queue.getJobs(["waiting", "active", "completed", "failed", "delayed"], 0, 200);
    return jobs
      .filter((j) => j.timestamp >= since.getTime() && j.data.kind === "text")
      .map((j) => (j.data.kind === "text" ? j.data.text : ""));
  } finally {
    await queue.close();
  }
}

/** The task settled and idle: in review, and no run of it or of its delegator's conversation still going. */
async function settledAndIdle(task: Task, conversationId: string, holdId: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  if (!row || row.status !== "review" || !row.reportedAt) return null;
  const active = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        inArray(runs.status, ["queued", "running", "waiting_approval"]),
        eq(runs.conversationId, conversationId),
        ne(runs.id, holdId),
      ),
    );
  const own = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, task.id), inArray(runs.status, ["queued", "running", "waiting_approval"])));
  return active.length || own.length ? null : row;
}

/**
 * S18: the loop guards. The manager's comment-wakes on a settled task are counted: with
 * agents.maxAutoRounds at its lowest (2, so the run stays short; the default is 10), the third gets an
 * error, its comment is still stored, a rounds-limit event is recorded and the user is notified. Then a
 * help task's assignee cannot ask a colleague in turn (help is one level deep).
 */
export default async function guards(h: Harness): Promise<void> {
  const [writer, researcher] = h.specialists;
  await h.setSettings("agents", { maxAutoRounds: MAX_AUTO_ROUNDS });

  const from = await h.delegatorRun();
  // The harness is the manager here: its agent is kept out, so it does not close the task meanwhile.
  const holdId = await hold(h, from.conversationId!, h.manager.id);
  const task = await h.delegate({
    to: writer,
    from,
    title: `Say ready ${Date.now().toString(36)}`,
    description:
      "Set this task to review with the output READY. When a new instruction about it arrives, do exactly what " +
      "it says, then set the task to review again. Nothing else is needed.",
  });
  await h.waitFor("the writer's task to settle", () => settledAndIdle(task, from.conversationId!, holdId));

  const by = { agentId: h.manager.id };
  for (let round = 1; round <= MAX_AUTO_ROUNDS; round++) {
    const posted = await postInstruction(task.id, `Change the output to READY ${round}.`, by);
    h.check(posted.delivered === "woke", `the manager's comment ${round} wakes the writer (${posted.delivered})`);
    await h.waitFor(`the writer to apply comment ${round}`, async () => {
      const row = await settledAndIdle(task, from.conversationId!, holdId);
      return row?.output?.includes(`READY ${round}`) ? row : null;
    });
  }
  const [counted] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  h.check(counted?.agentRounds === MAX_AUTO_ROUNDS, `agent rounds counted (${counted?.agentRounds})`);

  const before = new Date();
  const refused = await postInstruction(task.id, `Change the output to READY ${MAX_AUTO_ROUNDS + 1}.`, by);
  h.check(
    refused.delivered === "refused" && Boolean(refused.error),
    `comment ${MAX_AUTO_ROUNDS + 1} gets an error (${refused.delivered}: ${refused.error ?? "no error"})`,
  );
  const [stored] = await db.select().from(taskComments).where(eq(taskComments.id, refused.comment.id));
  h.check(stored?.kind === "instruction", `the refused comment is stored (${stored?.kind ?? "missing"})`);
  const limit = await db
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.type, "rounds-limit")));
  h.check(limit.length === 1, `a rounds-limit event (${limit.length})`);
  const told = await h.waitFor(
    "the user's notification",
    async () => (await textNotifications(before)).find((text) => text.includes(task.title)) ?? null,
    { timeoutMs: 30_000 },
  );
  h.check(Boolean(told), "the user is notified");
  await wait(10_000);
  const woken = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, task.id), gte(runs.createdAt, before)));
  h.check(woken.length === 0, `the refused comment woke nobody (${woken.length} run)`);

  // A help task's assignee asks a colleague in turn: refused, help is one level deep.
  const own = await h.delegate({
    to: writer,
    title: "Opening hours text",
    description: "Write the bakery's opening hours.",
    start: false,
  });
  const asker = await h.delegatorRun({ agentId: writer.id, taskId: own.id });
  const help = await createTask(
    {
      title: "Help: what are the opening hours?",
      description: "The writer asks: what are the bakery's opening hours?",
      projectId: h.project.id,
      parentId: own.id,
      assigneeAgentId: researcher.id,
      delegatedByRunId: asker.id,
    },
    "e2e",
  );
  h.track.task(help.id);
  await db.update(tasks).set({ kind: "help" }).where(eq(tasks.id, help.id));
  const helper = await loadRunContext((await h.delegatorRun({ agentId: researcher.id, taskId: help.id })).id);
  const asked = (await peerTools.ask_colleague!(helper).execute!(
    { agentSlug: writer.slug, question: "Do you know the opening hours?", files: [] },
    call,
  )) as { error?: string };
  h.check(
    typeof asked.error === "string",
    `the help task's assignee cannot ask a colleague (${asked.error ?? "no error"})`,
  );
  const nested = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentId, help.id));
  h.check(nested.length === 0, "no help task was created under the help task");
}
