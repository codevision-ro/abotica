/**
 * Work in flight, under control: a task paused at its next step and resumed in the same conversation,
 * cancelled with its subtree, or redirected (new instructions, another assignee, priority or deadline).
 * The user does it from the web, a manager or the super agent with task_control (team-rules.ts
 * mayControlTask). The runner's soft stop ends a running run cleanly between steps.
 */
import type { Run } from "../runs/runs";
import type { Actor, Task, TaskPriority } from "./tasks";

function notImplemented(name: string, ...args: unknown[]): Error {
  return new Error(`${name} is not implemented yet`, { cause: args });
}

/**
 * Puts the task aside: status paused, its queued run cancelled and its running one stopped at the next
 * step. `pausedForTaskId`: the (urgent) task it makes room for; it resumes on its own once that settles.
 * Refused for a task waiting for an approval and for a settled one.
 */
export async function pauseTask(
  taskId: string,
  opts: { by: Actor; reason: string; pausedForTaskId?: string | null },
): Promise<Task> {
  throw notImplemented("pauseTask", taskId, opts);
}

/**
 * Goes on with a paused task (or a blocked or quiet one) in the conversation it worked in, `note` leading
 * its brief; it waits in the backlog while its dependencies are pending. `extraContinuations` gives it its
 * automatic continuations back. Returns the run it started, if any.
 */
export async function resumeTask(
  taskId: string,
  opts: { by: Actor; note?: string; extraContinuations?: number },
): Promise<{ task: Task; run: Run | null }> {
  throw notImplemented("resumeTask", taskId, opts);
}

/**
 * Stops the task for good, with its subtree unless `cascade` is false: its subtasks and the tasks its
 * runs delegated. Each one is cancelled and marked reported before its runs stop, so nothing reports
 * as blocked; the root is reported to its delegator when someone else cancelled it. Returns the ids of
 * the tasks cancelled.
 */
export async function cancelTask(
  taskId: string,
  opts: { by: Actor; reason: string; cascade?: boolean },
): Promise<{ cancelled: string[] }> {
  throw notImplemented("cancelTask", taskId, opts);
}

/**
 * Changes the course of a task underway: `instructions` reach its assignee as an instruction,
 * `reassignTo` (an agent id) hands it to another agent, `priority` and `deadline` change it in place.
 */
export async function redirectTask(
  taskId: string,
  opts: {
    by: Actor;
    instructions?: string;
    reassignTo?: string;
    priority?: TaskPriority;
    deadline?: Date | null;
  },
): Promise<Task> {
  throw notImplemented("redirectTask", taskId, opts);
}

/** Resumes the tasks put aside for this one, now that it settled. Returns how many it resumed. */
export async function resumePausedFor(settledTaskId: string): Promise<number> {
  throw notImplemented("resumePausedFor", settledTaskId);
}

/** Asks the run to stop at its next step (the runner checks between steps), with the reason it records. */
export async function requestSoftStop(runId: string, reason: string): Promise<void> {
  throw notImplemented("requestSoftStop", runId, reason);
}

/** The soft stop requested for the run, taken once: its reason, or null when none is pending. */
export async function takeSoftStop(runId: string): Promise<string | null> {
  throw notImplemented("takeSoftStop", runId);
}
