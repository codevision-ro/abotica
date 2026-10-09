/**
 * The task's message stream (task_comments by kind): instructions to the assignee, questions up the
 * chain of command and their answers, progress, and the questions the platform asks. Each is stored on
 * the task, then delivered (runs/deliver.ts). What agents write going up (questions, progress) reaches
 * the level above as untrusted data; instructions and answers going down only lose marker look-alikes.
 */
import { agents, db, projects, runs, taskComments, taskEvents, tasks, type QuestionOptions } from "@abotica/db";
import { and, count, desc, eq, gt, sql } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { neutralizeMarkers, wrapUntrusted } from "../agents/untrusted";
import { newMarkerId } from "../agents/untrusted-id";
import { type Delivered, deliverToLevel, deliverToTask, type Wake } from "../runs/deliver";
import { getSettings } from "../settings/settings";
import { chainAgentIds, chainOfCommand, type Superior, superiorOf } from "./chain";
import { mayAnswer, mayInstruct, type TeamActor } from "./team-rules";
import { type Actor, addTaskComment, type Task, type TaskComment } from "./tasks";

/** A question, with the choices the asker sees and the one it would pick. */
export type QuestionInput = {
  question: string;
  options?: string[];
  recommendation?: string;
  /** Who it is for: whoever gave the task (default), or the user (the super agent only). */
  to?: "delegator" | "user";
};

export type ProgressInput = { summary: string; percentDone?: number; eta?: string; needsAttention?: boolean };

/** A comment stored on the task and what became of its delivery. */
export type PostedMessage = { comment: TaskComment; delivered: Delivered; runId?: string; error?: string };

/** Open questions one task may have at once. */
export const MAX_OPEN_QUESTIONS = 3;
/** Questions one task may ask in an hour. */
export const MAX_QUESTIONS_PER_HOUR = 6;
/** Progress reports that need attention (and wake) one task may send in an hour. */
export const MAX_ATTENTION_PER_HOUR = 3;

const HOUR_MS = 3_600_000;
const USER: Superior = { kind: "user", conversationId: null };

type QuestionRow = TaskComment & { options: QuestionOptions | null };

async function loadTask(taskId: string): Promise<Task> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new UserError("tasks.errors.notFound");
  return task;
}

/** The actor as the team rules see it: the user, or an agent with its kind; null for the platform. */
async function teamActor(by: Actor): Promise<TeamActor | null> {
  if (by === "user") return "user";
  if (by === "system") return null;
  const [agent] = await db.select({ id: agents.id, kind: agents.kind }).from(agents).where(eq(agents.id, by.agentId));
  return agent ?? null;
}

/** Who a notice is from, as people read it. */
async function fromName(by: Actor): Promise<string> {
  if (by === "user") return "the user";
  if (by === "system") return "Abotica";
  const [agent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, by.agentId));
  return agent?.name ?? "an agent";
}

const actorLabel = (by: Actor) => (typeof by === "string" ? by : `agent:${by.agentId}`);

async function logEvent(taskId: string, type: string, by: Actor, data: Record<string, unknown>) {
  await db.insert(taskEvents).values({ taskId, type, actor: actorLabel(by), data });
}

/** The agent whose run delegated the task, and its project's manager: those who decide on it. */
async function authorityOf(task: Task) {
  const [[delegator], [project]] = await Promise.all([
    task.delegatedByRunId
      ? db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, task.delegatedByRunId))
      : Promise.resolve([]),
    task.projectId
      ? db.select({ managerAgentId: projects.managerAgentId }).from(projects).where(eq(projects.id, task.projectId))
      : Promise.resolve([]),
  ]);
  return { delegatorAgentId: delegator?.agentId ?? null, projectManagerId: project?.managerAgentId ?? null };
}

/**
 * The user stepped in: agents may wake the task again (agents.maxAutoRounds counts from here), and its
 * automatic continuations start over.
 */
async function userStepsIn(taskId: string): Promise<void> {
  await db.update(tasks).set({ agentRounds: 0, continuations: 0 }).where(eq(tasks.id, taskId));
}

const putAside = (task: Task) => task.status === "paused" || task.status === "cancelled";

/**
 * A comment on the task. From someone who may instruct (team-rules.ts mayInstruct) it is an instruction,
 * delivered to the assignee at once (or at its next run with `deliver: "next-run"`); from anyone else it
 * is a note, only stored. `runId`: the run writing it, when an agent does.
 */
export async function postInstruction(
  taskId: string,
  body: string,
  by: Actor,
  opts: { deliver?: "now" | "next-run"; runId?: string | null } = {},
): Promise<PostedMessage> {
  const task = await loadTask(taskId);
  const actor = await teamActor(by);
  const instructs = actor !== null && mayInstruct(actor, task, await authorityOf(task));
  const comment = await addTaskComment(taskId, body, by, {
    kind: instructs ? "instruction" : "note",
    authorRunId: opts.runId ?? null,
  });
  if (by === "user") await userStepsIn(taskId);
  if (!instructs || opts.deliver === "next-run") return { comment, delivered: "stored" };
  const sent = await deliverToTask(
    taskId,
    { kind: "instruction", text: neutralizeMarkers(body), commentId: comment.id, from: await fromName(by) },
    { wake: "now", by, reason: "instruction" },
  );
  if (sent.result !== "stored" && sent.result !== "refused") {
    await logEvent(taskId, "instruction-delivered", by, {
      commentId: comment.id,
      delivered: sent.result,
      runId: sent.runId,
    });
  }
  return { comment, delivered: sent.result, runId: sent.runId, error: sent.error };
}

/** The question with its choices, as the level it reaches reads it: an agent's words stay data. */
function questionText(question: QuestionRow, opts: { note?: { from: string; text: string }; waited?: number }): string {
  const asked = [
    question.body,
    question.options?.options.length ? `Options: ${question.options.options.join(" | ")}` : null,
    question.options?.recommendation ? `Recommendation: ${question.options.recommendation}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const fromAgent = question.authorKind === "agent";
  const id = newMarkerId();
  return [
    fromAgent ? wrapUntrusted(asked, { source: "delegated-task", id }) : neutralizeMarkers(asked),
    opts.waited !== undefined
      ? `It has waited ${opts.waited} minute${opts.waited === 1 ? "" : "s"} without an answer, so it comes to you.`
      : null,
    opts.note
      ? `${neutralizeMarkers(opts.note.from)} passed it up, adding:\n${wrapUntrusted(opts.note.text, { source: "delegated-task", id })}`
      : null,
    `Answer it with answer and questionId ${question.id}, now: the work waits for it. When it is not yours to decide, forward it (answer with forward: true) to the level above you; the super agent forwards what only the user can decide.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The question as the user reads it in a notification. */
const questionForUser = (question: QuestionRow) =>
  [
    question.body,
    question.options?.options.length ? question.options.options.map((o, i) => `${i + 1}. ${o}`).join("\n") : null,
    question.options?.recommendation ? `→ ${question.options.recommendation}` : null,
  ]
    .filter(Boolean)
    .join("\n");

/** Delivers the question to one level of the chain: the agent there, or the user (notified). */
function sendQuestion(
  task: Task,
  question: QuestionRow,
  level: Superior,
  opts: { wake: Wake; from: string; note?: { from: string; text: string }; waited?: number },
) {
  return deliverToLevel(
    level,
    task,
    {
      kind: "question",
      text: questionText(question, opts),
      commentId: question.id,
      questionId: question.id,
      from: opts.from,
    },
    { wake: opts.wake, userText: questionForUser(question), parentRunId: question.authorRunId },
  );
}

const escalateAt = (minutes: number, now = new Date()) => new Date(now.getTime() + minutes * 60_000);

/** Where a question goes: the level's agent with its escalation time, or the user. */
async function addressFor(level: Superior, now = new Date()) {
  if (level.kind === "user") return { addresseeAgentId: null, addressedToUser: true, escalateAt: null };
  const { questionEscalationMinutes } = (await getSettings()).agents;
  return {
    addresseeAgentId: level.agent.id,
    addressedToUser: false,
    escalateAt: escalateAt(questionEscalationMinutes, now),
  };
}

async function openQuestions(taskId: string) {
  return db
    .select({ id: taskComments.id, body: taskComments.body, options: taskComments.options })
    .from(taskComments)
    .where(
      and(eq(taskComments.taskId, taskId), eq(taskComments.kind, "question"), eq(taskComments.questionStatus, "open")),
    );
}

/**
 * Asks a question about the task: stored open and addressed to whoever gave the task (or the user),
 * delivered there at once (`wake` "now" unless a test holds it), escalated while it stays unanswered.
 * Refused on a task put aside, for a question already open, past MAX_OPEN_QUESTIONS open or
 * MAX_QUESTIONS_PER_HOUR asked.
 */
export async function askQuestion(
  taskId: string,
  input: QuestionInput,
  by: Actor,
  opts: { runId?: string | null; wake?: Wake } = {},
): Promise<PostedMessage> {
  const task = await loadTask(taskId);
  if (putAside(task)) throw new UserError("flow.messages.errors.putAside");
  const body = input.question.trim();
  const open = await openQuestions(taskId);
  if (open.some((q) => q.body.trim().toLowerCase() === body.toLowerCase())) {
    throw new UserError("flow.messages.errors.duplicate");
  }
  if (open.length >= MAX_OPEN_QUESTIONS)
    throw new UserError("flow.messages.errors.tooManyOpen", { max: MAX_OPEN_QUESTIONS });
  const [asked] = await db
    .select({ count: count() })
    .from(taskComments)
    .where(
      and(
        eq(taskComments.taskId, taskId),
        eq(taskComments.kind, "question"),
        sql`${taskComments.authorKind} <> 'system'`,
        gt(taskComments.createdAt, new Date(Date.now() - HOUR_MS)),
      ),
    );
  if ((asked?.count ?? 0) >= MAX_QUESTIONS_PER_HOUR) {
    throw new UserError("flow.messages.errors.askRate", { max: MAX_QUESTIONS_PER_HOUR });
  }
  const level = input.to === "user" ? USER : await superiorOf(taskId);
  const options: QuestionOptions = {
    options: input.options ?? [],
    ...(input.recommendation ? { recommendation: input.recommendation } : {}),
  };
  const question = (await addTaskComment(taskId, body, by, {
    kind: "question",
    questionStatus: "open",
    options,
    authorRunId: opts.runId ?? null,
    ...(await addressFor(level)),
  })) as QuestionRow;
  await logEvent(taskId, "question", by, { questionId: question.id });
  const sent = await sendQuestion(task, question, level, { wake: opts.wake ?? "now", from: await fromName(by) });
  return { comment: question, delivered: sent.result, runId: sent.runId };
}

async function loadQuestion(questionId: string): Promise<QuestionRow> {
  const [question] = await db.select().from(taskComments).where(eq(taskComments.id, questionId));
  if (!question || question.kind !== "question") throw new UserError("flow.messages.errors.questionNotFound");
  if (question.questionStatus !== "open") throw new UserError("flow.messages.errors.questionClosed");
  return question as QuestionRow;
}

/**
 * Where the question stands in the chain: the level of its addressee; once it reached the user, the
 * level it went to the user from (the levels below it saw the question).
 */
function addresseeIndex(question: QuestionRow, chain: readonly Superior[]): number {
  if (question.addressedToUser) return question.escalationLevel;
  const at = chain.findIndex((level) => level.kind === "agent" && level.agent.id === question.addresseeAgentId);
  return at >= 0 ? at : Math.min(question.escalationLevel, chain.length - 1);
}

/** Moves an open question to `level`, unless someone else moved or closed it first. */
async function readdress(
  question: QuestionRow,
  level: Superior,
  index: number,
  now = new Date(),
): Promise<QuestionRow | null> {
  const [moved] = await db
    .update(taskComments)
    .set({ ...(await addressFor(level, now)), escalationLevel: index })
    .where(and(eq(taskComments.id, question.id), eq(taskComments.questionStatus, "open")))
    .returning();
  return (moved as QuestionRow | undefined) ?? null;
}

/**
 * Tells the agents the question reached before (`upTo`, its addressee included) and that did not answer
 * it what became of it; they read it at their next step or run, nobody is woken.
 */
async function tellEarlier(task: Task, chain: readonly Superior[], upTo: number, skipAgentId: string | null, text: string) {
  for (const level of chain.slice(0, upTo + 1)) {
    if (level.kind !== "agent" || level.agent.id === skipAgentId) continue;
    await deliverToLevel(level, task, { kind: "answer", text, from: "Abotica", fyi: true }, { wake: "never" });
  }
}

/**
 * Answers an open question: the asker gets it at once, mid-run or woken in its conversation, and the
 * earlier addressees an FYI. With `forward`, the same question goes one level up instead (`text` is what
 * the forwarder adds), and `comment` is that question. Answering never sends the task back and wakes
 * the asker without counting towards agents.maxAutoRounds; the user's answer resets that count.
 */
export async function answerQuestion(
  questionId: string,
  text: string,
  by: Actor,
  opts: { forward?: boolean; runId?: string | null } = {},
): Promise<PostedMessage> {
  const question = await loadQuestion(questionId);
  const [task, chain, actor] = await Promise.all([
    loadTask(question.taskId),
    chainOfCommand(question.taskId),
    teamActor(by),
  ]);
  if (!actor || !mayAnswer(actor, question, chainAgentIds(chain))) {
    throw new UserError("flow.messages.errors.mayNotAnswer");
  }
  if (by === "user") await userStepsIn(task.id);
  const from = await fromName(by);
  const actorId = actor === "user" ? null : actor.id;
  const at = addresseeIndex(question, chain);
  if (opts.forward) return forwardQuestion(task, question, chain, { at, actorId, by, from, text });

  const [closed] = await db
    .update(taskComments)
    .set({ questionStatus: "answered", escalateAt: null })
    .where(and(eq(taskComments.id, questionId), eq(taskComments.questionStatus, "open")))
    .returning({ id: taskComments.id });
  if (!closed) throw new UserError("flow.messages.errors.questionClosed");
  const answer = await addTaskComment(task.id, text, by, {
    kind: "answer",
    replyToId: questionId,
    authorRunId: opts.runId ?? null,
  });
  // More time was granted: the automatic continuations start over.
  if (question.options?.system === "needs-more-time") {
    await db.update(tasks).set({ continuations: 0 }).where(eq(tasks.id, task.id));
  }
  await logEvent(task.id, "answered", by, { questionId, answerId: answer.id });
  const sent = await deliverToTask(
    task.id,
    {
      kind: "answer",
      text: `Your question: ${neutralizeMarkers(question.body)}\nAnswer: ${neutralizeMarkers(text)}`,
      commentId: answer.id,
      questionId,
      from,
    },
    { wake: "now", by, reason: "answer" },
  );
  await tellEarlier(
    task,
    chain,
    question.addressedToUser ? at - 1 : at,
    actorId,
    `FYI: the question "${neutralizeMarkers(question.body)}" (${questionId}) was answered by ${neutralizeMarkers(from)}: ${neutralizeMarkers(text)}. Nothing to do.`,
  );
  return { comment: answer, delivered: sent.result, runId: sent.runId, error: sent.error };
}

/** The same question, one level above whoever forwards it (or its addressee); the user is the top. */
async function forwardQuestion(
  task: Task,
  question: QuestionRow,
  chain: readonly Superior[],
  f: { at: number; actorId: string | null; by: Actor; from: string; text: string },
): Promise<PostedMessage> {
  if (question.addressedToUser) throw new UserError("flow.messages.errors.atUser");
  const own = f.actorId ? chain.findIndex((l) => l.kind === "agent" && l.agent.id === f.actorId) : -1;
  const index = Math.max(own, f.at) + 1;
  const next = chain[index] ?? USER;
  const moved = await readdress(question, next, index);
  if (!moved) throw new UserError("flow.messages.errors.questionClosed");
  await logEvent(task.id, "escalated", f.by, {
    questionId: question.id,
    forwarded: true,
    to: next.kind === "agent" ? next.agent.id : "user",
  });
  const sent = await sendQuestion(task, moved, next, { wake: "now", from: f.from, note: { from: f.from, text: f.text } });
  return { comment: moved, delivered: sent.result, runId: sent.runId };
}

/**
 * Moves a question that waited too long one level up the chain of command, or to the user once it
 * waited past userEscalationMinutes or the next level is the user. Called by the follow-up sweeper; a
 * question someone else moved or closed meanwhile is left alone.
 */
export async function escalateQuestion(
  questionId: string,
  now: Date = new Date(),
): Promise<"escalated" | "to-user" | "none"> {
  const [question] = (await db.select().from(taskComments).where(eq(taskComments.id, questionId))) as QuestionRow[];
  if (!question || question.questionStatus !== "open" || !question.escalateAt || question.escalateAt > now) return "none";
  const [task, chain, { userEscalationMinutes }] = await Promise.all([
    loadTask(question.taskId),
    chainOfCommand(question.taskId),
    getSettings().then((s) => s.agents),
  ]);
  const at = addresseeIndex(question, chain);
  const waitedMs = now.getTime() - question.createdAt.getTime();
  const waited = Math.round(waitedMs / 60_000);
  const above = chain[at + 1];
  const next = !above || waitedMs >= userEscalationMinutes * 60_000 ? USER : above;
  // Claimed on the time it was due at: a second sweep finds it moved.
  const [moved] = (await db
    .update(taskComments)
    .set({ ...(await addressFor(next, now)), escalationLevel: at + 1 })
    .where(
      and(
        eq(taskComments.id, questionId),
        eq(taskComments.questionStatus, "open"),
        eq(taskComments.escalateAt, question.escalateAt),
      ),
    )
    .returning()) as QuestionRow[];
  if (!moved) return "none";
  await logEvent(task.id, "escalated", "system", {
    questionId,
    to: next.kind === "agent" ? next.agent.id : "user",
    waitedMinutes: waited,
  });
  await sendQuestion(task, moved, next, { wake: "now", from: "Abotica", waited });
  const previous = chain[at];
  if (previous?.kind === "agent") {
    const to = next.kind === "agent" ? next.agent.name : "the user";
    await deliverToLevel(
      previous,
      task,
      {
        kind: "question",
        text: `FYI: the question "${neutralizeMarkers(question.body)}" (${questionId}) waited ${waited} minutes without your answer, so it went up to ${to}, who answers it now.`,
        questionId,
        from: "Abotica",
      },
      { wake: "never" },
    );
  }
  return next.kind === "user" ? "to-user" : "escalated";
}

/** Progress as it is stored on the task. */
const progressBody = (input: ProgressInput) =>
  [
    input.summary.trim(),
    input.percentDone !== undefined ? `(${input.percentDone}% done)` : null,
    input.eta ? `ETA: ${input.eta}` : null,
  ]
    .filter(Boolean)
    .join(" ");

/**
 * Stores progress on the task and tells whoever gave it, waking them only when it needs attention.
 * Refused within agents.progressMinutes of the last one (needsAttention excepted, MAX_ATTENTION_PER_HOUR
 * of those) and on a task put aside.
 */
export async function reportProgress(
  taskId: string,
  input: ProgressInput,
  by: Actor,
  opts: { runId?: string | null } = {},
): Promise<PostedMessage> {
  const task = await loadTask(taskId);
  if (putAside(task)) throw new UserError("flow.messages.errors.putAside");
  const now = new Date();
  const attention = input.needsAttention === true;
  if (attention) {
    const [sent] = await db
      .select({ count: count() })
      .from(taskEvents)
      .where(
        and(
          eq(taskEvents.taskId, taskId),
          eq(taskEvents.type, "progress"),
          sql`(${taskEvents.data} ->> 'needsAttention')::boolean`,
          gt(taskEvents.createdAt, new Date(now.getTime() - HOUR_MS)),
        ),
      );
    if ((sent?.count ?? 0) >= MAX_ATTENTION_PER_HOUR) {
      throw new UserError("flow.messages.errors.attentionRate", { max: MAX_ATTENTION_PER_HOUR });
    }
  } else {
    const { progressMinutes } = (await getSettings()).agents;
    const since = task.lastProgressAt ? (now.getTime() - task.lastProgressAt.getTime()) / 60_000 : Infinity;
    if (since < progressMinutes) {
      throw new UserError("flow.messages.errors.progressRate", { minutes: Math.floor(since), every: progressMinutes });
    }
  }
  const body = progressBody(input);
  const comment = await addTaskComment(taskId, body, by, { kind: "progress", authorRunId: opts.runId ?? null });
  await db.update(tasks).set({ lastProgressAt: now }).where(eq(tasks.id, taskId));
  await logEvent(taskId, "progress", by, {
    commentId: comment.id,
    needsAttention: attention,
    percentDone: input.percentDone,
  });
  const text = [
    wrapUntrusted(body, { source: "delegated-task", id: newMarkerId() }),
    attention
      ? "It needs your attention now: it changes the outcome or a date."
      : "Nothing to do unless it changes what you expect; pass up only what changes the outcome or a date.",
  ].join("\n\n");
  const level = await superiorOf(taskId);
  const sent = await deliverToLevel(
    level,
    task,
    { kind: "progress", text, commentId: comment.id, from: await fromName(by), urgent: attention },
    { wake: attention ? "now" : "never", userText: body, parentRunId: opts.runId ?? null },
  );
  return { comment, delivered: sent.result, runId: sent.runId };
}

/**
 * A question the platform asks whoever gave the task: it needs more time after its continuations, or
 * it stopped in a loop. Answered like any question. One of each kind is open at a time: asking again
 * returns the open one.
 */
export async function systemQuestion(
  taskId: string,
  input: { system: "needs-more-time" | "loop"; text: string; options: string[] },
): Promise<PostedMessage> {
  const task = await loadTask(taskId);
  const [open] = await db
    .select()
    .from(taskComments)
    .where(
      and(
        eq(taskComments.taskId, taskId),
        eq(taskComments.kind, "question"),
        eq(taskComments.questionStatus, "open"),
        sql`${taskComments.options} ->> 'system' = ${input.system}`,
      ),
    )
    .orderBy(desc(taskComments.createdAt))
    .limit(1);
  if (open) return { comment: open, delivered: "stored" };
  const level = await superiorOf(taskId);
  const question = (await addTaskComment(taskId, input.text, "system", {
    kind: "question",
    questionStatus: "open",
    options: { options: input.options, system: input.system },
    ...(await addressFor(level)),
  })) as QuestionRow;
  await logEvent(taskId, "question", "system", { questionId: question.id, system: input.system });
  const sent = await sendQuestion(task, question, level, { wake: "now", from: "Abotica" });
  return { comment: question, delivered: sent.result, runId: sent.runId };
}
