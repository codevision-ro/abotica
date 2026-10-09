import { describe, expect, it, vi } from "vitest";
import { lateByMinutes, waitingFor, type WaitingFacts } from "./team-status";

/** The snapshot's judgements, without the database: how late a task is and what keeps it from moving. */

vi.mock("@abotica/db", () => ({ db: {} }));
vi.mock("../settings/settings", () => ({ getSettings: vi.fn() }));

const NOW = new Date("2026-10-09T12:00:00Z");
const NOTHING: WaitingFacts = {
  pendingDependencies: [],
  openQuestions: [],
  activeWakeup: false,
  retryAt: null,
  hasActiveRun: false,
};
const row = (over: Partial<Parameters<typeof waitingFor>[0]> = {}) => ({
  status: "in_progress" as const,
  waitingForSlotSince: null,
  pausedForTaskId: null,
  continuations: 0,
  ...over,
});

describe("lateByMinutes", () => {
  it("counts whole minutes past the deadline of open work", () => {
    expect(lateByMinutes({ deadline: new Date("2026-10-09T11:30:20Z"), status: "in_progress" }, NOW)).toBe(29);
  });

  it("is null before the deadline, without one, and for work that is over", () => {
    expect(lateByMinutes({ deadline: new Date("2026-10-09T12:30:00Z"), status: "backlog" }, NOW)).toBeNull();
    expect(lateByMinutes({ deadline: null, status: "in_progress" }, NOW)).toBeNull();
    expect(lateByMinutes({ deadline: new Date("2026-10-08T12:00:00Z"), status: "done" }, NOW)).toBeNull();
    expect(lateByMinutes({ deadline: new Date("2026-10-08T12:00:00Z"), status: "cancelled" }, NOW)).toBeNull();
  });
});

describe("waitingFor", () => {
  it("is empty for work moving on its own", () => {
    expect(waitingFor(row(), { ...NOTHING, hasActiveRun: true }, 3)).toEqual([]);
  });

  it("names everything that holds the task, in a fixed order", () => {
    const at = new Date("2026-10-09T12:05:00Z");
    expect(
      waitingFor(
        row({ status: "paused", pausedForTaskId: "u1", waitingForSlotSince: NOW }),
        { pendingDependencies: ["d1"], openQuestions: ["q1"], activeWakeup: true, retryAt: at, hasActiveRun: false },
        3,
      ),
    ).toEqual([
      { kind: "paused", forTaskId: "u1" },
      { kind: "dependencies", taskIds: ["d1"] },
      { kind: "slot" },
      { kind: "answer", questionIds: ["q1"] },
      { kind: "wakeup" },
      { kind: "retry", at },
    ]);
  });

  it("does not count a wakeup while a run is going: the run's end checks it", () => {
    expect(waitingFor(row(), { ...NOTHING, activeWakeup: true, hasActiveRun: true }, 3)).toEqual([]);
  });

  it("shows the continuations of a task that went on after a limit", () => {
    expect(waitingFor(row({ continuations: 2 }), NOTHING, 3)).toEqual([{ kind: "continuation", done: 2, of: 3 }]);
    expect(waitingFor(row({ status: "review", continuations: 2 }), NOTHING, 3)).toEqual([]);
  });

  it("is empty once the task is over", () => {
    expect(waitingFor(row({ status: "cancelled" }), { ...NOTHING, openQuestions: ["q1"] }, 3)).toEqual([]);
  });
});
