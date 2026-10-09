/**
 * Between dependent tasks: the files a done task produced go to the tasks waiting on it before they
 * start, and the delegators of tasks that cannot start (their dependency is blocked or cancelled) hear
 * about it.
 */
import type { TaskStatus } from "./tasks";

function notImplemented(name: string, ...args: unknown[]): Error {
  return new Error(`${name} is not implemented yet`, { cause: args });
}

/** Copies the files the done task's own runs produced to every task that depends on it. Returns how many. */
export async function handOffFiles(doneTaskId: string): Promise<number> {
  throw notImplemented("handOffFiles", doneTaskId);
}

/**
 * Tells the delegators of the tasks waiting on this one that they cannot start, now that it is blocked or
 * cancelled; once per dependent, dependency and status.
 */
export async function alertDependents(taskId: string, status: TaskStatus): Promise<void> {
  throw notImplemented("alertDependents", taskId, status);
}
