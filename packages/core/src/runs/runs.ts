import { agents, conversations, db, messages, runs, taskComments, taskDependencies, taskEvents, tasks } from "@abotica/db";
import { UserError } from "@abotica/i18n";
import { generateId, type UIMessage } from "ai";
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "@abotica/db/orm";
import { createConversation } from "./conversations";
import { inputPath } from "../agents/workspace-paths";
import { publish } from "../infra/events";
import { listFiles } from "../files/files";
import { enqueueRun } from "../infra/queues";
import type { RunFailureKind } from "./run-failures";
import {
  cancelPendingRun,
  clearHeldReplies,
  countHeldReply,
  failRun,
  publishRunUpdate,
  requestResume,
  takeResumeRequest,
} from "./run-lifecycle";
import { loadUnsteeredMessages, markUndelivered } from "./run-messages";
import { isDelegationReport } from "../tasks/delegation-report";
import { queuePriority } from "../tasks/priority";
import {
  activeTaskRun,
  assertTaskDependenciesDone,
  isActiveTaskRunConflict,
  resetFixRounds,
  TaskBusyError,
  TaskCircuitOpenError,
  taskFailureStreak,
  updateTask,
} from "../tasks/tasks";

export type Run = typeof runs.$inferSelect;
export type RunTrigger = Run["trigger"];

/**
 * Why a task goes back to its assignee in the conversation it worked in: its delegator gave it back, an
 * instruction or an answer arrived, it was resumed, it goes on after a step or time limit, its failed run
 * is retried, or it is a colleague's help.
 */
export type RoundReason = "given-back" | "instruction" | "answer" | "resumed" | "continue" | "retry" | "help";

export async function appendUserMessage(conversationId: string, message: UIMessage | string): Promise<UIMessage> {
  const ui: UIMessage =
    typeof message === "string" ? { id: generateId(), role: "user", parts: [{ type: "text", text: message }] } : message;
  await db
    .insert(messages)
    .values({ id: ui.id, conversationId, role: ui.role, parts: ui.parts, metadata: (ui.metadata as never) ?? null })
    .onConflictDoNothing();
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
  return ui;
}

/**
 * The conversation already has a queued or running run. The new message is saved and the
 * worker answers it in a follow-up run as soon as the current one ends.
 */
export class ConversationBusyError extends UserError {
  constructor(readonly conversationId: string) {
    super("errors.conversationBusy");
  }
}

function isActiveRunConflict(error: unknown): boolean {
  for (
    let e = error as { code?: string; constraint_name?: string; cause?: unknown } | undefined;
    e;
    e = e.cause as typeof e
  ) {
    if (e.code === "23505" && e.constraint_name === "runs_one_active_per_conversation") return true;
  }
  return false;
}

export async function startRun(input: {
  agentId: string;
  trigger: RunTrigger;
  /** Text added as a user message before the run. Empty to continue (e.g. after an approval). */
  input?: string;
  /** A prepared user message (e.g. one carrying metadata), added instead of `input`. */
  message?: UIMessage;
  conversationId?: string | null;
  taskId?: string | null;
  /** Left out, the run works in its conversation's project, if it has one. */
  projectId?: string | null;
  parentRunId?: string | null;
  title?: string;
}): Promise<Run> {
  const text = input.input ?? input.message?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n") ?? "";
  let conversationId = input.conversationId ?? null;
  let projectId = input.projectId ?? null;
  if (conversationId && !projectId) {
    const [conversation] = await db
      .select({ projectId: conversations.projectId })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    projectId = conversation?.projectId ?? null;
  }
  if (!conversationId) {
    const conversation = await createConversation({
      agentId: input.agentId,
      channel: "internal",
      title: (input.title || text || "Run").slice(0, 120),
    });
    conversationId = conversation.id;
  }
  if (input.message) await appendUserMessage(conversationId, input.message);
  else if (text) await appendUserMessage(conversationId, text);

  const priority = queuePriority({ trigger: input.trigger });
  let run: Run | undefined;
  try {
    [run] = await db
      .insert(runs)
      .values({
        agentId: input.agentId,
        trigger: input.trigger,
        input: text,
        conversationId,
        taskId: input.taskId ?? null,
        projectId,
        parentRunId: input.parentRunId ?? null,
        priority,
      })
      .returning();
  } catch (error) {
    // A conversation made for this run alone (with its brief) goes with it.
    if (!input.conversationId) {
      await db
        .delete(conversations)
        .where(eq(conversations.id, conversationId))
        .catch((cleanup: unknown) => console.error(`[runs] removing conversation ${conversationId} failed:`, cleanup));
    }
    if (isActiveRunConflict(error)) throw new ConversationBusyError(conversationId);
    if (input.taskId && isActiveTaskRunConflict(error)) throw new TaskBusyError(input.taskId);
    throw error;
  }
  try {
    await enqueueRun(run!.id, priority);
  } catch (error) {
    // A queued run no job will execute would hold the conversation's active run slot forever.
    await failRun(run!, error instanceof Error ? error.message : String(error), "unqueued", ["queued"]);
    throw error;
  }
  await publishRunUpdate(run!);
  return run!;
}

/**
 * Starts a run that continues a conversation: a follow-up, an approval continuation or a delegation
 * report. When its task already has an active run elsewhere (the task was started again meanwhile), it
 * continues without the task: the conversation still gets its answer and the other run keeps the task.
 * Retrying adds no second message: a prepared message keeps its id, and continuations carry no text.
 */
export async function startContinuation(input: Parameters<typeof startRun>[0]): Promise<Run> {
  try {
    return await startRun(input);
  } catch (error) {
    if (!(error instanceof TaskBusyError)) throw error;
    return startRun({ ...input, taskId: null });
  }
}

type TaskRow = typeof tasks.$inferSelect;

const taskHeader = (task: TaskRow) =>
  `ID: ${task.id} · Priority: ${task.priority}${task.deadline ? ` · Deadline: ${task.deadline.toISOString()}` : ""}`;

/**
 * How the brief ends, in a new conversation or a continued one: where the result goes. How to escalate
 * when blocked is in the assignee's kind prompt.
 */
const finishLines = (task: TaskRow) => [
  task.delegatedByRunId
    ? "When you finish, call task_update with status 'review' and put the full result in output. The agent that delegated the task reviews it and decides whether it is done."
    : task.reportsUp
      ? "A schedule or trigger started this task, and its result goes up on its own to whoever oversees the work (the project's manager, or the super agent). When you finish, call task_update with status 'review' and the full result in output. Only when the task is a routine check and it found nothing new and nothing wrong, call task_update with nothingNew: true and the output instead: the task is done, the output stays on it, and nobody is told. Anything the task asked you to produce (a text, a list, data, a report) is a result and goes up with 'review', and so does every finding. A problem never ends quietly: when you are blocked or something failed, set 'blocked' with a task_comment."
      : "When you finish, call task_update with status 'review' (or 'done' if it needs no review) and put the full result in output.",
];

const authorOf = (c: { kind: string; agent: string | null }) => (c.kind === "agent" ? (c.agent ?? "agent") : c.kind);

/** Builds the brief an agent gets for a task: description, dependency outputs, files and comments. */
async function taskBrief(taskId: string): Promise<string> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new Error(`Task ${taskId} not found`);
  const deps = await db
    .select({ title: tasks.title, output: tasks.output })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(eq(taskDependencies.taskId, taskId));
  const comments = await db
    .select({ body: taskComments.body, kind: taskComments.authorKind, agent: agents.slug })
    .from(taskComments)
    .leftJoin(agents, eq(agents.id, taskComments.authorAgentId))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt));

  const lines = [`# Task: ${task.title}`, taskHeader(task), "", task.description || "(no description)"];
  if (deps.length) {
    lines.push("", "## Results of the tasks this one depends on");
    for (const d of deps) lines.push(`### ${d.title}`, d.output ?? "(no output)");
  }
  const taskFiles = await listFiles({ taskId });
  if (taskFiles.length) {
    // Each handed-over file is a copy with its own id, so the delegator's path does not apply here.
    lines.push("", "## Files of the task (copied into your workspace)");
    for (const f of taskFiles) lines.push(`- ${f.name} (${f.mimeType}): ${inputPath(f)}`);
  }
  if (comments.length) {
    lines.push("", "## Comments");
    for (const c of comments) lines.push(`- ${authorOf(c)}: ${c.body}`);
  }
  lines.push("", ...finishLines(task));
  return lines.join("\n");
}

/** The conversation a task's assignee worked on it in, to continue: `since` is when its latest run there started. */
type PreviousRound = { conversationId: string; since: Date; compacted: boolean };

/**
 * The conversation of the agent's latest run on the task, when it can take the task again: an internal
 * one that still exists and has no run going (one waiting for an approval continues there later).
 * Continuing it keeps what the agent did in earlier rounds: its subtasks, briefs and files.
 */
async function previousRound(taskId: string, agentId: string): Promise<PreviousRound | null> {
  const [last] = await db
    .select({ conversationId: runs.conversationId, createdAt: runs.createdAt })
    .from(runs)
    .innerJoin(conversations, eq(conversations.id, runs.conversationId))
    .where(and(eq(runs.taskId, taskId), eq(runs.agentId, agentId), eq(conversations.channel, "internal")))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (!last?.conversationId) return null;
  const { conversationId } = last;
  const [[busy], [compaction]] = await Promise.all([
    db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.conversationId, conversationId), inArray(runs.status, ["queued", "running", "waiting_approval"])))
      .limit(1),
    db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), sql`${messages.metadata}->>'kind' = 'compaction'`))
      .limit(1),
  ]);
  if (busy) return null;
  return { conversationId, since: last.createdAt, compacted: Boolean(compaction) };
}

/**
 * The message that gives a task back to the agent in the conversation it worked on it before: the brief
 * is already there, so only what changed since its latest run there. A compacted conversation may have
 * lost the details of the brief to the summary: it gets the full brief again.
 */
async function roundBrief(taskId: string, agentId: string, round: PreviousRound): Promise<string> {
  const intro =
    "The task was given back to you. Your earlier work on it is above in this conversation: continue from there.";
  if (round.compacted) return `${intro}\n\n${await taskBrief(taskId)}`;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new Error(`Task ${taskId} not found`);
  const { since } = round;
  const [described, deps, newFiles, comments] = await Promise.all([
    db
      .select({ id: taskEvents.id })
      .from(taskEvents)
      .where(
        and(
          eq(taskEvents.taskId, taskId),
          eq(taskEvents.type, "updated"),
          gt(taskEvents.createdAt, since),
          sql`${taskEvents.data} -> 'description' is not null`,
        ),
      )
      .limit(1),
    // Dependencies done since then; the earlier ones were in the first brief.
    db
      .select({ title: tasks.title, output: tasks.output })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(and(eq(taskDependencies.taskId, taskId), gt(tasks.completedAt, since))),
    listFiles({ taskId }),
    // Its own comments the agent knows; the user's, other agents' and the platform's (a wakeup) it does not.
    db
      .select({ body: taskComments.body, kind: taskComments.authorKind, agent: agents.slug })
      .from(taskComments)
      .leftJoin(agents, eq(agents.id, taskComments.authorAgentId))
      .where(
        and(
          eq(taskComments.taskId, taskId),
          gt(taskComments.createdAt, since),
          or(isNull(taskComments.authorAgentId), ne(taskComments.authorAgentId, agentId)),
        ),
      )
      .orderBy(asc(taskComments.createdAt)),
  ]);
  const lines = [`# Task: ${task.title}`, taskHeader(task), "", intro];
  if (described.length)
    lines.push("", "## Description (changed since your previous run)", task.description || "(no description)");
  if (deps.length) {
    lines.push("", "## Results of the tasks this one depends on, done since your previous run");
    for (const d of deps) lines.push(`### ${d.title}`, d.output ?? "(no output)");
  }
  // Handed over since then (a replaced file has a new id, so a new path); the agent's own files it knows.
  const handed = newFiles.filter((f) => f.createdAt > since && f.agentId !== agentId);
  if (handed.length) {
    lines.push("", "## New files of the task (copied into your workspace)");
    for (const f of handed) lines.push(`- ${f.name} (${f.mimeType}): ${inputPath(f)}`);
  }
  if (comments.length) {
    lines.push("", "## New comments");
    for (const c of comments) lines.push(`- ${authorOf(c)}: ${c.body}`);
  } else lines.push("", "No new comments since your previous run.");
  lines.push("", ...finishLines(task));
  return lines.join("\n");
}

/**
 * Starts the run of a task's assignee. Refuses a task that is missing, unassigned, waiting for its
 * dependencies, already has an active run (TaskBusyError) or whose runs keep failing
 * (TaskCircuitOpenError). `force` is the user's start: it goes past the circuit breaker, and resets it
 * and the automatic fix rounds of the task's pull requests. A task the assignee worked on before
 * continues in that conversation (previousRound), so a send-back or a wakeup keeps its earlier work.
 */
export async function startTaskRun(
  taskId: string,
  opts: { parentRunId?: string | null; force?: boolean; trigger?: RunTrigger } = {},
): Promise<Run> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new UserError("tasks.errors.notFound");
  if (!task.assigneeAgentId) throw new UserError("tasks.errors.notAssigned");
  await assertTaskDependenciesDone(taskId);
  // Checked before the task changes; a run started at the same moment still fails on the unique index.
  if (await activeTaskRun(taskId)) throw new TaskBusyError(taskId);
  if (opts.force) await resetFixRounds(taskId);
  else {
    const streak = await taskFailureStreak(taskId);
    if (streak.open) throw new TaskCircuitOpenError(taskId, streak);
  }
  await updateTask(taskId, { status: "in_progress" }, "system");
  const start = {
    agentId: task.assigneeAgentId,
    trigger: opts.trigger ?? (opts.parentRunId ? ("delegation" as const) : ("task" as const)),
    taskId,
    projectId: task.projectId,
    parentRunId: opts.parentRunId ?? null,
  };
  const round = await previousRound(taskId, task.assigneeAgentId);
  if (round) {
    const message: UIMessage = {
      id: generateId(),
      role: "user",
      parts: [{ type: "text", text: await roundBrief(taskId, task.assigneeAgentId, round) }],
    };
    try {
      return await startRun({ ...start, conversationId: round.conversationId, message });
    } catch (error) {
      // No run was made for the message: it must not stay for the active run's follow-up to answer.
      const refused = error instanceof ConversationBusyError || error instanceof TaskBusyError;
      if (refused) await db.delete(messages).where(eq(messages.id, message.id));
      // A run started there meanwhile: the task starts in a conversation of its own, as before.
      if (!(error instanceof ConversationBusyError)) throw error;
    }
  }
  return startRun({ ...start, input: await taskBrief(taskId), title: task.title });
}

/** Runs not finished yet (queued, running or waiting for approval), with their agent's name (null once deleted). */
export async function listActiveRuns(): Promise<{ agent: string | null; status: Run["status"]; trigger: RunTrigger }[]> {
  return db
    .select({ agent: agents.name, status: runs.status, trigger: runs.trigger })
    .from(runs)
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .where(inArray(runs.status, ["queued", "running", "waiting_approval"]));
}

/** Stored in runs.error when the user cancels a run; the web UI shows it translated. */
export const RUN_CANCELLED_BY_USER = "Cancelled by user";

/**
 * Stops a run. Queued and waiting runs end right away (their pending approvals expire, their task
 * is blocked and reported to its delegator); a running one is aborted by the worker executing it,
 * which then does the same. `kind` says who stopped it (see RunFailureKind).
 * Returns null when the run does not exist or has already finished.
 */
export async function cancelRun(id: string, reason: string, kind: RunFailureKind): Promise<Run | null> {
  const stopped = await cancelPendingRun(id, reason, kind);
  if (stopped) return stopped;
  const [running] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.status, "running")));
  if (!running) return null;
  await publish({ type: "run.cancel", runId: id, reason, kind });
  return running;
}

/**
 * Stops whatever a conversation has going: a queued or waiting run ends at once, a running one gets
 * the cancel event and the worker aborts it, which stops its tools (their abort signal) and the
 * processes it started. Returns the runs it stopped.
 */
export async function cancelConversationRuns(conversationId: string, reason: string, kind: RunFailureKind): Promise<Run[]> {
  const active = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.conversationId, conversationId), inArray(runs.status, ["queued", "running", "waiting_approval"])));
  const stopped = await Promise.all(active.map((r) => cancelRun(r.id, reason, kind)));
  return stopped.filter((r): r is Run => r !== null);
}

/** The super agent: the single orchestrator that talks to the user. */
export async function getOrchestrator() {
  const agent = await db.query.agents.findFirst({
    where: (a, { and, eq }) => and(eq(a.kind, "orchestrator"), eq(a.enabled, true)),
    orderBy: (a, { asc }) => asc(a.createdAt),
  });
  if (!agent) throw new UserError("errors.noOrchestrator");
  return agent;
}

export { requestResume };

/**
 * After a run ends, answers user messages that arrived while it was working (they were queued
 * by ConversationBusyError). All of them are handled together in one follow-up run. Messages the run
 * took in between its steps (steeredInto, see agents/steering.ts) were answered by it.
 */
export async function startFollowUpIfQueued(finished: Run): Promise<Run | null> {
  if (!finished.conversationId || !finished.startedAt || !finished.agentId) return null;
  const resume = await takeResumeRequest(finished.conversationId);
  const queued = (await loadUnsteeredMessages(finished.conversationId, finished.startedAt)).length > 0;
  if (!queued && !resume) return null;
  try {
    return await startContinuation({
      agentId: finished.agentId,
      trigger: finished.trigger,
      conversationId: finished.conversationId,
      projectId: finished.projectId,
      taskId: finished.taskId,
      parentRunId: finished.id,
    });
  } catch (error) {
    if (error instanceof ConversationBusyError) return null; // someone else already started it
    throw error;
  }
}

/** Telegram replies held back in a row, at most: the one after is sent whatever arrived meanwhile. */
export const MAX_HELD_REPLIES = 2;

/**
 * The send gate before a Telegram reply (AgentTeams): when the user wrote again while the run worked
 * and no step took it in (it came during the last one), the answer is to a stale state. It is held
 * back and marked undelivered, and the follow-up answers everything in one reply, told that its
 * previous answer never reached the user. At most MAX_HELD_REPLIES in a row; a reply sent clears the
 * count. Returns whether the reply is held: the caller then does not send it.
 */
export async function holdStaleReply(finished: Run): Promise<boolean> {
  const { conversationId, startedAt } = finished;
  if (!conversationId || !startedAt) return false;
  // Only an answer is held: a failure, a stop or a question for approval is news either way. And only
  // for what the user wrote: a delegation report is answered by the follow-up after this reply.
  const arrived = finished.status === "succeeded" ? await loadUnsteeredMessages(conversationId, startedAt) : [];
  const wroteAgain = arrived.some((m) => !isDelegationReport(m.message.metadata));
  if (wroteAgain && (await countHeldReply(conversationId)) <= MAX_HELD_REPLIES) {
    await markUndelivered(finished);
    return true;
  }
  await clearHeldReplies(conversationId);
  return false;
}
