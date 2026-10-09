import { db, messages, runs, taskComments, tasks } from "@abotica/db";
import { and, eq, inArray, sql } from "@abotica/db/orm";
import { loadRunContext } from "../../src/agents/context";
import { taskTools } from "../../src/agents/tools/tasks";
import type { Harness } from "../e2e-company";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = { toolCallId: "e2e-s13", messages: [], context: {} };

/**
 * S13: a peer only comments. The harness calls the task tools directly, as the researcher, on the
 * writer's settled task: task_update is refused and changes nothing, task_comment is stored as a note
 * that reaches no conversation and wakes nobody. The manager's task_update on the same task succeeds.
 */
export default async function editRestrictions(h: Harness): Promise<void> {
  const [writer, researcher] = h.specialists;
  const from = await h.delegatorRun();
  const task = await h.delegate({
    to: writer,
    from,
    title: "Say ready",
    description: "Set this task to review with the output READY. Nothing else is needed.",
  });
  // Reported, and the manager done with the report, so no run of theirs can touch the task meanwhile.
  const settled = await h.waitFor("the writer's task to settle and its report to be handled", async () => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    if (!row?.reportedAt || !["review", "done"].includes(row.status)) return null;
    const active = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(eq(runs.conversationId, from.conversationId!), inArray(runs.status, ["queued", "running", "waiting_approval"])),
      );
    return active.length ? null : row;
  });

  const peer = await loadRunContext((await h.delegatorRun({ agentId: researcher.id })).id);
  const update = (await taskTools.task_update!(peer).execute!(
    { taskId: task.id, status: "review", output: "Replaced by a colleague" },
    call,
  )) as { error?: string };
  h.check(typeof update.error === "string", `the peer's task_update is refused (${update.error ?? "no error"})`);
  const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  h.check(after?.output === settled.output, "the peer's task_update changed nothing");

  const runsBefore = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, task.id));
  const commented = (await taskTools.task_comment!(peer).execute!(
    { taskId: task.id, body: "The word could be in capitals, I think." },
    call,
  )) as { error?: string };
  h.check(!commented.error, `the peer's task_comment is stored (${commented.error ?? "ok"})`);
  const [comment] = await db
    .select()
    .from(taskComments)
    .where(and(eq(taskComments.taskId, task.id), eq(taskComments.authorAgentId, researcher.id)));
  h.check(comment?.kind === "note", `the peer's comment is a note (${comment?.kind ?? "missing"})`);
  h.check(comment?.deliveredMessageId == null, "the peer's comment was not delivered into a conversation");

  // Give a wrong delivery the time a woken run would take to appear.
  await wait(10_000);
  const notices = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(sql`${messages.metadata}->>'kind' = 'task-notice'`, sql`${messages.metadata}->>'taskId' = ${task.id}`));
  h.check(notices.length === 0, "no notice about the peer's comment reached any conversation");
  const runsAfter = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, task.id));
  h.check(runsAfter.length === runsBefore.length, "the peer's comment woke nobody on the task");

  const manager = await loadRunContext((await h.delegatorRun({ agentId: h.manager.id })).id);
  const managed = (await taskTools.task_update!(manager).execute!({ taskId: task.id, priority: "high" }, call)) as {
    error?: string;
  };
  h.check(!managed.error, `the manager's task_update succeeds (${managed.error ?? "ok"})`);
  const [changed] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  h.check(changed?.priority === "high", "the manager's change is on the task");
}
