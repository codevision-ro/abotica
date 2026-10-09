import { getTranslator } from "@abotica/i18n";
import { describe, expect, it, vi } from "vitest";
import type { WaitingItem } from "./waiting-for-user";

// waiting-for-user.ts imports the database client, which needs a URL; nothing connects.
vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
const { dueForReminder, waitingAge, waitingLines } = await import("./waiting-for-user");

const now = new Date("2026-10-09T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const t = getTranslator("en");

describe("dueForReminder", () => {
  it("brings up what waited the whole window and was never reminded", () => {
    expect(dueForReminder({ since: hoursAgo(4), remindedAt: null }, now, 4)).toBe(true);
    expect(dueForReminder({ since: hoursAgo(3.9), remindedAt: null }, now, 4)).toBe(false);
  });

  it("brings nothing up twice in one window", () => {
    expect(dueForReminder({ since: hoursAgo(10), remindedAt: hoursAgo(1) }, now, 4)).toBe(false);
    expect(dueForReminder({ since: hoursAgo(10), remindedAt: now }, now, 4)).toBe(false);
    expect(dueForReminder({ since: hoursAgo(10), remindedAt: hoursAgo(4) }, now, 4)).toBe(true);
  });

  it("sends nothing with reminders off", () => {
    expect(dueForReminder({ since: hoursAgo(100), remindedAt: null }, now, 0)).toBe(false);
  });
});

describe("waitingAge", () => {
  it("says minutes, then hours, then days", () => {
    expect(waitingAge(t, hoursAgo(0.5), now)).toBe("30 min");
    expect(waitingAge(t, hoursAgo(5), now)).toBe("5 h");
    expect(waitingAge(t, hoursAgo(72), now)).toBe("3 days");
  });

  it("never goes below zero for a clock a little ahead", () => {
    expect(waitingAge(t, new Date(now.getTime() + 60_000), now)).toBe("0 min");
  });
});

describe("waitingLines", () => {
  const item = (kind: WaitingItem["kind"], title: string, projectId: string | null): WaitingItem => ({
    kind,
    id: `${kind}-id`,
    title,
    taskId: null,
    projectId,
    since: hoursAgo(5),
  });

  it("names the kind, the title, the project and the age", () => {
    const lines = waitingLines(
      t,
      [item("question", "Which logo?", "p1"), item("approval", "Writer: send_email", null)],
      new Map([["p1", "Bakery"]]),
      now,
    );
    expect(lines).toEqual(["• Question: Which logo? · Bakery · 5 h", "• Approval: Writer: send_email · 5 h"]);
  });
});
