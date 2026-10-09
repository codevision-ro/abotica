/**
 * The queue priority of a run, from what started it and the priority of the work: a person waiting in a
 * chat comes first, the platform's own work last. BullMQ serves 1 before 2, and equal priorities first
 * in, first out, which orders work of the same rank by age. Pure: runs.ts and updateTask apply it.
 */
import type { tasks } from "@abotica/db";
import type { RunTrigger } from "../runs/runs";

type TaskPriority = (typeof tasks.$inferSelect)["priority"];

/** 1 (served first) to 6. */
export type QueuePriority = 1 | 2 | 3 | 4 | 5 | 6;

const TASK_RANK: Record<TaskPriority, QueuePriority> = { urgent: 2, high: 3, medium: 4, low: 5 };

/**
 * `taskPriority` is the run's own task's; `noticePriority` the priority of the task a notice that starts
 * the run is about, so a continuation woken by urgent work runs as urgent. The higher of the two wins;
 * work with neither runs as medium.
 */
export function queuePriority(input: {
  trigger: RunTrigger;
  taskPriority?: TaskPriority | null;
  noticePriority?: TaskPriority | null;
}): QueuePriority {
  if (input.trigger === "chat" || input.trigger === "telegram") return 1;
  if (input.trigger === "system") return 6;
  const ranks = [input.taskPriority, input.noticePriority].flatMap((p) => (p ? [TASK_RANK[p]] : []));
  return ranks.length ? (Math.min(...ranks) as QueuePriority) : TASK_RANK.medium;
}
