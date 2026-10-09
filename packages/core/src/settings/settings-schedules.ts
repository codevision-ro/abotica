import { type MaintenanceJob, maintenanceQueue } from "../infra/queues";
import { type AppSettings, getSettings } from "./settings";

type SettingsSchedule = {
  id: string;
  repeat: { pattern: string; tz: string };
  template: { name: string; data: MaintenanceJob };
};

/** Nightly journals and the weekly memory consolidation, late enough to cover the whole day. */
const JOURNALS_CRON = "30 23 * * *";
const CONSOLIDATE_CRON = "45 23 * * 0";

/** The maintenance jobs whose time follows the settings: the time zone and the reports. */
export function settingsSchedules({ general, reports }: Pick<AppSettings, "general" | "reports">): {
  active: SettingsSchedule[];
  inactive: string[];
} {
  const tz = general.timezone;
  const all: (SettingsSchedule & { enabled: boolean })[] = [
    {
      id: "journals",
      enabled: true,
      repeat: { pattern: JOURNALS_CRON, tz },
      template: { name: "journals", data: { kind: "journals" } },
    },
    {
      id: "digest-daily",
      enabled: reports.daily.enabled,
      repeat: { pattern: `0 ${reports.daily.hour} * * *`, tz },
      template: { name: "digest", data: { kind: "digest", period: "daily" } },
    },
    {
      id: "digest-weekly",
      enabled: reports.weekly.enabled,
      repeat: { pattern: `0 ${reports.weekly.hour} * * ${reports.weekly.weekday}`, tz },
      template: { name: "digest", data: { kind: "digest", period: "weekly" } },
    },
    {
      id: "consolidate",
      enabled: true,
      repeat: { pattern: CONSOLIDATE_CRON, tz },
      template: { name: "consolidate", data: { kind: "consolidate" } },
    },
  ];
  return {
    active: all.filter((s) => s.enabled).map(({ id, repeat, template }) => ({ id, repeat, template })),
    inactive: all.filter((s) => !s.enabled).map((s) => s.id),
  };
}

/**
 * Schedules those jobs from the current settings, at worker startup and after the settings change. The
 * same scheduler id replaces the previous timing, so a new hour or time zone needs no restart; a report
 * turned off loses its scheduler.
 */
export async function syncSettingsSchedules(settings?: AppSettings): Promise<void> {
  const q = maintenanceQueue();
  const { active, inactive } = settingsSchedules(settings ?? (await getSettings()));
  for (const { id, repeat, template } of active) await q.upsertJobScheduler(id, repeat, template);
  for (const id of inactive) await q.removeJobScheduler(id);
}
