import {
  type AgentKind,
  agents,
  conversations,
  db,
  messages,
  runs,
  taskComments,
  taskDependencies,
  taskEvents,
  tasks,
} from "@abotica/db";
import { UserError } from "@abotica/i18n";
import { generateId, type UIMessage } from "ai";
import { and, asc, desc, eq, gt, inArray, sql } from "@abotica/db/orm";
import { createConversation } from "./conversations";
import { inputPath } from "../agents/workspace-paths";
import { neutralizeMarkers } from "../agents/untrusted";
import { isUniqueViolation } from "../infra/db-errors";
import { publish } from "../infra/events";
import { listFiles, type StoredFile } from "../files/files";
import { enqueueRun } from "../infra/queues";
import type { RunFailureKind } from "./run-failures";
import {
  cancelPendingRun,
  clearHeldReplies,
  countHeldReply,
  failRun,
  publishRunUpdate,
  takeResumeRequest,
} from "./run-lifecycle";
import { loadUnsteeredMessages, markUndelivered } from "./run-messages";
import { getSettings } from "../settings/settings";
import { isPlatformNotice, isTaskNotice, type TaskNoticeKind, type TaskNoticeMetadata } from "../tasks/task-notices";
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
import type { TaskNotice } from "./deliver";

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
  /** Its queue priority (tasks/priority.ts); left out, from the trigger and its task's priority. */
  priority?: number;
  /** 2 and up for an automatic retry of a run a passing failure cut (runs.attempt). */
  attempt?: number;
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

  const priority =
    input.priority ??
    queuePriority({ trigger: input.trigger, taskPriority: input.taskId ? await taskPriority(input.taskId) : null });
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
        attempt: input.attempt ?? 1,
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
    if (isUniqueViolation(error, "runs_one_active_per_conversation")) throw new ConversationBusyError(conversationId);
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

async function taskPriority(taskId: string): Promise<TaskRow["priority"] | null> {
  const [task] = await db.select({ priority: tasks.priority }).from(tasks).where(eq(tasks.id, taskId));
  return task?.priority ?? null;
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

async function agentKind(agentId: string | null): Promise<AgentKind | null> {
  if (!agentId) return null;
  const [agent] = await db.select({ kind: agents.kind }).from(agents).where(eq(agents.id, agentId));
  return agent?.kind ?? null;
}

const taskHeader = (task: TaskRow) =>
  `ID: ${task.id} · Priority: ${task.priority}${task.deadline ? ` · Deadline: ${task.deadline.toISOString()}` : ""}`;

/**
 * How the brief ends, in a new conversation or a continued one: where the result goes. How to escalate
 * when blocked is in the assignee's kind prompt. A colleague's question (a help task) goes straight back
 * to the colleague who asked. A manager's task is its team's work: the brief says so where a specialist's
 * says to deliver, or the manager takes the brief as its own to do.
 */
const finishLines = (task: TaskRow, assignee: AgentKind | null) => [
  task.kind !== "help" && assignee === "manager"
    ? "This is your team's work: plan it and delegate each piece to the specialist whose role fits (delegate_task, a complete brief each); their results come back here as notices. Do not produce the deliverable yourself. Once everything you delegated is back and passes your check, call task_update with status 'review' and the combined result in output; whoever gave you the task reviews it."
    : task.kind === "help"
      ? "This is a colleague's question: answer it briefly and completely, then call task_update with status 'review' and the answer in output. It goes straight back to them; if you could not find something out, say so in the answer."
      : task.delegatedByRunId
        ? "When you finish, call task_update with status 'review' and put the full result in output. The agent that delegated the task reviews it and decides whether it is done."
        : task.reportsUp
          ? "A schedule or trigger started this task, and its result goes up on its own to whoever oversees the work (the project's manager, or the super agent). When you finish, call task_update with status 'review' and the full result in output. Only when the task is a routine check and it found nothing new and nothing wrong, call task_update with nothingNew: true and the output instead: the task is done, the output stays on it, and nobody is told. Anything the task asked you to produce (a text, a list, data, a report) is a result and goes up with 'review', and so does every finding. A problem never ends quietly: when you are blocked or something failed, set 'blocked' with a task_comment."
          : "When you finish, call task_update with status 'review' (or 'done' if it needs no review) and put the full result in output.",
];

type CommentLine = { body: string; author: string; agent: string | null; kind: string };

/** A comment as the brief lists it: its author, and its kind when it is more than a note. */
const commentLine = (c: CommentLine) =>
  `- ${c.author === "agent" ? (c.agent ?? "agent") : c.author}${c.kind === "note" ? "" : ` (${c.kind})`}: ${c.body}`;

const NOTICE_HEADER = "[Automatic notice from Abotica, not written by the user]";

const NOTICE_LABELS: Record<TaskNoticeKind, string> = {
  instruction: "New instruction",
  question: "Question",
  answer: "Answer",
  progress: "Progress",
  control: "Change to the work",
  reminder: "Reminder",
  alert: "Alert",
  "help-answer": "A colleague's answer",
};

/** What the agent does with a notice that changes its work: it is binding, not information. */
const NOTICE_FOLLOW: Partial<Record<TaskNoticeKind, string>> = {
  instruction:
    "Apply this to the work underway now, in this run: where it differs from your brief or from what you planned, it wins. Your output must reflect it.",
  control: "Act on this now.",
  answer: "Use this answer and go on with the work.",
  "help-answer": "Use this and go on with the work.",
};

/**
 * A notice as the agent reads it: the platform's header (the Rules section says such text is never the
 * user writing), what it is, from whom and about which task, then its text. Whoever builds the text
 * wraps what agents wrote as untrusted data, and passes instructions going down through neutralizeMarkers.
 */
export function noticeText(
  task: { id: string; title: string },
  notice: Pick<TaskNotice, "kind" | "text" | "from" | "fyi">,
): string {
  const about = `${NOTICE_LABELS[notice.kind]} from ${neutralizeMarkers(notice.from)} about the task "${neutralizeMarkers(task.title)}" (${task.id}):`;
  const follow = notice.fyi ? undefined : NOTICE_FOLLOW[notice.kind];
  return `${NOTICE_HEADER}\n${about}\n${notice.text}${follow ? `\n\n${follow}` : ""}`;
}

/** The user-role message that carries a notice into a conversation; its metadata says it is not the user. */
export function noticeMessage(
  task: { id: string; title: string; projectId: string | null },
  notice: TaskNotice,
  text: string = noticeText(task, notice),
): UIMessage {
  const metadata: TaskNoticeMetadata = {
    kind: "task-notice",
    notice: notice.kind,
    taskId: task.id,
    taskTitle: task.title,
    projectId: task.projectId,
    from: notice.from,
    ...(notice.commentId ? { commentId: notice.commentId } : {}),
    ...(notice.questionId ? { questionId: notice.questionId } : {}),
    ...(notice.urgent ? { urgent: true } : {}),
  };
  return { id: generateId(), role: "user", parts: [{ type: "text", text }], metadata };
}

const dependencyLines = (deps: { title: string; output: string | null }[]) =>
  deps.flatMap((d) => [`### ${d.title}`, d.output ?? "(no output)"]);

const fileLines = (taskFiles: StoredFile[]) => taskFiles.map((f) => `- ${f.name} (${f.mimeType}): ${inputPath(f)}`);

/** The task's comments, oldest first, as briefs list them. */
const briefComments = (taskId: string) =>
  db
    .select({
      id: taskComments.id,
      body: taskComments.body,
      author: taskComments.authorKind,
      agent: agents.slug,
      kind: taskComments.kind,
      authorAgentId: taskComments.authorAgentId,
      createdAt: taskComments.createdAt,
      deliveredMessageId: taskComments.deliveredMessageId,
    })
    .from(taskComments)
    .leftJoin(agents, eq(agents.id, taskComments.authorAgentId))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt));

/**
 * Builds the brief an agent gets for a task: description, dependency outputs, files and comments.
 * `skipCommentId`: the comment a notice leading the brief already carries.
 */
async function taskBrief(taskId: string, skipCommentId: string | null = null): Promise<string> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new Error(`Task ${taskId} not found`);
  const deps = await db
    .select({ title: tasks.title, output: tasks.output })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(eq(taskDependencies.taskId, taskId));
  const comments = (await briefComments(taskId)).filter((c) => c.id !== skipCommentId);

  const lines = [`# Task: ${task.title}`, taskHeader(task), "", task.description || "(no description)"];
  if (deps.length) {
    lines.push("", "## Results of the tasks this one depends on");
    lines.push(...dependencyLines(deps));
  }
  const taskFiles = await listFiles({ taskId });
  if (taskFiles.length) {
    // Each handed-over file is a copy with its own id, so the delegator's path does not apply here.
    lines.push("", "## Files of the task (copied into your workspace)");
    lines.push(...fileLines(taskFiles));
  }
  if (comments.length) {
    lines.push("", "## Comments");
    for (const c of comments) lines.push(commentLine(c));
  }
  lines.push("", ...finishLines(task, await agentKind(task.assigneeAgentId)));
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

/** What a round's intro counts: the continuation after a limit stop, and the attempt of a retry. */
type RoundCounts = { continuation: number; continuations: number; attempt: number };

/**
 * Why the task is back, in the words its assignee reads first after the notice that brought it back (if
 * any): each reason says what to do with the earlier work above in the conversation.
 */
export function roundIntro(reason: RoundReason, n: RoundCounts): string {
  const earlier = "Your earlier work on it is above in this conversation";
  switch (reason) {
    case "given-back":
      return `The task was given back to you. ${earlier}: continue from there.`;
    case "instruction":
      return `A new instruction about the task came for you (the notice above). ${earlier}: apply the instruction to it at once; the latest instruction wins over the brief.`;
    case "answer":
      return `The answer to your question came (the notice above). ${earlier}: go on from where you stopped, using it.`;
    case "resumed":
      return `The task was resumed after it was put aside. ${earlier}: go on from where you stopped, without redoing what is done.`;
    case "continue":
      return `Your previous run stopped at its step or time limit; this is continuation ${n.continuation} of ${n.continuations}. ${earlier}: go on from where you stopped, without redoing what is done. On long work, report_progress at real milestones.`;
    case "retry":
      return `Your previous run on the task was cut by a passing failure; this is attempt ${n.attempt}. ${earlier}: go on from where it stopped, without redoing what is done.`;
    case "help":
      return `Your colleague's question came back to you. ${earlier}: answer it from there.`;
  }
}

/**
 * The message that gives a task back to the agent in the conversation it worked on it before: the brief
 * is already there, so only what changed since its latest run there. Comments a notice already carried
 * into a conversation (delivered_message_id) are not repeated. A compacted conversation may have lost the
 * details of the brief to the summary: it gets the full brief again.
 */
async function roundBrief(
  task: TaskRow,
  agentId: string,
  round: PreviousRound,
  opts: { reason: RoundReason; notice: TaskNotice | null; attempt: number },
): Promise<string> {
  const counts: RoundCounts = {
    continuation: task.continuations,
    continuations: opts.reason === "continue" ? (await getSettings()).agents.maxContinuations : 0,
    attempt: opts.attempt,
  };
  const intro = roundIntro(opts.reason, counts);
  const skip = opts.notice?.commentId ?? null;
  if (round.compacted) return `${intro}\n\n${await taskBrief(task.id, skip)}`;
  const { since } = round;
  const [described, deps, newFiles, comments] = await Promise.all([
    db
      .select({ id: taskEvents.id })
      .from(taskEvents)
      .where(
        and(
          eq(taskEvents.taskId, task.id),
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
      .where(and(eq(taskDependencies.taskId, task.id), gt(tasks.completedAt, since))),
    listFiles({ taskId: task.id }),
    briefComments(task.id),
  ]);
  // Its own comments the agent knows; the user's, other agents' and the platform's (a wakeup) it does not,
  // unless a notice already brought them into a conversation.
  const fresh = comments.filter(
    (c) => c.createdAt > since && c.authorAgentId !== agentId && !c.deliveredMessageId && c.id !== skip,
  );
  const lines = [`# Task: ${task.title}`, taskHeader(task), "", intro];
  if (described.length)
    lines.push("", "## Description (changed since your previous run)", task.description || "(no description)");
  if (deps.length) {
    lines.push("", "## Results of the tasks this one depends on, done since your previous run");
    lines.push(...dependencyLines(deps));
  }
  // Handed over since then (a replaced file has a new id, so a new path); the agent's own files it knows.
  const handed = newFiles.filter((f) => f.createdAt > since && f.agentId !== agentId);
  if (handed.length) {
    lines.push("", "## New files of the task (copied into your workspace)");
    lines.push(...fileLines(handed));
  }
  if (fresh.length) {
    lines.push("", "## New comments");
    for (const c of fresh) lines.push(commentLine(c));
  } else lines.push("", "No new comments since your previous run.");
  lines.push("", ...finishLines(task, await agentKind(agentId)));
  return lines.join("\n");
}

/** How a task's run starts: see startTaskRun. */
export type StartTaskRunOptions = {
  parentRunId?: string | null;
  force?: boolean;
  trigger?: RunTrigger;
  /** Why the task goes back to its assignee in the conversation it worked in (default: given back). */
  reason?: RoundReason;
  /** The notice that brings the task back: it leads the brief, and its comment is marked delivered. */
  notice?: TaskNotice;
  /** The run's attempt, for the automatic retry of a run a passing failure cut. */
  attempt?: number;
};

/**
 * Starts the run of a task's assignee. Refuses a task that is missing, unassigned, waiting for its
 * dependencies, already has an active run (TaskBusyError) or whose runs keep failing
 * (TaskCircuitOpenError). `force` is the user's start: it goes past the circuit breaker, and resets it
 * and the automatic fix rounds of the task's pull requests. A task the assignee worked on before
 * continues in that conversation (previousRound), so a send-back, a notice or a wakeup keeps its earlier
 * work; the brief then says why it is back (`reason`) and leads with the notice.
 */
export async function startTaskRun(taskId: string, opts: StartTaskRunOptions = {}): Promise<Run> {
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
  const trigger = opts.trigger ?? (opts.parentRunId ? ("delegation" as const) : ("task" as const));
  const start = {
    agentId: task.assigneeAgentId,
    trigger,
    taskId,
    projectId: task.projectId,
    parentRunId: opts.parentRunId ?? null,
    priority: queuePriority({ trigger, taskPriority: task.priority }),
    attempt: opts.attempt,
  };
  const notice = opts.notice ?? null;
  const brief = (text: string): UIMessage =>
    notice
      ? noticeMessage(task, notice, `${noticeText(task, notice)}\n\n${text}`)
      : { id: generateId(), role: "user", parts: [{ type: "text", text }] };
  const round = await previousRound(taskId, task.assigneeAgentId);
  if (round) {
    const message = brief(
      await roundBrief(task, task.assigneeAgentId, round, {
        reason: opts.reason ?? "given-back",
        notice,
        attempt: opts.attempt ?? 1,
      }),
    );
    try {
      return await carried(await startRun({ ...start, conversationId: round.conversationId, message }), message, notice);
    } catch (error) {
      // No run was made for the message: it must not stay for the active run's follow-up to answer.
      const refused = error instanceof ConversationBusyError || error instanceof TaskBusyError;
      if (refused) await db.delete(messages).where(eq(messages.id, message.id));
      // A run started there meanwhile: the task starts in a conversation of its own, as before.
      if (!(error instanceof ConversationBusyError)) throw error;
    }
  }
  const message = brief(await taskBrief(taskId, notice?.commentId ?? null));
  return carried(await startRun({ ...start, message, title: task.title }), message, notice);
}

/** The notice's comment reached the run in `message`: briefs no longer repeat it (delivered_message_id). */
async function carried(run: Run, message: UIMessage, notice: TaskNotice | null): Promise<Run> {
  if (notice?.commentId) {
    await db
      .update(taskComments)
      .set({ deliveredMessageId: message.id, deliveredRunId: run.id })
      .where(eq(taskComments.id, notice.commentId));
  }
  return run;
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

/** Task statuses after which nothing goes on in the task's conversation: its follow-ups wait or are moot. */
const NO_FOLLOW_UP: readonly TaskRow["status"][] = ["paused", "cancelled", "done"];

/**
 * After a run ends, answers user messages that arrived while it was working (they were queued
 * by ConversationBusyError). All of them are handled together in one follow-up run. Messages the run
 * took in between its steps (steeredInto, see agents/steering.ts) were answered by it.
 * A run on a task that was put aside, cancelled or is done gets none. A task notice that arrived during
 * the last step (the run settled the task meanwhile) reopens a task in review or blocked, so its answer
 * is reported again.
 */
export async function startFollowUpIfQueued(finished: Run): Promise<Run | null> {
  if (!finished.conversationId || !finished.startedAt || !finished.agentId) return null;
  const resume = await takeResumeRequest(finished.conversationId);
  const queued = await loadUnsteeredMessages(finished.conversationId, finished.startedAt);
  if (!queued.length && !resume) return null;
  if (finished.taskId) {
    const [task] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, finished.taskId));
    if (task && NO_FOLLOW_UP.includes(task.status)) return null;
    if ((task?.status === "review" || task?.status === "blocked") && queued.some((m) => isTaskNotice(m.message.metadata))) {
      await updateTask(finished.taskId, { status: "in_progress" }, "system");
      await db.update(tasks).set({ reportedAt: null }).where(eq(tasks.id, finished.taskId));
    }
  }
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
const MAX_HELD_REPLIES = 2;

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
  // for what the user wrote: a platform notice (a report, a task notice) is answered by the follow-up
  // after this reply.
  const arrived = finished.status === "succeeded" ? await loadUnsteeredMessages(conversationId, startedAt) : [];
  const wroteAgain = arrived.some((m) => !isPlatformNotice(m.message.metadata));
  if (wroteAgain && (await countHeldReply(conversationId)) <= MAX_HELD_REPLIES) {
    await markUndelivered(finished);
    return true;
  }
  await clearHeldReplies(conversationId);
  return false;
}
