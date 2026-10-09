import { afterEach, describe, expect, it, vi } from "vitest";

/** tasks.ts imports the database client, which needs a URL; nothing connects. */
async function load() {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  return import("./tasks");
}

afterEach(() => vi.unstubAllEnvs());

describe("isActiveTaskRunConflict", () => {
  it("recognizes the task's unique index, also when wrapped", async () => {
    const { isActiveTaskRunConflict } = await load();
    const pg = { code: "23505", constraint_name: "runs_one_active_per_task" };
    expect(isActiveTaskRunConflict(pg)).toBe(true);
    expect(isActiveTaskRunConflict(new Error("Failed query", { cause: pg }))).toBe(true);
  });

  it("recognizes the error startRun raises for it", async () => {
    const { isActiveTaskRunConflict, TaskBusyError } = await load();
    expect(isActiveTaskRunConflict(new TaskBusyError("t1"))).toBe(true);
  });

  it("ignores other errors", async () => {
    const { isActiveTaskRunConflict } = await load();
    expect(isActiveTaskRunConflict({ code: "23505", constraint_name: "runs_one_active_per_conversation" })).toBe(false);
    expect(isActiveTaskRunConflict(new Error("boom"))).toBe(false);
    expect(isActiveTaskRunConflict(undefined)).toBe(false);
  });
});

describe("leavesBacklog", () => {
  it("drops the wait for a place once the task starts, settles or is moved by hand", async () => {
    const { leavesBacklog } = await load();
    for (const status of ["in_progress", "review", "done", "blocked"] as const) expect(leavesBacklog(status)).toBe(true);
  });

  it("keeps it while the task stays in the backlog or its status is not changed", async () => {
    const { leavesBacklog } = await load();
    expect(leavesBacklog("backlog")).toBe(false);
    expect(leavesBacklog(undefined)).toBe(false);
  });
});

describe("failureStreak (the task's circuit breaker)", () => {
  type Outcome = { agentId: string | null; status: string; failureKind: string | null; error: string | null };
  const failed = (failureKind: string, agentId = "a1"): Outcome => ({
    agentId,
    status: "failed",
    failureKind,
    error: `failed: ${failureKind}`,
  });
  const succeeded = (agentId = "a1"): Outcome => ({ agentId, status: "succeeded", failureKind: null, error: null });
  const streak = async (history: Outcome[], assignee: string | null = "a1") =>
    (await load()).failureStreak(history as never, assignee);

  const times = (n: number, outcome: () => Outcome) => Array.from({ length: n }, outcome);

  it("opens after CIRCUIT_BREAKER_FAILURES counted failures in a row, with the last one's error", async () => {
    const { CIRCUIT_BREAKER_FAILURES } = await load();
    expect(CIRCUIT_BREAKER_FAILURES).toBe(5);
    expect(await streak([...times(3, () => failed("other")), failed("context_overflow")])).toEqual({
      failures: 4,
      reason: "failed: context_overflow",
      open: false,
    });
    expect(await streak([...times(4, () => failed("other")), failed("providers_unavailable")])).toEqual({
      failures: 5,
      reason: "failed: providers_unavailable",
      open: true,
    });
  });

  it("opens after one failure of the setup: the same key, provider or model fails again", async () => {
    for (const kind of ["provider_auth", "provider_not_allowed", "no_model"]) {
      expect(await streak([failed(kind)])).toMatchObject({ failures: 1, open: true });
    }
  });

  it("does not count transient failures, the user's stops and the run's limits, nor let them break the streak", async () => {
    const skipped = [
      "rate_limited",
      "usage_limit",
      "worker_restarted",
      "unqueued",
      "overdue",
      "cancelled_by_user",
      "cancelled_by_agent",
      "paused",
      "kill_switch",
      "step_limit",
      "timeout",
      "loop",
    ];
    for (const kind of skipped) expect(await streak(times(10, () => failed(kind)))).toMatchObject({ open: false });
    expect(
      await streak([failed("other"), failed("rate_limited"), failed("other"), failed("worker_restarted"), failed("loop")]),
    ).toMatchObject({ failures: 2, open: false });
    // A manager stopping a run to redirect the work is not a failure either.
    const cancelledByAgent = { ...failed("other"), status: "cancelled" };
    expect(await streak([failed("other"), failed("other"), cancelledByAgent])).toMatchObject({ failures: 2, open: false });
  });

  it("skips runs from before failure kinds were recorded", async () => {
    const old = { agentId: "a1", status: "failed", failureKind: null, error: "old" };
    expect(await streak([old, old, old])).toMatchObject({ failures: 0, open: false });
  });

  it("resets on a success", async () => {
    expect(await streak([failed("other"), failed("other"), succeeded(), failed("other")])).toMatchObject({
      failures: 1,
      open: false,
    });
  });

  it("counts only the current assignee's runs", async () => {
    expect(await streak([failed("provider_auth", "a0"), failed("other", "a0"), failed("other", "a0")])).toMatchObject({
      failures: 0,
      open: false,
    });
    expect(await streak([failed("other"), failed("other"), failed("other", "a0"), failed("other")])).toMatchObject({
      failures: 1,
    });
  });

  it("starts over with a run started while open, which only the user's forced start does", async () => {
    // A forced run that fails the same setup way opens it again at once.
    expect(await streak([failed("provider_auth"), failed("provider_auth")])).toMatchObject({ failures: 1, open: true });
    // Other failures get their attempts again.
    const opened = times(5, () => failed("other"));
    expect(await streak([...opened, failed("other")])).toMatchObject({ failures: 1, open: false });
    // A forced run that is still going leaves nothing open.
    const running = { agentId: "a1", status: "running", failureKind: null, error: null };
    expect(await streak([...opened, running])).toMatchObject({ failures: 0, open: false });
  });
});
