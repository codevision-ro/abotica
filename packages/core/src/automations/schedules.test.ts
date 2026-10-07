import { afterEach, describe, expect, it, vi } from "vitest";

/** schedules.ts imports the database client, which needs a URL; nothing connects. */
async function load() {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  return import("./schedules");
}

afterEach(() => vi.unstubAllEnvs());

const ID = "11111111-2222-4333-8444-555555555555";
const AT = new Date("2026-10-08T09:00:00Z");

describe("scheduleTiming", () => {
  it("normalizes a cron and drops the one-off time", async () => {
    const { scheduleTiming } = await load();
    expect(scheduleTiming({ kind: "cron", cron: " 0  9 * * 1-5 ", runAt: AT })).toEqual({
      kind: "cron",
      cron: "0 9 * * 1-5",
      runAt: null,
    });
  });

  it("keeps the time of a one-off and drops its cron", async () => {
    const { scheduleTiming } = await load();
    expect(scheduleTiming({ kind: "once", cron: "0 9 * * *", runAt: AT })).toEqual({
      kind: "once",
      cron: null,
      runAt: AT,
    });
  });

  it("refuses a missing or invalid value", async () => {
    const { scheduleTiming } = await load();
    expect(() => scheduleTiming({ kind: "cron", cron: "every day" })).toThrow();
    expect(() => scheduleTiming({ kind: "cron", cron: null })).toThrow();
    expect(() => scheduleTiming({ kind: "once", runAt: null })).toThrow();
  });
});

describe("isCurrentScheduleJob", () => {
  it("accepts only the job of the one-off's current time", async () => {
    const { isCurrentScheduleJob, onceJobId } = await load();
    const schedule = { id: ID, kind: "once" as const, runAt: AT, enabled: true };
    expect(isCurrentScheduleJob(schedule, { id: onceJobId(schedule)! })).toBe(true);
    // Rescheduled: the job of the earlier time is stale.
    expect(
      isCurrentScheduleJob({ ...schedule, runAt: new Date("2026-10-09T09:00:00Z") }, { id: onceJobId(schedule)! }),
    ).toBe(false);
    expect(isCurrentScheduleJob({ ...schedule, enabled: false }, { id: onceJobId(schedule)! })).toBe(false);
  });

  it("accepts only jobs of the cron's job scheduler", async () => {
    const { isCurrentScheduleJob } = await load();
    const schedule = { id: ID, kind: "cron" as const, runAt: null, enabled: true };
    expect(isCurrentScheduleJob(schedule, { id: "repeat:x:1", repeatJobKey: `schedule:${ID}` })).toBe(true);
    expect(isCurrentScheduleJob(schedule, { id: `schedule:${ID}:${AT.getTime()}` })).toBe(false);
  });
});
