/**
 * Keeps the company moving without anyone watching: one sweep a minute (maintenance kind "followups")
 * escalates unanswered questions, sends deadline reminders and alerts, follows up quiet tasks, starts
 * due retries, reminds the user of what waits for them and resumes work put aside for settled tasks.
 * Each step claims its rows, so the sweep is idempotent and safe on several workers. onRunEnded decides
 * what happens after a task's run stops short of settling it.
 */
import type { Run } from "../runs/runs";

function notImplemented(name: string, ...args: unknown[]): Error {
  return new Error(`${name} is not implemented yet`, { cause: args });
}

/** One sweep at `now` (injected by the tests to move time forward). */
export async function sweepFollowUps(now: Date = new Date()): Promise<void> {
  throw notImplemented("sweepFollowUps", now);
}

/**
 * After a task's run ended: a run stopped at its step or time limit goes on by itself up to
 * maxContinuations, then asks its delegator; a loop asks at once; a passing failure was scheduled for a
 * retry. Called before the run's delegation report.
 */
export async function onRunEnded(run: Run): Promise<"continued" | "asked" | "retry-scheduled" | "none"> {
  throw notImplemented("onRunEnded", run);
}
