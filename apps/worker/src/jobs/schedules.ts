import { createRedis, fireSchedule, QUEUE, type ScheduleJob } from "@abotica/core";
import { Worker } from "bullmq";
import { WORKER_CONCURRENCY } from "./worker-concurrency";

export function startSchedulesWorker() {
  return new Worker<ScheduleJob>(QUEUE.schedules, (job) => fireSchedule(job), {
    connection: createRedis(),
    concurrency: WORKER_CONCURRENCY.schedules,
  });
}
