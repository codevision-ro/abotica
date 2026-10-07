import path from "node:path";
import { env, setDefaultUploadsRoot, subscribe } from "@abotica/core";
import { prepareBuiltinMcpServers } from "@abotica/core/agents/mcp-runtime";
import { encryptLegacyMcpCredentials } from "@abotica/core/mcp-servers";
import { startPreviewServer } from "@abotica/core/preview-server";
import { closeSandbox, initSandbox } from "@abotica/core/sandbox-runtime";
import { defaultLocale, getTranslator, locales } from "@abotica/i18n";
import { startDelegationReportsWorker } from "./jobs/delegation-reports";
import { reapRuns, startMaintenanceWorker, registerMaintenanceSchedules } from "./jobs/maintenance";
import { startNotificationsWorker } from "./jobs/notifications";
import { describeSandbox, startSandboxWorker } from "./jobs/sandbox";
import { startSchedulesWorker } from "./jobs/schedules";
import { startTaskEventsWorker } from "./jobs/task-events";
import { abortAllRuns, abortRun, startRunsWorker } from "./runtime";
import { botTranslator, getBot } from "./telegram/bot";
import { registerHandlers } from "./telegram/handlers";

// Stored files live in the uploads folder the web app serves; without UPLOADS_DIR that is its .data/uploads.
setDefaultUploadsRoot(path.resolve(process.cwd(), "../web/.data/uploads"));

/** Set once the worker is up; a crash before that just exits. */
let shutdown: ((code: number) => Promise<void>) | null = null;

// A rejection nobody handled is logged: it must not take down the runs in flight with it.
process.on("unhandledRejection", (reason) => console.error("[worker] unhandled rejection:", reason));
process.on("uncaughtException", (error) => {
  console.error("[worker] uncaught exception:", error);
  if (!shutdown) process.exit(1);
  // Closing waits for the runs in progress; the process is in an unknown state, so not for long.
  setTimeout(() => process.exit(1), 30_000).unref();
  void shutdown(1);
});

async function main() {
  // Runs a crashed worker left behind; ones a live worker still holds are left to it. A failure here
  // must not keep the worker from starting: the periodic reaper tries again.
  await reapRuns().catch((error: unknown) => console.error("[runs] recovering runs at start failed:", error));
  const concurrency = env().RUN_CONCURRENCY;

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

  const workers = [
    startRunsWorker(concurrency),
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
  const unsubscribe = subscribe((event) => {
    if (event.type === "kill-switch" && event.active) {
      if (event.reason) abortAllRuns(event.reason);
      else void botTranslator().then((t) => abortAllRuns(t("errors.run.stoppedByKillSwitch")));
    }
    if (event.type === "run.cancel") abortRun(event.runId, event.reason);
  });

  const bot = getBot();
  if (bot) {
    registerHandlers(bot);
    // Command names stay the same in every language; only the descriptions are translated.
    // The default list is English; Telegram clients set to another supported language get theirs.
    for (const locale of locales) {
      const t = getTranslator(locale);
      const commands = (["status", "tasks", "new", "stop", "resume"] as const).map((command) => ({
        command,
        description: t(`telegram.commands.${command}`),
      }));
      await bot.api.setMyCommands(commands, locale === defaultLocale ? {} : { language_code: locale });
    }
    void bot.start({ onStart: (me) => console.log(`[telegram] @${me.username} started`) });
  } else {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN is missing, the bot will not start");
  }

  console.log(`[worker] started (concurrency ${concurrency})`);

  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    console.log("[worker] shutting down...");
    try {
      unsubscribe();
      await bot?.stop();
      await Promise.all([...workers.map((w) => w.close()), previews.close()]);
      await closeSandbox().catch((error: unknown) => console.error("[sandbox] shutdown:", error));
    } catch (error) {
      console.error("[worker] shutdown failed:", error);
      code ||= 1;
    }
    process.exit(code);
  };
  shutdown = stop;
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
