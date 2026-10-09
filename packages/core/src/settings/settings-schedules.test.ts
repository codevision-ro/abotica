import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as SettingsSchedules from "./settings-schedules";
import { type AppSettings, DEFAULT_SETTINGS } from "./settings-schema";

let settingsSchedules: typeof SettingsSchedules.settingsSchedules;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  ({ settingsSchedules } = await import("./settings-schedules"));
});

const settings = (timezone: string, reports: Partial<AppSettings["reports"]> = {}) => ({
  general: { ...DEFAULT_SETTINGS.general, timezone },
  reports: { ...DEFAULT_SETTINGS.reports, ...reports },
});

describe("settingsSchedules", () => {
  it("runs the daily digest at its hour", () => {
    const { active } = settingsSchedules(settings("UTC", { daily: { enabled: true, hour: 7 } }));
    expect(active.find((s) => s.id === "digest-daily")?.repeat.pattern).toBe("0 7 * * *");
  });

  it("runs the weekly digest on its day and hour", () => {
    const { active } = settingsSchedules(settings("UTC", { weekly: { enabled: true, weekday: 5, hour: 17 } }));
    expect(active.find((s) => s.id === "digest-weekly")?.repeat.pattern).toBe("0 17 * * 5");
  });

  it("drops a report that is turned off", () => {
    const { active, inactive } = settingsSchedules(settings("UTC", { daily: { enabled: false, hour: 20 } }));
    expect(active.map((s) => s.id)).toEqual(["journals", "digest-weekly", "consolidate"]);
    expect(inactive).toEqual(["digest-daily"]);
  });

  it("puts every job in the settings timezone", () => {
    const { active } = settingsSchedules(settings("Asia/Tokyo"));
    expect(active.map((s) => s.id)).toEqual(["journals", "digest-daily", "digest-weekly", "consolidate"]);
    expect(active.every((s) => s.repeat.tz === "Asia/Tokyo")).toBe(true);
  });
});
