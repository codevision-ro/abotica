import { createRedis, QUEUE, RunAbort, type RunFailureKind, type RunJob, startFollowUpIfQueued } from "@abotica/core";
import { executeRun } from "@abotica/core/agents/runner";
import { conversations, db, runs } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { Worker } from "bullmq";
import { acknowledgeSteered, deliverTelegramReply, showTelegramTyping } from "./telegram/delivery";

const controllers = new Map<string, AbortController>();
/** Called once no run is executing here any more (see whenRunsIdle). */
const idleListeners = new Set<() => void>();

/** Runs executing in this worker. */
export function activeRunCount() {
  return controllers.size;
}

/** Resolves once no run is executing in this worker; a run ends after its Telegram reply and follow-up. */
function whenRunsIdle(): Promise<void> {
  if (!controllers.size) return Promise.resolve();
  return new Promise((resolve) => idleListeners.add(resolve));
}

/**
 * Shutdown: the runs executing here get `drainMs` to finish on their own; the ones still going are
 * then aborted with `reason()` and take the cancel path, which saves their partial answer. Resolves
 * once every run has ended, with how many were aborted.
 */
export async function drainRuns(drainMs: number, reason: () => Promise<string>): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([whenRunsIdle(), new Promise((resolve) => (timer = setTimeout(resolve, drainMs)))]);
  clearTimeout(timer);
  const aborted = controllers.size;
  if (!aborted) return 0;
  abortAllRuns(await reason(), "worker_restarted");
  await whenRunsIdle();
  return aborted;
}

/** Aborts one run if this worker is executing it; it ends cancelled with `reason` and `kind`. */
export function abortRun(runId: string, reason: string, kind: RunFailureKind) {
  controllers.get(runId)?.abort(new RunAbort(reason, kind));
}

/** Aborts every run executing in this worker; queued runs are cancelled by setKillSwitch. */
export function abortAllRuns(reason: string, kind: RunFailureKind) {
  for (const c of controllers.values()) c.abort(new RunAbort(reason, kind));
}

export function startRunsWorker(concurrency: number) {
  return new Worker<RunJob>(
    QUEUE.runs,
    async (job) => {
      const controller = new AbortController();
      controllers.set(job.data.runId, controller);
      try {
        const result = await executeRun(job.data.runId, controller.signal, { onSteered: acknowledgeSteered });
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
        if (!controllers.size) {
          for (const resolve of idleListeners) resolve();
          idleListeners.clear();
        }
      }
    },
    { connection: createRedis(), concurrency, lockDuration: 60_000 },
  );
}
