import {
  checkTaskWakeups,
  checkWakeupsWaitingOn,
  createRedis,
  handleTaskEvent,
  QUEUE,
  type TaskEventJob,
} from "@abotica/core";
import { Worker } from "bullmq";

/** One job at a time: a task's triggers, dependents and wakeups never race each other. */
export function startTaskEventsWorker() {
  return new Worker<TaskEventJob>(QUEUE.taskEvents, (job) => handleTaskJob(job.data), {
    connection: createRedis(),
    concurrency: 1,
  });
}

async function handleTaskJob({ taskId, event }: TaskEventJob): Promise<void> {
  if (event === "wakeups") return checkTaskWakeups(taskId);
  if (event !== "status") await handleTaskEvent(taskId, event);
  if (event !== "created") await checkWakeupsWaitingOn(taskId);
}
