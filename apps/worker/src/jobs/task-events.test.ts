import { beforeEach, describe, expect, it, vi } from "vitest";

/** The task-events job routes each event to core; core is mocked, so only the order and the calls count. */

const calls = vi.hoisted(() => [] as string[]);

vi.mock("@abotica/core", () => {
  const record =
    (name: string) =>
    async (...args: unknown[]) =>
      void calls.push(`${name}(${args.join(", ")})`);
  return {
    checkTaskWakeups: vi.fn(record("checkTaskWakeups")),
    checkWakeupsWaitingOn: vi.fn(record("checkWakeupsWaitingOn")),
    createRedis: vi.fn(),
    handleTaskEvent: vi.fn(record("handleTaskEvent")),
    onTaskSettled: vi.fn(record("onTaskSettled")),
    QUEUE: { taskEvents: "task-events" },
    startRetry: vi.fn(record("startRetry")),
  };
});

const { handleTaskJob } = await import("./task-events");

beforeEach(() => {
  calls.length = 0;
});

describe("handleTaskJob", () => {
  it("starts a due retry, with or without a task", async () => {
    await handleTaskJob({ event: "retry", runId: "r1" });
    expect(calls).toEqual(["startRetry(r1)"]);
  });

  it("fires a done task's triggers and dependents, then its waiters, then what its settling unblocks", async () => {
    await handleTaskJob({ taskId: "t1", event: "done" });
    expect(calls).toEqual(["handleTaskEvent(t1, done)", "checkWakeupsWaitingOn(t1)", "onTaskSettled(t1)"]);
  });

  it("checks the waiters of a status change and what a settled status unblocks", async () => {
    await handleTaskJob({ taskId: "t1", event: "status" });
    expect(calls).toEqual(["checkWakeupsWaitingOn(t1)", "onTaskSettled(t1)"]);
  });

  it("fires only the triggers of a new task", async () => {
    await handleTaskJob({ taskId: "t1", event: "created" });
    expect(calls).toEqual(["handleTaskEvent(t1, created)"]);
  });

  it("checks a task's own wakeups", async () => {
    await handleTaskJob({ taskId: "t1", event: "wakeups" });
    expect(calls).toEqual(["checkTaskWakeups(t1)"]);
  });
});
