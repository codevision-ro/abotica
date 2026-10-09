import { db, messages, runEvents, runs, taskEvents, tasks } from "@abotica/db";
import { and, asc, eq, gte, inArray, sql } from "@abotica/db/orm";
import { cancelTask, pauseTask, resumeTask, updateTask } from "../../src/index";
import type { Harness } from "../e2e-company";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LONG_BRIEF =
  "Write ten short lines about Crumb's sourdough, one per step: call task_comment on this task with 'line N: <text>' for N = 1 to 10, exactly one call per step. Only after the tenth, set the task to review with all ten lines as output.";

/**
 * S4: pause, resume, cancel cascade. The manager's task M (given by the super agent) has subtask A1, long
 * and running. Paused, A1's run stops at its next step as succeeded/paused, and the task waits paused,
 * unreported, with no run. Resumed, it goes on in the same conversation with the "resumed" intro. A2 is
 * then delegated while A1 holds the only place, so it waits for one. The super agent cancels M: M, A1 and
 * A2 end cancelled, A1's run is cancelled by an agent, nothing went through blocked or was reported, and
 * A2 no longer waits for a place.
 */
export default async function pauseResumeCancel(h: Harness): Promise<void> {
  const [writer, researcher] = h.specialists;
  await h.setSettings("agents", { parallelDelegations: 1 });

  // The super agent gave M to the manager; the manager's run on M delegates A1 and A2.
  const superRun = await h.delegatorRun({ agentId: h.orchestrator.id, projectId: null });
  const m = await h.delegate({
    to: h.manager,
    from: superRun,
    title: "Sourdough content for the website",
    description: "Get the sourdough lines written for the website.",
    start: false,
  });
  await updateTask(m.id, { status: "in_progress" }, "e2e");
  const managerRun = await h.delegatorRun({ taskId: m.id });
  const a1 = await h.delegate({ to: writer, from: managerRun, title: "Ten sourdough lines", description: LONG_BRIEF });

  const firstRun = await h.waitFor("A1 running with a finished step", async () => {
    const [run] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, a1.id), eq(runs.status, "running")));
    if (!run) return null;
    const [step] = await db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "step")))
      .limit(1);
    return step ? run : null;
  });

  // Pause: the run stops at its next step.
  const stepsAtPause = (await db.select({ steps: runs.steps }).from(runs).where(eq(runs.id, firstRun.id)))[0]!.steps;
  await pauseTask(a1.id, { by: { agentId: h.manager.id }, reason: "the client wants to review the tone first" });
  const paused = await h.waitFor("A1's run to stop", async () => {
    const [run] = await db.select().from(runs).where(eq(runs.id, firstRun.id));
    return run && !["queued", "running"].includes(run.status) ? run : null;
  });
  h.check(
    paused.status === "succeeded" && paused.failureKind === "paused",
    `A1's run ended succeeded/paused (${paused.status}/${paused.failureKind})`,
  );
  h.check(paused.steps <= stepsAtPause + 1, `it stopped within one step (${stepsAtPause} -> ${paused.steps})`);
  const [softStop] = await db
    .select({ id: runEvents.id })
    .from(runEvents)
    .where(and(eq(runEvents.runId, firstRun.id), eq(runEvents.type, "soft-stop")));
  h.check(Boolean(softStop), "a soft-stop event was logged on the run");
  // A follow-up or a report would show up within seconds.
  await wait(15_000);
  const [pausedTask] = await db.select().from(tasks).where(eq(tasks.id, a1.id));
  const a1Runs = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, a1.id));
  h.check(pausedTask?.status === "paused", `A1 is paused (${pausedTask?.status})`);
  h.check(a1Runs.length === 1, `no follow-up run while paused (${a1Runs.length} runs)`);
  h.check(pausedTask?.reportedAt === null, "A1 was not reported while paused");

  // Resume: the same conversation, with the "resumed" intro.
  const { run: resumed } = await resumeTask(a1.id, { by: { agentId: h.manager.id }, note: "Go on, the tone is fine." });
  h.check(Boolean(resumed), "resuming started a run");
  if (resumed) {
    h.check(resumed.conversationId === firstRun.conversationId, "the resumed run is in A1's conversation");
    h.check(
      resumed.input.includes("resumed after it was put aside"),
      `its input has the "resumed" intro (${resumed.input.slice(0, 160)})`,
    );
  }
  await h.waitFor("A1's resumed run to start", async () => {
    const [run] = resumed ? await db.select().from(runs).where(eq(runs.id, resumed.id)) : [];
    return run?.status === "running" ? run : null;
  });

  // A2 waits for the place A1 holds.
  const a2 = await h.delegate({
    to: researcher,
    from: managerRun,
    title: "Sourdough facts",
    description: "List three facts about how Crumb's sourdough is made, then set the task to review with them as output.",
  });
  const [waiting] = await db.select().from(tasks).where(eq(tasks.id, a2.id));
  h.check(Boolean(waiting?.waitingForSlotSince), "A2 waits for a place");

  // Cancel M as the super agent, its delegator: nothing goes up.
  const cancelledAt = new Date();
  const { cancelled } = await cancelTask(m.id, { by: { agentId: h.orchestrator.id }, reason: "the client dropped it" });
  h.check(
    [m.id, a1.id, a2.id].every((id) => cancelled.includes(id)),
    `M, A1 and A2 were cancelled (${cancelled.length} tasks)`,
  );
  const ended = await h.waitFor("A1's runs to end", async () => {
    const rows = await db.select().from(runs).where(eq(runs.taskId, a1.id)).orderBy(asc(runs.createdAt));
    return rows.every((r) => !["queued", "running", "waiting_approval"].includes(r.status)) ? rows : null;
  });
  const last = ended.at(-1)!;
  h.check(
    last.status === "cancelled" && last.failureKind === "cancelled_by_agent",
    `A1's active run was cancelled by an agent (${last.status}/${last.failureKind})`,
  );
  const after = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.id, [m.id, a1.id, a2.id]));
  h.check(
    after.every((t) => t.status === "cancelled"),
    `all three are cancelled (${after.map((t) => t.status).join(", ")})`,
  );
  h.check(after.find((t) => t.id === a2.id)?.waitingForSlotSince === null, "A2 no longer waits for a place");

  await wait(15_000);
  const blocked = await db
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(
      and(
        inArray(taskEvents.taskId, [m.id, a1.id, a2.id]),
        eq(taskEvents.type, "updated"),
        sql`${taskEvents.data}->'status'->>'to' = 'blocked'`,
      ),
    );
  h.check(!blocked.length, `no task went through blocked (${blocked.length})`);
  const reports = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        inArray(messages.conversationId, [managerRun.conversationId!, superRun.conversationId!]),
        gte(messages.createdAt, cancelledAt),
      ),
    );
  h.check(!reports.length, `no report reached the manager or the super agent after the cancel (${reports.length})`);
}
