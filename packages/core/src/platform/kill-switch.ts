import { db, runs } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { getTranslator } from "@abotica/i18n";
import { publish } from "../infra/events";
import { redis } from "../infra/redis";
import { cancelQueuedRuns } from "../runs/run-lifecycle";
import { getSettings, settingsLocale } from "../settings/settings";

const KILL_KEY = "abotica:kill-switch";

/** Kill switch lives in Redis so every runner can check it between steps cheaply. */
export async function isKillSwitchActive(): Promise<boolean> {
  return (await redis().get(KILL_KEY)) === "1";
}

/**
 * Turning it on asks every worker to abort the runs it is executing and cancels queued runs here, so
 * they never start (a run claimed meanwhile sees the switch and stops). `reason` is stored on the
 * stopped runs (default: the translated kill switch message). Returns how many runs it stopped: queued
 * plus running.
 */
export async function setKillSwitch(active: boolean, reason?: string): Promise<number> {
  if (!active) {
    await redis().del(KILL_KEY);
    await publish({ type: "kill-switch", active });
    return 0;
  }
  await redis().set(KILL_KEY, "1");
  const why = reason ?? getTranslator(settingsLocale(await getSettings()))("errors.run.stoppedByKillSwitch");
  const running = await db.select({ id: runs.id }).from(runs).where(eq(runs.status, "running"));
  await publish({ type: "kill-switch", active, reason: why });
  // After the abort went out: settling and reporting the cancelled runs' tasks takes a moment.
  const cancelled = await cancelQueuedRuns(why, "kill_switch");
  return cancelled.length + running.length;
}
