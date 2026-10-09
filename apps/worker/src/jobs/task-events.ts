import {
  checkTaskWakeups,
  checkWakeupsWaitingOn,
  createRedis,
  handleTaskEvent,
  onTaskSettled,
  QUEUE,
  startRetry,
  type TaskEventJob,
} from "@abotica/core";
import { Worker } from "bullmq";
import { WORKER_CONCURRENCY } from "./worker-concurrency";

/** One job at a time (WORKER_CONCURRENCY): a task's triggers, dependents and wakeups never race each other. */
export function startTaskEventsWorker() {
  return new Worker<TaskEventJob>(QUEUE.taskEvents, (job) => handleTaskJob(job.data), {
    connection: createRedis(),
    concurrency: WORKER_CONCURRENCY.taskEvents,
  });
}

export async function handleTaskJob(job: TaskEventJob): Promise<void> {
  // An automatic retry of a run a passing failure cut is due (it may have no task).
  if (job.event === "retry") return void (await startRetry(job.runId));
  const { taskId, event } = job;
  if (event === "wakeups") return checkTaskWakeups(taskId);
  if (event !== "status") await handleTaskEvent(taskId, event);
  if (event === "created") return;
  await checkWakeupsWaitingOn(taskId);
  // Done or another status: a task that settled lets work put aside for it go on, and tells the tasks
  // waiting on it when they cannot start.
  await onTaskSettled(taskId);
}
