import { createRedis, type DelegationReportJob, QUEUE, reportDelegatedTasks } from "@abotica/core";
import { conversations, db, runs } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { Worker } from "bullmq";
import { showTelegramTyping } from "../telegram/delivery";
import { WORKER_CONCURRENCY } from "./worker-concurrency";

/**
 * Reports ended runs' delegated tasks back to their delegator. A failed delivery throws, so the job is
 * retried; the claim on the tasks is released first, so the retry (or a later report) sends them.
 */
export function startDelegationReportsWorker() {
  return new Worker<DelegationReportJob>(
    QUEUE.delegationReports,
    async (job) => {
      // A report of one task without a run ending (reportTask) is not sent from here yet.
      if (!("runId" in job.data)) return;
      const [run] = await db.select().from(runs).where(eq(runs.id, job.data.runId));
      if (!run) return;
      const report = await reportDelegatedTasks(run);
      if (report) await showTypingIn(report.conversationId);
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
