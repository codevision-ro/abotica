import { agents, conversations, db, messages, runs, taskComments, taskDependencies, tasks } from "@abotica/db";
import { UserError } from "@abotica/i18n";
import { generateId, type UIMessage } from "ai";
import { and, asc, eq, gt, inArray } from "@abotica/db/orm";
import { createConversation } from "./conversations";
import { inputPath } from "../agents/workspace-paths";
import { publish } from "../infra/events";
import { listFiles } from "../files/files";
import { enqueueRun } from "../infra/queues";
import { cancelPendingRun, failRun, publishRunUpdate, requestResume, takeResumeRequest } from "./run-lifecycle";
import {
  activeTaskRun,
  assertTaskDependenciesDone,
  isActiveTaskRunConflict,
  TaskBusyError,
  updateTask,
} from "../tasks/tasks";

export type Run = typeof runs.$inferSelect;
export type RunTrigger = Run["trigger"];

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
    await enqueueRun(run!.id);
  } catch (error) {
    // A queued run no job will execute would hold the conversation's active run slot forever.
    await failRun(run!, error instanceof Error ? error.message : String(error), ["queued"]);
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

  const lines = [
    `# Task: ${task.title}`,
    `ID: ${task.id} · Priority: ${task.priority}${task.deadline ? ` · Deadline: ${task.deadline.toISOString()}` : ""}`,
    "",
    task.description || "(no description)",
  ];
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
    for (const c of comments) lines.push(`- ${c.kind === "agent" ? (c.agent ?? "agent") : c.kind}: ${c.body}`);
  }
  lines.push(
    "",
    task.delegatedByRunId
      ? "When you finish, call task_update with status 'review' and put the full result in output. The agent that delegated the task reviews it and decides whether it is done."
      : "When you finish, call task_update with status 'review' (or 'done' if it needs no review) and put the full result in output.",
    "If you are blocked, set status 'blocked' and explain why in a comment.",
  );
  return lines.join("\n");
}

/**
 * Starts the run of a task's assignee. Refuses a task that is missing, unassigned, waiting for its
 * dependencies or already has an active run (TaskBusyError).
 */
export async function startTaskRun(taskId: string, opts: { parentRunId?: string | null } = {}): Promise<Run> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new UserError("tasks.errors.notFound");
  if (!task.assigneeAgentId) throw new UserError("tasks.errors.notAssigned");
  await assertTaskDependenciesDone(taskId);
  // Checked before the task changes; a run started at the same moment still fails on the unique index.
  if (await activeTaskRun(taskId)) throw new TaskBusyError(taskId);
  await updateTask(taskId, { status: "in_progress" }, "system");
  return startRun({
    agentId: task.assigneeAgentId,
    trigger: opts.parentRunId ? "delegation" : "task",
    input: await taskBrief(taskId),
    taskId,
    projectId: task.projectId,
    parentRunId: opts.parentRunId ?? null,
    title: task.title,
  });
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
 * which then does the same.
 * Returns null when the run does not exist or has already finished.
 */
export async function cancelRun(id: string, reason: string): Promise<Run | null> {
  const stopped = await cancelPendingRun(id, reason);
  if (stopped) return stopped;
  const [running] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.status, "running")));
  if (!running) return null;
  await publish({ type: "run.cancel", runId: id, reason });
  return running;
}

/**
 * Stops whatever a conversation has going: a queued or waiting run ends at once, a running one gets
 * the cancel event and the worker aborts it, which stops its tools (their abort signal) and the
 * processes it started. Returns the runs it stopped.
 */
export async function cancelConversationRuns(conversationId: string, reason: string): Promise<Run[]> {
  const active = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.conversationId, conversationId), inArray(runs.status, ["queued", "running", "waiting_approval"])));
  const stopped = await Promise.all(active.map((r) => cancelRun(r.id, reason)));
  return stopped.filter((r): r is Run => r !== null);
}

/** The super agent: the single orchestrator that talks to the user. */
export async function getOrchestrator() {
  const agent = await db.query.agents.findFirst({
    where: (a, { and, eq }) => and(eq(a.isOrchestrator, true), eq(a.enabled, true)),
    orderBy: (a, { asc }) => asc(a.createdAt),
  });
  if (!agent) throw new UserError("errors.noOrchestrator");
  return agent;
}

export { requestResume };

/**
 * After a run ends, answers user messages that arrived while it was working (they were queued
 * by ConversationBusyError). All of them are handled together in one follow-up run.
 */
export async function startFollowUpIfQueued(finished: Run): Promise<Run | null> {
  if (!finished.conversationId || !finished.startedAt || !finished.agentId) return null;
  const resume = await takeResumeRequest(finished.conversationId);
  const [queued] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, finished.conversationId),
        eq(messages.role, "user"),
        gt(messages.createdAt, finished.startedAt),
      ),
    )
    .limit(1);
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
