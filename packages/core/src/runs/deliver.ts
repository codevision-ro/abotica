/**
 * Puts a platform notice (a user-role message with task-notice metadata, tasks/task-notices.ts) into the
 * conversation it belongs in. A run active there takes it in between its steps (steering); otherwise the
 * notice wakes the agent or only waits there, by its `wake` policy. Checks the provider policy for content
 * going up from a restricted project (mayRead), and the guards against agents waking each other in a
 * loop: the task's agent rounds (agents.maxAutoRounds) and the notice wakes of a conversation per hour.
 * Delegation reports (tasks/delegation.ts) are delivered the same way.
 */
import { agents, conversations, db, messages, runs, taskComments, taskEvents, tasks } from "@abotica/db";
import { generateId, type UIMessage } from "ai";
import { and, desc, eq, inArray, isNotNull } from "@abotica/db/orm";
import { getTranslator, isUserError } from "@abotica/i18n";
import { fullModelChain } from "../agents/model-chain";
import { env } from "../infra/env";
import { publish } from "../infra/events";
import { notify } from "../infra/queues";
import { redis } from "../infra/redis";
import { combinePolicies, deniesEveryModel, projectsProviderPolicy, runProviderPolicy } from "../models/provider-policy";
import { getSettings, settingsLocale } from "../settings/settings";
import { superiorOf, type Superior } from "../tasks/chain";
import { type DelegationReportMetadata, isDelegationReport, SETTLED_TASK_STATUSES } from "../tasks/delegation-report";
import { startDelegatedTask } from "../tasks/delegation-slots";
import { queuePriority } from "../tasks/priority";
import { isTaskNotice, type TaskNoticeKind } from "../tasks/task-notices";
import { type Actor, isActiveTaskRunConflict, type Task, TaskCircuitOpenError } from "../tasks/tasks";
import {
  appendUserMessage,
  ConversationBusyError,
  noticeMessage,
  type RoundReason,
  type RunTrigger,
  startContinuation,
} from "./runs";

/**
 * now: wake the agent if no run takes the notice in; if-open: only while its task is still open; never:
 * the notice waits in the conversation for the agent's next run.
 */
export type Wake = "now" | "if-open" | "never";

/**
 * What became of a notice: taken in by the active run (steered), queued for that run's follow-up, a new
 * run woken, its task queued for a delegation place (slot), only stored, given to the user instead
 * (withheld), or refused by a guard (the error says why).
 */
export type Delivered = "steered" | "follow-up" | "woke" | "slot" | "stored" | "withheld" | "refused";

/**
 * A notice about a task: its kind, its text, the comment it carries, and who it is from (as people read
 * it). The text goes to the model as it is: whoever builds it wraps what agents wrote as untrusted data.
 * `questionId`: the question it asks or answers; `urgent`: it needs attention now.
 */
export type TaskNotice = {
  kind: TaskNoticeKind;
  text: string;
  commentId?: string | null;
  from: string;
  questionId?: string;
  urgent?: boolean;
  /** It only informs (an FYI to an earlier addressee): no line asking to act on it. */
  fyi?: boolean;
};

type Agent = typeof agents.$inferSelect;

/** A run that still works: it takes a notice in between its steps, or after its approvals. */
const ACTIVE_RUN = ["queued", "running", "waiting_approval"] as const;

/** Notice wakes one conversation takes per hour; past it, notices wait there for its next run. */
export const NOTICE_WAKES_PER_HOUR = 30;

const translator = async () => getTranslator(settingsLocale(await getSettings()));
const taskUrl = (taskId: string) => `${env().APP_URL}/tasks/${taskId}`;

/**
 * Whether the agent may be given content from these projects: its next run (in the conversation, when it
 * continues one) works under that provider policy narrowed by the projects', and some model of its chain
 * must be left. `projectId` is the project that run works in: a manager's or a specialist's, or the one
 * the super agent works in on a task of its own there (work_in_project); null outside projects.
 */
export async function mayRead(
  agent: Agent,
  projectId: string | null,
  conversationId: string | null,
  contentProjectIds: string[],
): Promise<boolean> {
  const [[conversation], settings] = await Promise.all([
    conversationId ? db.select().from(conversations).where(eq(conversations.id, conversationId)) : Promise.resolve([]),
    getSettings(),
  ]);
  const policy = combinePolicies(
    await runProviderPolicy(projectId, conversationId),
    await projectsProviderPolicy(contentProjectIds),
  );
  return !deniesEveryModel(policy, fullModelChain({ agent, settings, conversation: conversation ?? null }));
}

/**
 * A report the agent may not read goes to the user instead: saved in the conversation as a notice its
 * model never gets (see isWithheldReport), shown in the web chat and sent to the conversation's Telegram
 * chat. The tasks stay as they settled; the user decides on them.
 */
async function deliverToUser(agent: Agent, conversationId: string, report: DelegationReportMetadata): Promise<void> {
  const t = await translator();
  const text = [
    t("notifications.delegationWithheld.title", { count: report.tasks.length, agent: agent.name }),
    ...report.tasks.map((task) =>
      t("notifications.delegationWithheld.task", {
        title: task.title,
        url: taskUrl(task.id),
        status: t(`common.taskStatus.${task.status}`),
      }),
    ),
  ].join("\n");
  await db.insert(messages).values({
    id: generateId(),
    conversationId,
    role: "system",
    parts: [{ type: "text", text }],
    metadata: { ...report, withheld: true },
  });
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
  await publish({ type: "conversation.updated", conversationId });
  await notify({ kind: "conversation-notice", conversationId, text });
}

/**
 * Content the agent may not read never enters its conversation: a report is kept there for the user
 * only (deliverToUser), a task notice goes to the user as a notification.
 */
async function withhold(agent: Agent, conversationId: string, message: UIMessage): Promise<void> {
  const metadata = message.metadata;
  if (isDelegationReport(metadata)) return deliverToUser(agent, conversationId, metadata);
  if (!isTaskNotice(metadata)) return;
  const t = await translator();
  await notify({
    kind: "text",
    projectId: metadata.projectId,
    text: t("flow.notices.withheld", { agent: agent.name, task: metadata.taskTitle, url: taskUrl(metadata.taskId) }),
  });
}

async function activeRunIn(conversationId: string) {
  const [run] = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.conversationId, conversationId), inArray(runs.status, [...ACTIVE_RUN])))
    .limit(1);
  return run ?? null;
}

/** What a notice put next to an active run becomes: taken in between its steps, or after its approvals. */
const intoActive = (run: { id: string; status: string }) => ({
  result: (run.status === "waiting_approval" ? "follow-up" : "steered") as Delivered,
  runId: run.id,
});

/** A task that is still worked on: not settled and not put aside (null: no task, so always open). */
async function taskOpen(taskId: string | null): Promise<boolean> {
  if (!taskId) return true;
  const [task] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
  return Boolean(task) && !SETTLED_TASK_STATUSES.includes(task!.status) && task!.status !== "paused";
}

const noticeWakesKey = (conversationId: string) => `abotica:conv:${conversationId}:notice-wakes`;

/** Counts a notice wake in the conversation; false once it had NOTICE_WAKES_PER_HOUR this hour. */
async function takeNoticeWake(conversationId: string): Promise<boolean> {
  const key = noticeWakesKey(conversationId);
  const wakes = await redis().incr(key);
  if (wakes === 1) await redis().expire(key, 3600);
  return wakes <= NOTICE_WAKES_PER_HOUR;
}

/** The user hears once an hour that a conversation's notices wait instead of waking its agent. */
async function tellNoticeWakesLimit(conversationId: string, agent: Agent): Promise<void> {
  const first = await redis().set(`${noticeWakesKey(conversationId)}:told`, "1", "EX", 3600, "NX");
  if (!first) return;
  const t = await translator();
  await notify({
    kind: "text",
    text: t("flow.notices.noticeWakesLimit", { agent: agent.name, count: NOTICE_WAKES_PER_HOUR }),
  });
}

async function saveInto(conversationId: string, message: UIMessage): Promise<void> {
  await appendUserMessage(conversationId, message);
  await publish({ type: "conversation.updated", conversationId });
}

/**
 * Puts `message` into a conversation of `agentId`, and starts the run `run` describes when `wake` says
 * so and none is active there. `contentProjectIds`: the projects the message's content comes from, which
 * the agent's models must be allowed to read.
 */
export async function deliverToConversation(input: {
  conversationId: string;
  agentId: string;
  message: UIMessage;
  wake: Wake;
  run: {
    taskId: string | null;
    projectId: string | null;
    trigger: RunTrigger;
    parentRunId: string | null;
    priority?: number;
  };
  contentProjectIds: string[];
}): Promise<{ result: Delivered; runId?: string }> {
  const { conversationId, message } = input;
  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
  if (!agent) throw new Error(`Agent ${input.agentId} not found`);
  if (!(await mayRead(agent, input.run.projectId, conversationId, input.contentProjectIds))) {
    await withhold(agent, conversationId, message);
    return { result: "withheld" };
  }
  const active = await activeRunIn(conversationId);
  const wakes = input.wake === "now" || (input.wake === "if-open" && (await taskOpen(input.run.taskId)));
  if (active || !wakes) {
    await saveInto(conversationId, message);
    return active ? intoActive(active) : { result: "stored" };
  }
  if (isTaskNotice(message.metadata) && !(await takeNoticeWake(conversationId))) {
    await saveInto(conversationId, message);
    await tellNoticeWakesLimit(conversationId, agent);
    return { result: "stored" };
  }
  try {
    const run = await startContinuation({
      agentId: agent.id,
      trigger: input.run.trigger,
      conversationId,
      taskId: input.run.taskId,
      projectId: input.run.projectId,
      parentRunId: input.run.parentRunId,
      priority: input.run.priority,
      message,
    });
    return { result: "woke", runId: run.id };
  } catch (error) {
    if (!(error instanceof ConversationBusyError)) throw error;
    // The message is saved: the run that started there meanwhile takes it in, or answers it after.
    const now = await activeRunIn(conversationId);
    return now ? intoActive(now) : { result: "follow-up" };
  }
}

/** The comment reached a conversation in `messageId` (and a run, when one took it): briefs leave it out. */
async function markDelivered(commentId: string | null | undefined, messageId: string, runId: string | null) {
  if (!commentId) return;
  await db
    .update(taskComments)
    .set({ deliveredMessageId: messageId, deliveredRunId: runId })
    .where(eq(taskComments.id, commentId));
}

/** The task's latest run in a conversation: the round a notice waits in while nothing runs. */
async function lastRound(taskId: string) {
  const [run] = await db
    .select({ id: runs.id, conversationId: runs.conversationId })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), isNotNull(runs.conversationId)))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return run?.conversationId ? { id: run.id, conversationId: run.conversationId } : null;
}

/** Into the conversation of the task's active run, which takes it in between its steps or after its approvals. */
async function intoTaskRun(
  task: Task,
  run: { id: string; status: string; conversationId: string | null },
  notice: TaskNotice,
): Promise<{ result: Delivered; runId?: string }> {
  if (!run.conversationId) return { result: "stored" };
  const message = noticeMessage(task, notice);
  await saveInto(run.conversationId, message);
  await markDelivered(notice.commentId, message.id, run.id);
  return intoActive(run);
}

async function activeTaskRun(taskId: string) {
  const [run] = await db
    .select({ id: runs.id, status: runs.status, conversationId: runs.conversationId })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), inArray(runs.status, [...ACTIVE_RUN])))
    .limit(1);
  return run ?? null;
}

/**
 * An agent's instruction would wake the task once more than agents.maxAutoRounds times since the user
 * last stepped in: it stays stored, the task records the stop and the user is told.
 */
async function roundsLimit(task: Task, by: Actor, max: number): Promise<string> {
  await db.insert(taskEvents).values({
    taskId: task.id,
    type: "rounds-limit",
    actor: typeof by === "string" ? by : `agent:${by.agentId}`,
    data: { rounds: task.agentRounds, max },
  });
  const t = await translator();
  await notify({
    kind: "text",
    projectId: task.projectId,
    text: t("flow.notices.roundsLimit", { task: task.title, count: max, url: taskUrl(task.id) }),
  });
  return `Agents have woken this task ${max} times since the user last stepped in, so it is not woken again: your comment is stored and the user decides. Do not repeat it; end your turn or go on with other work.`;
}

/**
 * Delivers a notice to the task's assignee, by the task's state: stored for a task that is done,
 * cancelled or not started; into the active run's conversation; into the paused round without a wake;
 * otherwise it wakes the assignee in the conversation it worked in (`reason` says why), within the
 * wake guards. `by` decides the guards: the user's wake goes past the circuit breaker, an agent's
 * instruction counts towards agents.maxAutoRounds. A task woken from review or blocked is reported again
 * when it settles.
 */
export async function deliverToTask(
  taskId: string,
  notice: TaskNotice,
  opts: { wake: Wake; by: Actor; reason: RoundReason },
): Promise<{ result: Delivered; runId?: string; error?: string }> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status === "done" || task.status === "cancelled") return { result: "stored" };
  const active = await activeTaskRun(taskId);
  if (active) return intoTaskRun(task, active, notice);
  const round = await lastRound(taskId);
  // Not started yet (waiting for its dependencies or a place, or never run): its brief lists the comment.
  if (!round || task.status === "backlog" || !task.assigneeAgentId) return { result: "stored" };
  const wakes = opts.wake === "now" || (opts.wake === "if-open" && task.status === "in_progress");
  if (task.status === "paused" || !wakes) {
    // A notice without a comment waits in the round; a comment comes with the next brief.
    if (task.status === "paused" || !notice.commentId) {
      const message = noticeMessage(task, notice);
      await saveInto(round.conversationId, message);
      await markDelivered(notice.commentId, message.id, null);
    }
    return { result: "stored" };
  }

  const agentWake = opts.by !== "user" && opts.by !== "system" && opts.reason === "instruction";
  const { maxAutoRounds } = (await getSettings()).agents;
  if (agentWake && task.agentRounds >= maxAutoRounds) {
    return { result: "refused", error: await roundsLimit(task, opts.by, maxAutoRounds) };
  }
  const settled = task.status === "review" || task.status === "blocked";
  if (settled) await db.update(tasks).set({ reportedAt: null }).where(eq(tasks.id, taskId));
  try {
    const run = await startDelegatedTask(taskId, {
      parentRunId: task.delegatedByRunId,
      reason: opts.reason,
      notice,
      force: opts.by === "user",
    });
    if (agentWake)
      await db
        .update(tasks)
        .set({ agentRounds: task.agentRounds + 1 })
        .where(eq(tasks.id, taskId));
    return run ? { result: "woke", runId: run.id } : { result: "slot" };
  } catch (error) {
    // Not woken: it stays as it settled, already reported.
    if (settled) await db.update(tasks).set({ reportedAt: task.reportedAt }).where(eq(tasks.id, taskId));
    if (isActiveTaskRunConflict(error)) {
      const now = await activeTaskRun(taskId);
      if (now) return intoTaskRun(task, now, notice);
    }
    if (error instanceof TaskCircuitOpenError) return { result: "refused", error: error.message };
    // It cannot start now (its dependencies, its assignee): the comment waits for its next brief.
    if (isUserError(error)) return { result: "stored", error: error.message };
    throw error;
  }
}

/**
 * Delivers a notice about `task` to one level of its chain of command. An agent gets it in the
 * conversation that level works in (tasks/chain.ts); the user gets `userText` (default the notice's text)
 * as a notification, unless the notice does not wake. `parentRunId`: the run the notice comes from.
 */
export async function deliverToLevel(
  level: Superior,
  task: Task,
  notice: TaskNotice,
  opts: { wake: Wake; userText?: string; parentRunId?: string | null },
): Promise<{ result: Delivered; runId?: string }> {
  if (level.kind === "user") {
    if (opts.wake === "never") return { result: "stored" };
    // A question goes out with its options to answer from the notification (Telegram buttons, a reply).
    if (notice.kind === "question" && notice.questionId) {
      await notify({ kind: "question", questionId: notice.questionId });
      return { result: "stored" };
    }
    const t = await translator();
    await notify({
      kind: "text",
      projectId: task.projectId,
      text: t("flow.notices.toUser", {
        kind: notice.kind,
        from: notice.from,
        task: task.title,
        text: opts.userText ?? notice.text,
        url: taskUrl(task.id),
      }),
    });
    return { result: "stored" };
  }
  const [own] = level.taskId
    ? await db.select({ priority: tasks.priority }).from(tasks).where(eq(tasks.id, level.taskId))
    : [];
  const message = noticeMessage(task, notice);
  const delivered = await deliverToConversation({
    conversationId: level.conversationId,
    agentId: level.agent.id,
    message,
    wake: opts.wake,
    run: {
      taskId: level.taskId,
      projectId: level.projectId,
      trigger: level.trigger,
      parentRunId: opts.parentRunId ?? (await lastRound(task.id))?.id ?? null,
      priority: queuePriority({ trigger: level.trigger, taskPriority: own?.priority, noticePriority: task.priority }),
    },
    contentProjectIds: task.projectId ? [task.projectId] : [],
  });
  if (delivered.result !== "withheld") await markDelivered(notice.commentId, message.id, delivered.runId ?? null);
  return delivered;
}

/** Delivers a notice about the task to whoever gave it (tasks/chain.ts), agent or user. */
export async function deliverToSuperior(
  taskId: string,
  notice: TaskNotice,
  opts: { wake: Wake; userText?: string },
): Promise<{ result: Delivered; superior: Superior }> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new Error(`Task ${taskId} not found`);
  const superior = await superiorOf(taskId);
  const { result } = await deliverToLevel(superior, task, notice, opts);
  return { result, superior };
}
