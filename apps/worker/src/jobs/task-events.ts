import {
  checkTaskWakeups,
  checkWakeupsWaitingOn,
  createRedis,
  handleTaskEvent,
  QUEUE,
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

async function handleTaskJob({ taskId, event }: TaskEventJob): Promise<void> {
  if (event === "wakeups") return checkTaskWakeups(taskId);
  if (event !== "status") await handleTaskEvent(taskId, event);
  if (event !== "created") await checkWakeupsWaitingOn(taskId);
}
