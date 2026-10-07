import { createRedis, QUEUE, type RunJob, startFollowUpIfQueued } from "@abotica/core";
import { executeRun } from "@abotica/core/agents/runner";
import { conversations, db, runs } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { Worker } from "bullmq";
import { deliverTelegramReply, showTelegramTyping } from "./telegram/delivery";

const controllers = new Map<string, AbortController>();

/** Aborts one run if this worker is executing it. */
export function abortRun(runId: string, reason: string) {
  controllers.get(runId)?.abort(new Error(reason));
}

/** Aborts every run executing in this worker; queued runs are cancelled by setKillSwitch. */
export function abortAllRuns(reason: string) {
  for (const c of controllers.values()) c.abort(new Error(reason));
}

export function startRunsWorker(concurrency: number) {
  return new Worker<RunJob>(
    QUEUE.runs,
    async (job) => {
      const controller = new AbortController();
      controllers.set(job.data.runId, controller);
      try {
        const result = await executeRun(job.data.runId, controller.signal);
        if (!result) return;
        const [run] = await db.select().from(runs).where(eq(runs.id, job.data.runId));
        if (!run?.conversationId) return;
        const [conversation] = await db.select().from(conversations).where(eq(conversations.id, run.conversationId));
        if (conversation?.channel === "telegram") {
          // A failed delivery must not leave the messages that arrived meanwhile unanswered.
          await deliverTelegramReply(conversation, run, result).catch((error: unknown) =>
            console.error(`[telegram] delivering the reply of run ${run.id} failed:`, error),
          );
        }
        // Messages sent while this run worked get answered now, all together.
        if (result.status !== "cancelled") {
          const followUp = await startFollowUpIfQueued(run);
          if (followUp && conversation?.channel === "telegram") showTelegramTyping(conversation);
        }
      } finally {
        controllers.delete(job.data.runId);
      }
    },
    { connection: createRedis(), concurrency, lockDuration: 60_000 },
  );
}
