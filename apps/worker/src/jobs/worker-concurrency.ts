/**
 * Jobs each queue worker of this process handles at the same time. Agent runs are not here: their
 * concurrency is a setting (system.runConcurrency), applied without a restart.
 */
export const WORKER_CONCURRENCY = {
  schedules: 2,
  /** One at a time: reports for the same delegator would only race for the same tasks. */
  delegationReports: 1,
  /** One at a time: a task's triggers, dependents and wakeups never race each other. */
  taskEvents: 1,
  embeddings: 2,
  maintenance: 1,
} as const;
