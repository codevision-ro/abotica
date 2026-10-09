/**
 * Puts a platform notice (a user-role message with task-notice metadata, tasks/task-notices.ts) into the
 * conversation it belongs in. A run active there takes it in between its steps (steering); otherwise the
 * notice wakes the agent or only waits there, by its `wake` policy. Checks the provider policy for content
 * going up from a restricted project, and the wake-rate guard. mayRead and deliverToUser move here from
 * tasks/delegation.ts with the report delivery.
 */
import type { UIMessage } from "ai";
import type { Superior } from "../tasks/chain";
import type { TaskNoticeKind } from "../tasks/task-notices";
import type { Actor } from "../tasks/tasks";
import type { RoundReason, RunTrigger } from "./runs";

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

/** A notice about a task: its kind, its text, the comment it carries, and who it is from (as people read it). */
export type TaskNotice = { kind: TaskNoticeKind; text: string; commentId?: string | null; from: string };

function notImplemented(name: string, ...args: unknown[]): Error {
  return new Error(`${name} is not implemented yet`, { cause: args });
}

/**
 * Delivers a notice to the task's assignee, by the task's state: stored for a task that is done,
 * cancelled or not started; into the active run's conversation; into the paused round without a wake;
 * otherwise it wakes the assignee in the conversation it worked in (`reason` says why), within the
 * wake guards. `by` decides the guards: the user's wake goes past the circuit breaker.
 */
export async function deliverToTask(
  taskId: string,
  notice: TaskNotice,
  opts: { wake: Wake; by: Actor; reason: RoundReason },
): Promise<{ result: Delivered; runId?: string; error?: string }> {
  throw notImplemented("deliverToTask", taskId, notice, opts);
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
  throw notImplemented("deliverToConversation", input);
}

/** Delivers a notice about the task to whoever gave it (tasks/chain.ts), agent or user. */
export async function deliverToSuperior(
  taskId: string,
  notice: TaskNotice,
  opts: { wake: Wake },
): Promise<{ result: Delivered; superior: Superior }> {
  throw notImplemented("deliverToSuperior", taskId, notice, opts);
}
