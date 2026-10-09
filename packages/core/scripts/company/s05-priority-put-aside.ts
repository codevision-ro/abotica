import { db, runs, tasks } from "@abotica/db";
import { and, asc, eq, inArray } from "@abotica/db/orm";
import { loadRunContext } from "../../src/agents/context";
import { runTools } from "../../src/agents/tools/runs";
import type { Harness } from "../e2e-company";

const call = { toolCallId: "e2e-s05", messages: [], context: {} };
const LONG_BRIEF =
  "Write eight short lines about Crumb's croissants, one per step: call task_comment on this task with 'line N: <text>' for N = 1 to 8, exactly one call per step. Only after the eighth, set the task to review with all eight lines as output.";
const SHORT_BRIEF = "Set this task to review with the output OK. Nothing else is needed.";

/**
 * S5: priority and putting work aside. With one run at a time and one place per conversation, while a long
 * run holds the worker, a low, a medium and an urgent task are queued in that order: they start urgent,
 * medium, low, with runs.priority 2/4/5, and the urgent one starts although the low one holds its
 * conversation's only place. Then the writer works on a low task L; the manager's delegate_task of an
 * urgent task U with putAside pauses L for U, and once U settles L goes on by itself with a new run.
 */
export default async function priorityPutAside(h: Harness): Promise<void> {
  const [writer, researcher] = h.specialists;
  await h.setSettings("system", { runConcurrency: 1 });
  await h.setSettings("agents", { parallelDelegations: 1 });

  const occupier = await h.delegate({ to: writer, title: "Croissant lines", description: LONG_BRIEF });
  await h.waitFor("the long run to hold the worker", async () => {
    const [run] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, occupier.id), eq(runs.status, "running")));
    return run;
  });

  // Low and urgent from one conversation (low takes its only place), medium from another.
  const shared = await h.delegatorRun();
  const low = await h.delegate({
    to: researcher,
    from: shared,
    title: "Low: say OK",
    description: SHORT_BRIEF,
    priority: "low",
  });
  const medium = await h.delegate({
    to: researcher,
    title: "Medium: say OK",
    description: SHORT_BRIEF,
    priority: "medium",
  });
  const urgent = await h.delegate({
    to: researcher,
    from: shared,
    title: "Urgent: say OK",
    description: SHORT_BRIEF,
    priority: "urgent",
  });
  const [urgentRow] = await db.select().from(tasks).where(eq(tasks.id, urgent.id));
  const [lowRun] = await db.select().from(runs).where(eq(runs.taskId, low.id));
  h.check(
    !urgentRow?.waitingForSlotSince && lowRun?.status === "queued",
    "the urgent task got a run although the low one holds its conversation's only place",
  );

  const started = await h.waitFor(
    "the three tasks to start",
    async () => {
      const rows = await db
        .select({ taskId: runs.taskId, startedAt: runs.startedAt, priority: runs.priority })
        .from(runs)
        .where(inArray(runs.taskId, [low.id, medium.id, urgent.id]))
        .orderBy(asc(runs.createdAt));
      return rows.length === 3 && rows.every((r) => r.startedAt) ? rows : null;
    },
    { timeoutMs: 10 * 60_000 },
  );
  const at = (taskId: string) => started.find((r) => r.taskId === taskId)!;
  h.check(
    at(urgent.id).startedAt! < at(medium.id).startedAt! && at(medium.id).startedAt! < at(low.id).startedAt!,
    "they started urgent, then medium, then low",
  );
  h.check(
    at(urgent.id).priority === 2 && at(medium.id).priority === 4 && at(low.id).priority === 5,
    `runs.priority is 2/4/5 (${at(urgent.id).priority}/${at(medium.id).priority}/${at(low.id).priority})`,
  );

  // Putting work aside, with runs no longer queued behind one another.
  await h.setSettings("system", { runConcurrency: 4 });
  const busy = await h.delegate({ to: writer, title: "Low: croissant lines", description: LONG_BRIEF, priority: "low" });
  const firstRun = await h.waitFor("the writer to work on the low task", async () => {
    const [run] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, busy.id), eq(runs.status, "running")));
    return run;
  });
  const manager = await loadRunContext((await h.delegatorRun()).id);
  const result = (await runTools.delegate_task!(manager).execute!(
    {
      agentSlug: writer.slug,
      title: "Urgent: the shop is closed today",
      description: "Set this task to review with the output CLOSED-TODAY. Nothing else is needed.",
      priority: "urgent",
      putAside: true,
      dependsOnTaskIds: [],
      userAsked: false,
      files: [],
    },
    call,
  )) as { taskId?: string; error?: string; putAside?: { taskId: string }[] };
  h.check(!result.error && Boolean(result.taskId), `the urgent task was delegated (${result.error ?? "ok"})`);
  if (!result.taskId) return;
  h.track.task(result.taskId);
  h.check(Boolean(result.putAside?.some((p) => p.taskId === busy.id)), "delegate_task says the low task was put aside");
  const [parked] = await db.select().from(tasks).where(eq(tasks.id, busy.id));
  h.check(
    parked?.status === "paused" && parked.pausedForTaskId === result.taskId,
    `the low task is paused for the urgent one (${parked?.status}, ${parked?.pausedForTaskId})`,
  );

  const settledAt = await h.waitFor("the urgent task to settle", async () => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, result.taskId!));
    return row && ["review", "done", "blocked"].includes(row.status) ? new Date() : null;
  });
  const back = await h.waitFor(
    "the low task to go on by itself",
    async () => {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, busy.id));
      const rows = await db.select().from(runs).where(eq(runs.taskId, busy.id)).orderBy(asc(runs.createdAt));
      const next = rows.find((r) => r.id !== firstRun.id);
      return row?.status === "in_progress" && next ? next : null;
    },
    { timeoutMs: 60_000 },
  );
  h.check(back.createdAt.getTime() - settledAt.getTime() < 60_000, "the low task got a new run within 60 s");
  h.check(back.conversationId === firstRun.conversationId, "it goes on in the conversation it worked in");
}
