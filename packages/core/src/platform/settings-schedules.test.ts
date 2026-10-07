import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as SettingsSchedules from "./settings-schedules";

let settingsSchedules: typeof SettingsSchedules.settingsSchedules;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  ({ settingsSchedules } = await import("./settings-schedules"));
});

describe("settingsSchedules", () => {
  it("runs the daily digest at the digest hour", () => {
    const daily = settingsSchedules({ timezone: "UTC", digestHour: 7 }).find((s) => s.id === "digest-daily");
    expect(daily?.repeat.pattern).toBe("0 7 * * *");
  });

  it("puts every job in the settings timezone", () => {
    const schedules = settingsSchedules({ timezone: "Asia/Tokyo", digestHour: 20 });
    expect(schedules.map((s) => s.id)).toEqual(["journals", "digest-daily", "digest-weekly", "consolidate"]);
    expect(schedules.every((s) => s.repeat.tz === "Asia/Tokyo")).toBe(true);
  });
});
