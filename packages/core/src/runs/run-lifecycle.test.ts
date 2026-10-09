import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueRun, enqueueTaskEvent, runJobState } from "../infra/queues";
import { publish } from "../infra/events";
import {
  cancelClaimedRun,
  cancelPendingRun,
  cancelQueuedRuns,
  failRun,
  finishRun,
  recoverRuns,
  staleRunReason,
} from "./run-lifecycle";
import { interruptRunMessage } from "./run-messages";
import { awaitsDelegatedWork, awaitsWakeup, updateTask } from "../tasks/tasks";

type Run = {
  id: string;
  status: string;
  conversationId: string | null;
  taskId: string | null;
  createdAt: Date;
  startedAt: Date | null;
};
type Update = { table: string; patch: Record<string, unknown>; where: { column: string; value: unknown }[] };

// Records the writes; a run update returns the run unless another path ended it first (`taken`).
const { active, taskRows, taken, updates, inserts } = vi.hoisted(() => ({
  active: [] as { run: Run; limits: null }[],
  taskRows: [] as { id: string; status: string; output: string | null }[],
  taken: new Set<string>(),
  updates: [] as Update[],
  inserts: [] as Record<string, unknown>[],
}));

vi.mock("@abotica/db/orm", () => ({
  eq: (column: string, value: unknown) => [{ column, value }],
  and: (...conditions: unknown[][]) => conditions.flat(),
  inArray: (column: string, values: unknown[]) => [{ column, value: values }],
}));

vi.mock("@abotica/db", () => {
  const table = (name: string, ...columns: string[]) =>
    Object.fromEntries([["name", name], ...columns.map((c) => [c, `${name}.${c}`])]) as Record<string, string>;
  const runs = table("runs", "id", "status", "agentId");
  return {
    runs,
    agents: table("agents", "id", "limits"),
    approvals: table("approvals", "runId", "status"),
    runEvents: table("runEvents"),
    tasks: table("tasks", "id", "status"),
    db: {
      select: () => ({
        from: (t: Record<string, string>) => ({
          leftJoin: () => ({ where: async () => active }),
          where: async () => (t.name === "tasks" ? taskRows : []),
        }),
      }),
      insert: () => ({ values: async (row: Record<string, unknown>) => void inserts.push(row) }),
      update: (t: Record<string, string>) => ({
        set: (patch: Record<string, unknown>) => ({
          where: (where: Update["where"]) => {
            updates.push({ table: t.name!, patch, where });
            const id = where.find((c) => c.column === "runs.id")?.value;
            const status = where.find((c) => c.column === "runs.status")?.value;
            // By id (one run), or every run in a status (the kill switch's queued runs).
            const matched = active
              .map((a) => a.run)
              .filter((r) => (id ? r.id === id : r.status === status) && !taken.has(r.id));
            const returned = t === runs ? matched.map((r) => ({ ...r, ...patch })) : [];
            return Object.assign(Promise.resolve(), { returning: async () => returned });
          },
        }),
      }),
    },
  };
});

vi.mock("../infra/queues", () => ({
  enqueueDelegationReport: vi.fn(async () => {}),
  enqueueRun: vi.fn(async () => {}),
  enqueueTaskEvent: vi.fn(async () => {}),
  notify: vi.fn(async () => {}),
  runJobState: vi.fn(async () => "unknown"),
}));
vi.mock("../infra/events", () => ({ publish: vi.fn(async () => {}) }));
vi.mock("../infra/redis", () => ({ redis: () => ({}) }));
vi.mock("../settings/settings", () => ({
  getSettings: async () => ({ agents: { defaultLimits: { maxSteps: 20, timeoutMs: 10 * 60_000, budgetUsd: 1 } } }),
  settingsLocale: () => "en",
}));
vi.mock("../tasks/tasks", () => ({
  addTaskComment: vi.fn(),
  awaitsDelegatedWork: vi.fn(),
  awaitsWakeup: vi.fn(),
  updateTask: vi.fn(),
}));
vi.mock("./run-messages", () => ({ interruptRunMessage: vi.fn(async () => {}) }));

const NOW = new Date("2026-10-07T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const TIMEOUT = 10 * 60_000;
const MINUTE = 60_000;

describe("staleRunReason", () => {
  it("leaves a fresh queued run alone, even before its job exists", () => {
    expect(staleRunReason({ status: "queued", createdAt: ago(5_000), startedAt: null }, "unknown", TIMEOUT, NOW)).toBe(
      null,
    );
  });

  it("leaves a queued run whose job is still going to be picked up", () => {
    for (const job of ["waiting", "prioritized", "delayed", "waiting-children", "active"] as const) {
      expect(staleRunReason({ status: "queued", createdAt: ago(30 * MINUTE), startedAt: null }, job, TIMEOUT, NOW)).toBe(
        null,
      );
    }
  });

  it("flags a queued run whose job is gone or ended", () => {
    for (const job of ["unknown", "completed", "failed"] as const) {
      expect(staleRunReason({ status: "queued", createdAt: ago(2 * MINUTE), startedAt: null }, job, TIMEOUT, NOW)).toBe(
        "unqueued",
      );
    }
  });

  it("flags a running run without an active job: its worker is gone", () => {
    for (const job of ["unknown", "completed", "failed", "waiting"] as const) {
      expect(staleRunReason({ status: "running", createdAt: ago(MINUTE), startedAt: ago(MINUTE) }, job, TIMEOUT, NOW)).toBe(
        "orphaned",
      );
    }
  });

  it("leaves a running run an active job owns until its timeout plus the margin", () => {
    const run = (startedMsAgo: number) => ({
      status: "running" as const,
      createdAt: ago(startedMsAgo),
      startedAt: ago(startedMsAgo),
    });
    expect(staleRunReason(run(TIMEOUT + 14 * MINUTE), "active", TIMEOUT, NOW)).toBe(null);
    expect(staleRunReason(run(TIMEOUT + 16 * MINUTE), "active", TIMEOUT, NOW)).toBe("overdue");
  });

  it("never touches runs that already ended or wait for approvals", () => {
    for (const status of ["succeeded", "failed", "cancelled", "waiting_approval"] as const) {
      expect(
        staleRunReason({ status, createdAt: ago(60 * MINUTE), startedAt: ago(60 * MINUTE) }, "unknown", TIMEOUT, NOW),
      ).toBe(null);
    }
  });
});

const run = (id: string, status: "queued" | "running", startedMsAgo: number): Run => ({
  id,
  status,
  conversationId: "c1",
  taskId: null,
  createdAt: ago(startedMsAgo),
  startedAt: status === "running" ? ago(startedMsAgo) : null,
});

const expiredApprovals = () =>
  updates.filter((u) => u.table === "approvals").map((u) => [u.patch.status, u.where.map((c) => c.value)]);

describe("recoverRuns", () => {
  beforeEach(() => {
    active.length = 0;
    updates.length = 0;
    taken.clear();
    vi.clearAllMocks();
  });

  it("fails a run its worker left, expires its approvals and closes its answer", async () => {
    const orphaned = run("r1", "running", MINUTE);
    active.push({ run: orphaned, limits: null });

    expect(await recoverRuns(NOW)).toBe(1);

    const runUpdates = updates.filter((u) => u.table === "runs");
    expect(runUpdates.map((u) => u.patch)).toEqual([
      {
        status: "failed",
        error: "The worker restarted during the run",
        failureKind: "worker_restarted",
        finishedAt: expect.any(Date),
      },
    ]);
    expect(expiredApprovals()).toEqual([["expired", ["r1", "pending"]]]);
    expect(interruptRunMessage).toHaveBeenCalledExactlyOnceWith(orphaned, {
      toolError:
        "Interrupted: the worker stopped while this tool was running. It may or may not have taken effect; check before repeating it.",
      note: "The run was interrupted: The worker restarted during the run",
    });
    expect(publish).toHaveBeenCalledWith({
      type: "run.cancel",
      runId: "r1",
      reason: "The worker restarted during the run",
      kind: "worker_restarted",
    });
    // Nothing runs it again: a retry is the user's call.
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it("closes the answer of an overdue run with that reason", async () => {
    const overdue = run("r1", "running", TIMEOUT + 16 * MINUTE);
    active.push({ run: overdue, limits: null });
    vi.mocked(runJobState).mockResolvedValueOnce("active");

    expect(await recoverRuns(NOW)).toBe(1);
    expect(updates.find((u) => u.table === "runs")?.patch).toMatchObject({ status: "failed", failureKind: "overdue" });
    expect(interruptRunMessage).toHaveBeenCalledExactlyOnceWith(overdue, {
      toolError: expect.any(String),
      note: "The run was interrupted: The run went past its time limit and was stopped",
    });
  });

  it("has no answer to close for a run that never started", async () => {
    active.push({ run: run("r1", "queued", 2 * MINUTE), limits: null });

    expect(await recoverRuns(NOW)).toBe(1);
    expect(updates.find((u) => u.table === "runs")?.patch).toMatchObject({ status: "failed", failureKind: "unqueued" });
    expect(interruptRunMessage).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: "run.cancel" }));
  });

  it("leaves a run another path ended meanwhile to that path", async () => {
    active.push({ run: run("r1", "running", MINUTE), limits: null });
    taken.add("r1");

    expect(await recoverRuns(NOW)).toBe(0);
    expect(expiredApprovals()).toEqual([]);
    expect(interruptRunMessage).not.toHaveBeenCalled();
  });

  it("still asks the worker to abort when closing the answer fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    active.push({ run: run("r1", "running", MINUTE), limits: null });
    vi.mocked(interruptRunMessage).mockRejectedValueOnce(new Error("database down"));

    expect(await recoverRuns(NOW)).toBe(1);
    expect(error).toHaveBeenCalledWith("[runs] closing its answer for run r1 failed:", expect.any(Error));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "run.cancel", runId: "r1" }));
    error.mockRestore();
  });
});

describe("ending a run records its failure kind", () => {
  beforeEach(() => {
    active.length = 0;
    updates.length = 0;
    inserts.length = 0;
    taken.clear();
    vi.clearAllMocks();
  });

  const runPatches = () => updates.filter((u) => u.table === "runs").map((u) => u.patch);

  it("failRun stores the kind with the error and logs both", async () => {
    const failing = run("r1", "running", MINUTE);
    active.push({ run: failing, limits: null });

    expect(await failRun(failing as never, "Loop", "loop")).toMatchObject({ status: "failed", failureKind: "loop" });
    expect(runPatches()).toEqual([{ status: "failed", error: "Loop", failureKind: "loop", finishedAt: expect.any(Date) }]);
    expect(inserts).toContainEqual({ runId: "r1", type: "error", data: { message: "Loop", kind: "loop" } });
  });

  it("cancelPendingRun stores the kind and expires the run's pending approvals", async () => {
    active.push({ run: run("r1", "queued", MINUTE), limits: null });

    expect(await cancelPendingRun("r1", "Stopped", "cancelled_by_user")).toMatchObject({
      id: "r1",
      status: "cancelled",
      failureKind: "cancelled_by_user",
    });
    expect(expiredApprovals()).toEqual([["expired", ["r1", "pending"]]]);
  });

  it("cancelClaimedRun stores the kind the abort carried", async () => {
    const running = run("r1", "running", MINUTE);
    active.push({ run: running, limits: null });

    await cancelClaimedRun(running as never, "Stopped because the worker is restarting", "worker_restarted");
    expect(runPatches()).toEqual([
      {
        status: "cancelled",
        error: "Stopped because the worker is restarting",
        failureKind: "worker_restarted",
        finishedAt: expect.any(Date),
      },
    ]);
  });

  it("cancelQueuedRuns stores the kind on every queued run", async () => {
    active.push({ run: run("r1", "queued", MINUTE), limits: null }, { run: run("r2", "queued", MINUTE), limits: null });

    const cancelled = await cancelQueuedRuns("Stopped by the kill switch", "kill_switch");
    expect(cancelled.map((r) => [r.id, r.failureKind])).toEqual([
      ["r1", "kill_switch"],
      ["r2", "kill_switch"],
    ]);
  });
});

describe("finishRun with the run's task", () => {
  beforeEach(() => {
    active.length = 0;
    taskRows.length = 0;
    taken.clear();
    vi.clearAllMocks();
    vi.mocked(awaitsDelegatedWork).mockResolvedValue(false);
  });

  const finish = async () => {
    const running = { ...run("r1", "running", MINUTE), taskId: "t1", trigger: "task" };
    active.push({ run: running, limits: null });
    taskRows.push({ id: "t1", status: "in_progress", output: null });
    await finishRun(running as never, { status: "succeeded", output: "Done", actor: "agent:dev" });
  };

  it("moves the task to review when it waits for nothing", async () => {
    vi.mocked(awaitsWakeup).mockResolvedValue(false);
    await finish();
    expect(updateTask).toHaveBeenCalledWith("t1", { status: "review", output: "Done" }, "agent:dev");
    expect(enqueueTaskEvent).not.toHaveBeenCalled();
  });

  it("keeps a task waiting for a wakeup in progress and has its wakeups checked", async () => {
    vi.mocked(awaitsWakeup).mockResolvedValue(true);
    await finish();
    expect(updateTask).not.toHaveBeenCalled();
    expect(enqueueTaskEvent).toHaveBeenCalledExactlyOnceWith({ taskId: "t1", event: "wakeups" });
  });
});
