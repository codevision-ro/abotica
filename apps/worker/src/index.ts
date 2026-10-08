import path from "node:path";
import { env, getSettings, importLegacyEnv, setDefaultUploadsRoot, subscribe } from "@abotica/core";
import { prepareBuiltinMcpServers } from "@abotica/core/agents/mcp-runtime";
import { encryptLegacyMcpCredentials } from "@abotica/core/mcp-servers";
import { startPreviewServer } from "@abotica/core/preview-server";
import { closeSandbox, initSandbox } from "@abotica/core/sandbox-runtime";
import { defaultLocale, getTranslator } from "@abotica/i18n";
import type { Worker } from "bullmq";
import { startDelegationReportsWorker } from "./jobs/delegation-reports";
import { reapRuns, startMaintenanceWorker, registerMaintenanceSchedules } from "./jobs/maintenance";
import { startNotificationsWorker } from "./jobs/notifications";
import { describeSandbox, startSandboxWorker } from "./jobs/sandbox";
import { startSchedulesWorker } from "./jobs/schedules";
import { startTaskEventsWorker } from "./jobs/task-events";
import { abortAllRuns, abortRun, activeRunCount, drainRuns, startRunsWorker } from "./runtime";
import { botTranslator } from "./telegram/bot";
import { closeBot, reloadBot } from "./telegram/bot-lifecycle";

// Stored files live in the uploads folder the web app serves; without UPLOADS_DIR that is its .data/uploads.
setDefaultUploadsRoot(path.resolve(process.cwd(), "../web/.data/uploads"));

/** Set once the worker is up; a crash before that just exits. */
let shutdown: ((code: number, drainMs: number) => Promise<void>) | null = null;

// A rejection nobody handled is logged: it must not take down the runs in flight with it.
process.on("unhandledRejection", (reason) => console.error("[worker] unhandled rejection:", reason));
process.on("uncaughtException", (error) => {
  console.error("[worker] uncaught exception:", error);
  if (!shutdown) process.exit(1);
  // The process is in an unknown state: the runs in progress are stopped at once, saving what they
  // did so far, and closing gets 30 seconds at most.
  setTimeout(() => process.exit(1), 30_000).unref();
  void shutdown(1, 0);
});

async function main() {
  // Runs a crashed worker left behind; ones a live worker still holds are left to it. A failure here
  // must not keep the worker from starting: the periodic reaper tries again.
  await reapRuns().catch((error: unknown) => console.error("[runs] recovering runs at start failed:", error));

  // Telegram, the Ollama address, the embedding provider and the run concurrency used to be set in .env;
  // what is still only there moves to Settings, once, before anything reads them.
  try {
    const imported = await importLegacyEnv();
    if (imported.length) console.log(`[settings] imported ${imported.join(", ")} from .env into Settings`);
  } catch (error) {
    console.error("[settings] importing the .env values failed:", error);
  }
  const concurrency = (await getSettings()).runConcurrency;

  // Before the runs worker starts, so the first runs already get their workspace tools.
  try {
    console.log(`[sandbox] ${describeSandbox(await initSandbox())}`);
  } catch (error) {
    console.error("[sandbox] initialization failed, running without a sandbox:", error);
  }

  // Servers saved before credentials were encrypted at rest; plain values keep working if this fails.
  await encryptLegacyMcpCredentials().catch((error: unknown) =>
    console.error("[mcp] encrypting stored credentials failed:", error),
  );

  // In the background: listing the tools of a stdio server starts it once, which takes a while.
  void prepareBuiltinMcpServers().catch((error: unknown) =>
    console.error("[mcp] preparing the bundled servers failed:", error),
  );

  const previews = await startPreviewServer();
  console.log(`[previews] ${env().PREVIEW_URL} served on port ${env().PREVIEW_PORT}`);

  const runsWorker = startRunsWorker(concurrency);
  const workers = [
    runsWorker,
    startSchedulesWorker(),
    startMaintenanceWorker(),
    startNotificationsWorker(),
    startTaskEventsWorker(),
    startDelegationReportsWorker(),
    startSandboxWorker(),
  ];
  for (const w of workers) w.on("failed", (job, err) => console.error(`[${w.name}] job ${job?.id} failed:`, err.message));
  await registerMaintenanceSchedules();

  // The kill switch stops everything running here; a cancel stops one run, wherever it is executing.
  // A Telegram token saved or removed in Settings restarts or stops the bot.
  const unsubscribe = subscribe((event) => {
    if (event.type === "kill-switch" && event.active) {
      if (event.reason) abortAllRuns(event.reason, "kill_switch");
      else void botTranslator().then((t) => abortAllRuns(t("errors.run.stoppedByKillSwitch"), "kill_switch"));
    }
    if (event.type === "run.cancel") abortRun(event.runId, event.reason, event.kind);
    if (event.type === "telegram.config-changed") void reloadBot();
    if (event.type === "settings.updated") void applyRunConcurrency(runsWorker);
  });

  await reloadBot();

  console.log(`[worker] started (concurrency ${concurrency})`);

  let stopping = false;
  const stop = async (code: number, drainMs: number) => {
    if (stopping) return;
    stopping = true;
    console.log("[worker] shutting down...");
    try {
      // No new work: polling stops (bot.api keeps working, so stopped runs still deliver their
      // Telegram reply) and the workers fetch no more jobs; each close() resolves once its jobs end.
      const botStopped = closeBot().catch((error: unknown) => console.error("[telegram] stopping:", error));
      const closed = workers.map((w) => w.close());
      const running = activeRunCount();
      if (running) console.log(`[worker] waiting up to ${drainMs / 1000}s for ${running} run(s) to finish`);
      // Still subscribed meanwhile, so a cancel or the kill switch keeps working while runs drain.
      const aborted = await drainRuns(drainMs, shutdownReason);
      if (aborted) console.log(`[worker] stopped ${aborted} run(s), their partial answers saved`);
      unsubscribe();
      await Promise.all([...closed, previews.close(), botStopped]);
      await closeSandbox().catch((error: unknown) => console.error("[sandbox] shutdown:", error));
    } catch (error) {
      console.error("[worker] shutdown failed:", error);
      code ||= 1;
    }
    process.exit(code);
  };
  shutdown = stop;
  process.on("SIGINT", () => void stop(0, env().WORKER_SHUTDOWN_DRAIN_MS));
  process.on("SIGTERM", () => void stop(0, env().WORKER_SHUTDOWN_DRAIN_MS));
}

/**
 * Applies the run concurrency saved in Settings without a restart. BullMQ reads it before fetching each
 * job: a lower value lets the runs in progress finish, a higher one starts more once a place is free.
 */
async function applyRunConcurrency(worker: Worker) {
  try {
    const { runConcurrency } = await getSettings();
    if (worker.concurrency === runConcurrency) return;
    worker.concurrency = runConcurrency;
    console.log(`[worker] run concurrency is now ${runConcurrency}`);
  } catch (error) {
    console.error("[worker] applying the run concurrency failed:", error);
  }
}

/** Why runs still going at shutdown were stopped, in the language from Settings (English if that cannot be read). */
async function shutdownReason(): Promise<string> {
  const t = await botTranslator().catch(() => getTranslator(defaultLocale));
  return t("errors.run.workerRestarting");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
