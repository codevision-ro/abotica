import {
  createRedis,
  type DelegationReportJob,
  onRunEnded,
  QUEUE,
  reportDelegatedTasks,
  reportSettledTask,
} from "@abotica/core";
import { conversations, db, runs } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { Worker } from "bullmq";
import { showTelegramTyping } from "../telegram/delivery";
import { WORKER_CONCURRENCY } from "./worker-concurrency";

/**
 * Reports delegated tasks back to their delegator as they settle: those of an ended run's conversation
 * ({runId}), or one task that settled with no run ending ({taskId}, reportTask). An ended run first goes
 * through onRunEnded, which may continue its task, ask about it or schedule its retry: that task is not
 * settled then, so it is not reported, while the report still gives the place the run held to a waiting
 * task and reports the siblings that settled.
 * A failed delivery throws, so the job is retried; the claim on the tasks is released first, so the
 * retry (or a later report) sends them.
 */
export function startDelegationReportsWorker() {
  return new Worker<DelegationReportJob>(
    QUEUE.delegationReports,
    async (job) => {
      if ("taskId" in job.data) {
        await showTypingIn(await reportSettledTask(job.data.taskId));
        return;
      }
      const [run] = await db.select().from(runs).where(eq(runs.id, job.data.runId));
      if (!run) return;
      await onRunEnded(run);
      await showTypingIn(await reportDelegatedTasks(run));
    },
    { connection: createRedis(), concurrency: WORKER_CONCURRENCY.delegationReports },
  );
}

/** Typing indicator in the Telegram conversation a delegation report continues; never fails the job. */
async function showTypingIn(conversationId: string | null) {
  if (!conversationId) return;
  try {
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (conversation?.channel === "telegram") showTelegramTyping(conversation);
  } catch (error) {
    console.error(`[delegation] showing typing in conversation ${conversationId} failed:`, error);
  }
}
