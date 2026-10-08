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

  it("opens after 3 counted failures in a row, with the last one's error", async () => {
    expect(await streak([failed("loop"), failed("other")])).toEqual({
      failures: 2,
      reason: "failed: other",
      open: false,
    });
    expect(await streak([failed("loop"), failed("other"), failed("step_limit")])).toEqual({
      failures: 3,
      reason: "failed: step_limit",
      open: true,
    });
  });

  it("opens after one failure of the setup: the same key, provider or model fails again", async () => {
    for (const kind of ["provider_auth", "provider_not_allowed", "no_model"]) {
      expect(await streak([failed(kind)])).toMatchObject({ failures: 1, open: true });
    }
  });

  it("does not count transient failures and the user's stops, nor let them break the streak", async () => {
    const skipped = ["rate_limited", "worker_restarted", "unqueued", "overdue", "cancelled_by_user", "kill_switch"];
    for (const kind of skipped)
      expect(await streak([failed(kind), failed(kind), failed(kind)])).toMatchObject({ open: false });
    expect(
      await streak([failed("loop"), failed("rate_limited"), failed("loop"), failed("worker_restarted")]),
    ).toMatchObject({ failures: 2, open: false });
    // A manager stopping a run to redirect the work is not a failure either.
    const cancelledByAgent = { ...failed("other"), status: "cancelled" };
    expect(await streak([failed("loop"), failed("loop"), cancelledByAgent])).toMatchObject({ failures: 2, open: false });
  });

  it("skips runs from before failure kinds were recorded", async () => {
    const old = { agentId: "a1", status: "failed", failureKind: null, error: "old" };
    expect(await streak([old, old, old])).toMatchObject({ failures: 0, open: false });
  });

  it("resets on a success", async () => {
    expect(await streak([failed("loop"), failed("loop"), succeeded(), failed("loop")])).toMatchObject({
      failures: 1,
      open: false,
    });
  });

  it("counts only the current assignee's runs", async () => {
    expect(await streak([failed("provider_auth", "a0"), failed("loop", "a0"), failed("loop", "a0")])).toMatchObject({
      failures: 0,
      open: false,
    });
    expect(await streak([failed("loop"), failed("loop"), failed("loop", "a0"), failed("loop")])).toMatchObject({
      failures: 1,
    });
  });

  it("starts over with a run started while open, which only the user's forced start does", async () => {
    // A forced run that fails the same setup way opens it again at once.
    expect(await streak([failed("provider_auth"), failed("provider_auth")])).toMatchObject({ failures: 1, open: true });
    // Other failures get their 3 attempts again.
    const opened = [failed("loop"), failed("loop"), failed("loop")];
    expect(await streak([...opened, failed("loop")])).toMatchObject({ failures: 1, open: false });
    // A forced run that is still going leaves nothing open.
    const running = { agentId: "a1", status: "running", failureKind: null, error: null };
    expect(await streak([...opened, running])).toMatchObject({ failures: 0, open: false });
  });
});
