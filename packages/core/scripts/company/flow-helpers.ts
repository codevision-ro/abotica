import { db, messages, runEvents, runs, taskEvents, tasks } from "@abotica/db";
import { and, asc, eq, gt, gte, inArray, ne, or, sql } from "@abotica/db/orm";
import { ConversationBusyError, startRun } from "../../src/index";
import type { Harness } from "../e2e-company";

/**
 * Helpers of the company scenarios: reading notices, reports and steered events back from the
 * database, and holding a delegator's conversation so its agent is not woken while a scenario watches.
 */

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Keeps an agent out of a conversation: a run there waits for an approval that never comes, so notices and
 * reports sent there are saved for its follow-up instead of waking the agent. Removed in the cleanup.
 */
export async function hold(h: Harness, conversationId: string, agentId: string): Promise<string> {
  const [run] = await db
    .insert(runs)
    .values({
      agentId,
      trigger: "delegation",
      status: "waiting_approval",
      input: "E2E: holding the conversation",
      conversationId,
      startedAt: new Date(),
    })
    .returning({ id: runs.id });
  h.track.conversation(conversationId);
  return run!.id;
}

type Metadata = { kind?: string; notice?: string; taskId?: string; tasks?: { id: string }[] };

/** The messages of a conversation with their metadata, oldest first. */
export async function conversationMessages(conversationId: string) {
  const rows = await db
    .select({ id: messages.id, metadata: messages.metadata, createdAt: messages.createdAt, parts: messages.parts })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  return rows.map((r) => ({ ...r, metadata: (r.metadata ?? {}) as Metadata }));
}

/** Task notices of `kind` in the conversation (about `taskId`, when given). */
export async function noticesIn(conversationId: string, kind: string, taskId?: string) {
  return (await conversationMessages(conversationId)).filter(
    (m) => m.metadata.kind === "task-notice" && m.metadata.notice === kind && (!taskId || m.metadata.taskId === taskId),
  );
}

/** Delegation reports in the conversation, with the task ids each lists. */
export async function reportsIn(conversationId: string) {
  return (await conversationMessages(conversationId))
    .filter((m) => m.metadata.kind === "delegation-report")
    .map((m) => ({ ...m, taskIds: (m.metadata.tasks ?? []).map((t) => t.id) }));
}

/** The `steered` events of a run, each message with the notice kind it carried. */
export async function steeredNotices(runId: string): Promise<string[]> {
  const rows = await db
    .select({ data: runEvents.data })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "steered")));
  return rows.flatMap((r) =>
    ((r.data.messages ?? []) as { notice?: string }[]).flatMap((m) => (m.notice ? [m.notice] : [])),
  );
}

/** How many `step` events the run logged. */
export async function stepsOf(runId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "step")));
  return row?.count ?? 0;
}

export async function runsOfTask(taskId: string) {
  return db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.createdAt));
}

export async function taskRow(taskId: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return row!;
}

/** The task once it settled (review, done or blocked) with no run going. */
export async function settled(h: Harness, taskId: string, label: string, timeoutMs = 5 * 60_000) {
  return h.waitFor(
    label,
    async () => {
      const task = await taskRow(taskId);
      if (!["review", "done", "blocked"].includes(task.status)) return null;
      const active = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.taskId, taskId), inArray(runs.status, ["queued", "running", "waiting_approval"])));
      return active.length ? null : task;
    },
    { timeoutMs },
  );
}

/**
 * The user's chat with the super agent, for the scenarios that run the whole company (s20-s24): `say`
 * sends a message as the user; one sent while the super agent works waits for its next step.
 */
export async function userChat(h: Harness, title: string) {
  const conversationId = await h.superConversation(title);
  const say = async (input: string) => {
    try {
      await startRun({ agentId: h.orchestrator.id, trigger: "chat", conversationId, input });
    } catch (error) {
      if (!(error instanceof ConversationBusyError)) throw error;
    }
  };
  return { conversationId, say };
}

/** The text of a message's parts, tool calls left out. */
export const textOf = (parts: unknown): string =>
  (parts as { type?: string; text?: string }[])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");

/** What the super agent wrote to the user in the conversation since `since`, oldest first. */
export async function repliesSince(conversationId: string, since: Date): Promise<string[]> {
  const rows = await db
    .select({ parts: messages.parts, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant"), gt(messages.createdAt, since)))
    .orderBy(asc(messages.createdAt));
  return rows.map((r) => textOf(r.parts)).filter((t) => t.trim());
}

/** The task the super agent gave the project's manager since the scenario started. */
export function managerTask(h: Harness, label = "the manager's task") {
  return h.waitFor(label, async () => {
    const [row] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.assigneeAgentId, h.manager.id), gte(tasks.createdAt, h.startedAt)))
      .orderBy(asc(tasks.createdAt))
      .limit(1);
    return row;
  });
}

/**
 * Tasks the specialists got since the scenario started, oldest first: the two of the harness and any
 * agent of the install the manager added to the team.
 */
export async function specialistTasks(h: Harness) {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, h.project.id),
        ne(tasks.assigneeAgentId, h.manager.id),
        ne(tasks.assigneeAgentId, h.orchestrator.id),
        gte(tasks.createdAt, h.startedAt),
      ),
    )
    .orderBy(asc(tasks.createdAt));
}

/**
 * Waits until the company is quiet: no run of its agents or in `conversationId` queued, running or
 * waiting, three polls in a row (a report or a notice may start the next one just after).
 */
export async function quiet(h: Harness, conversationId: string, label: string, timeoutMs = 15 * 60_000) {
  const ids = [h.manager.id, ...h.specialists.map((s) => s.id)];
  let calm = 0;
  await h.waitFor(
    label,
    async () => {
      const active = await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            gte(runs.createdAt, h.startedAt),
            inArray(runs.status, ["queued", "running", "waiting_approval"]),
            or(inArray(runs.agentId, ids), eq(runs.conversationId, conversationId), eq(runs.projectId, h.project.id)),
          ),
        );
      calm = active.length ? 0 : calm + 1;
      return calm >= 3;
    },
    { timeoutMs, everyMs: 5_000 },
  );
}

/** When the task first reached review or done (its task events); null if it never did. */
export async function firstSettledAt(taskId: string): Promise<Date | null> {
  const [event] = await db
    .select({ at: taskEvents.createdAt })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        eq(taskEvents.type, "updated"),
        sql`${taskEvents.data}->'status'->>'to' in ('review', 'done')`,
      ),
    )
    .orderBy(asc(taskEvents.createdAt))
    .limit(1);
  return event?.at ?? null;
}
