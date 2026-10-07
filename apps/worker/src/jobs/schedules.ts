import { createRedis, fireSchedule, QUEUE, type ScheduleJob } from "@abotica/core";
import { Worker } from "bullmq";

export function startSchedulesWorker() {
  return new Worker<ScheduleJob>(QUEUE.schedules, (job) => fireSchedule(job), {
    connection: createRedis(),
    concurrency: 2,
  });
}
