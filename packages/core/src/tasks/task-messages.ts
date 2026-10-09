/**
 * The task's message stream (task_comments by kind): instructions to the assignee, questions up the
 * chain of command and their answers, progress, and the questions the platform asks. Each is stored on
 * the task, then delivered (runs/deliver.ts).
 */
import type { Delivered, Wake } from "../runs/deliver";
import type { Actor, TaskComment } from "./tasks";

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

function notImplemented(name: string, ...args: unknown[]): Error {
  return new Error(`${name} is not implemented yet`, { cause: args });
}

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
  throw notImplemented("postInstruction", taskId, body, by, opts);
}

/**
 * Asks a question about the task: stored open and addressed to whoever gave the task (or the user),
 * delivered there at once (`wake` "now" unless a test holds it), escalated while it stays unanswered.
 */
export async function askQuestion(
  taskId: string,
  input: QuestionInput,
  by: Actor,
  opts: { runId?: string | null; wake?: Wake } = {},
): Promise<PostedMessage> {
  throw notImplemented("askQuestion", taskId, input, by, opts);
}

/**
 * Answers an open question: the asker gets it at once, mid-run or woken in its conversation, and the
 * earlier addressees an FYI. With `forward`, the same question goes one level up instead (`text` is what
 * the forwarder adds), and `comment` is that question.
 */
export async function answerQuestion(
  questionId: string,
  text: string,
  by: Actor,
  opts: { forward?: boolean; runId?: string | null } = {},
): Promise<PostedMessage> {
  throw notImplemented("answerQuestion", questionId, text, by, opts);
}

/**
 * Moves a question that waited too long one level up the chain of command, or to the user once it
 * waited past userEscalationMinutes or the next level is the user. Called by the follow-up sweeper.
 */
export async function escalateQuestion(
  questionId: string,
  now: Date = new Date(),
): Promise<"escalated" | "to-user" | "none"> {
  throw notImplemented("escalateQuestion", questionId, now);
}

/** Stores progress on the task and tells whoever gave it, waking them only when it needs attention. */
export async function reportProgress(
  taskId: string,
  input: ProgressInput,
  by: Actor,
  opts: { runId?: string | null } = {},
): Promise<PostedMessage> {
  throw notImplemented("reportProgress", taskId, input, by, opts);
}

/**
 * A question the platform asks whoever gave the task: it needs more time after its continuations, or
 * it stopped in a loop. Answered like any question.
 */
export async function systemQuestion(
  taskId: string,
  input: { system: "needs-more-time" | "loop"; text: string; options: string[] },
): Promise<PostedMessage> {
  throw notImplemented("systemQuestion", taskId, input);
}
