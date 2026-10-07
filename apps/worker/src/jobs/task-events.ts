import { createRedis, handleTaskEvent, QUEUE, type TaskEventJob } from "@abotica/core";
import { Worker } from "bullmq";

export function startTaskEventsWorker() {
  return new Worker<TaskEventJob>(QUEUE.taskEvents, (job) => handleTaskEvent(job.data.taskId, job.data.event), {
    connection: createRedis(),
    concurrency: 1,
  });
}
