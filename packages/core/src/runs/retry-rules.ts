/**
 * When a run that failed for a passing reason is tried again on its own: a provider's rate or usage
 * limit, providers that did not answer, a worker restart, a lost or overdue job. Pure, so the backoff is
 * testable; run-lifecycle.ts applies it and the follow-up sweeper starts the retries that are due.
 */
import type { AgentSettings } from "../settings/settings-schema";
import type { RunFailureKind } from "./run-failures";

const MINUTE_MS = 60_000;

/**
 * Minutes before each retry, by failure kind: the n-th retry waits the n-th value, and every retry past
 * the list waits the last one. Kinds missing here (the kill switch, a cancel, a budget, the setup) fail
 * the same way the next time, or were someone's decision: they are never retried.
 */
const BACKOFF_MINUTES: Partial<Record<RunFailureKind, number[]>> = {
  rate_limited: [1, 2, 4, 8, 16, 30],
  providers_unavailable: [1, 2, 4, 8, 16, 30],
  usage_limit: [15, 30, 60],
  worker_restarted: [0.5, 2, 5],
  unqueued: [0.5, 2, 5],
  overdue: [0.5, 2, 5],
};

/** Whether a run that failed with this kind is retried at all (retryPlan also counts the attempts). */
export const isRetryable = (kind: RunFailureKind | null): boolean => kind !== null && kind in BACKOFF_MINUTES;

/** How far a wait is spread around its value, so retries after one outage do not all start together. */
const JITTER = 0.1;

/**
 * When to retry a run that failed with `kind` on its `attempt` (1 for a first run), or null when it is
 * not retried: the kind is not passing, or the run was already the last of the `transientRetries` retries.
 * `random` (0 to 1) places the wait within ±10% of its value.
 */
export function retryPlan(
  kind: RunFailureKind | null,
  attempt: number,
  settings: Pick<AgentSettings, "transientRetries">,
  now: Date = new Date(),
  random: () => number = Math.random,
): { at: Date } | null {
  const backoff = kind ? BACKOFF_MINUTES[kind] : undefined;
  if (!backoff || attempt > settings.transientRetries) return null;
  const minutes = backoff[Math.min(Math.max(attempt, 1), backoff.length) - 1]!;
  const spread = 1 - JITTER + 2 * JITTER * random();
  return { at: new Date(now.getTime() + Math.round(minutes * MINUTE_MS * spread)) };
}
