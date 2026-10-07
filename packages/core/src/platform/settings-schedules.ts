import { type MaintenanceJob, maintenanceQueue } from "../infra/queues";
import { type AppSettings, getSettings } from "./settings";

type SettingsSchedule = {
  id: string;
  repeat: { pattern: string; tz: string };
  template: { name: string; data: MaintenanceJob };
};

/** The maintenance jobs whose time follows the settings: the digest hour and the timezone. */
export function settingsSchedules({
  timezone,
  digestHour,
}: Pick<AppSettings, "timezone" | "digestHour">): SettingsSchedule[] {
  return [
    {
      id: "journals",
      repeat: { pattern: "30 23 * * *", tz: timezone },
      template: { name: "journals", data: { kind: "journals" } },
    },
    {
      id: "digest-daily",
      repeat: { pattern: `0 ${digestHour} * * *`, tz: timezone },
      template: { name: "digest", data: { kind: "digest", period: "daily" } },
    },
    {
      id: "digest-weekly",
      repeat: { pattern: "0 9 * * 1", tz: timezone },
      template: { name: "digest", data: { kind: "digest", period: "weekly" } },
    },
    {
      id: "consolidate",
      repeat: { pattern: "45 23 * * 0", tz: timezone },
      template: { name: "consolidate", data: { kind: "consolidate" } },
    },
  ];
}

/**
 * Schedules those jobs from the current settings, at worker startup and after the settings change. The
 * same scheduler id replaces the previous timing, so a new digest hour or timezone needs no restart.
 */
export async function syncSettingsSchedules(settings?: AppSettings): Promise<void> {
  const q = maintenanceQueue();
  for (const { id, repeat, template } of settingsSchedules(settings ?? (await getSettings()))) {
    await q.upsertJobScheduler(id, repeat, template);
  }
}
