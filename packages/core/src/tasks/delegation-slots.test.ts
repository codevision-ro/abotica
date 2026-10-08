import { UserError } from "@abotica/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asc } from "@abotica/db/orm";
import { withLock } from "../infra/redis";
import { type Run, startTaskRun } from "../runs/runs";
import { reportDelegatedTasks } from "./delegation";
import { freePlaces, startDelegatedTask, startWaitingTasks } from "./delegation-slots";
import { addTaskComment, updateTask } from "./tasks";

/**
 * Places for delegated work: a task starts while its conversation has a free place and waits otherwise;
 * the waiting ones start oldest first as places free up, a start that fails blocks its task, and the
 * round is not reported while one of its tasks still waits.
 */

// Every awaited query takes the next result of its kind; `set` patches are recorded in order.
const { results, writes } = vi.hoisted(() => ({
  results: { select: [] as unknown[][], update: [] as unknown[][] },
  writes: [] as Record<string, unknown>[],
}));

vi.mock("@abotica/db", () => {
  /** A query builder: each step returns it, and awaiting it gives the next result queued for its kind. */
  const query = (kind: keyof typeof results): object => {
    const q: object = new Proxy(
      {},
      {
        get: (_, step) =>
          step === "then"
            ? (resolve: (rows: unknown[]) => void) => resolve(results[kind].shift() ?? [])
            : (...args: unknown[]) => {
                if (step === "set") writes.push(args[0] as Record<string, unknown>);
                return q;
              },
      },
    );
    return q;
  };
  const table = (name: string) => new Proxy({}, { get: (_, column) => `${name}.${String(column)}` });
  return {
    agents: table("agents"),
    conversations: table("conversations"),
    files: table("files"),
    messages: table("messages"),
    projectAgents: table("projectAgents"),
    projects: table("projects"),
    runs: table("runs"),
    tasks: table("tasks"),
    db: { select: () => query("select"), selectDistinct: () => query("select"), update: () => query("update") },
  };
});
vi.mock("@abotica/db/orm", () => ({
  and: vi.fn(),
  asc: vi.fn(),
  count: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  isNotNull: vi.fn(),
  isNull: vi.fn(),
  lt: vi.fn(),
  notExists: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
}));
vi.mock("../infra/redis", () => ({ withLock: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock("../infra/events", () => ({ publish: vi.fn() }));
vi.mock("../infra/queues", () => ({ enqueueDelegationReport: vi.fn(), notify: vi.fn() }));
vi.mock("../infra/env", () => ({ env: () => ({ APP_URL: "http://localhost" }) }));
vi.mock("../platform/settings", () => ({
  getSettings: async () => ({ parallelDelegations: 2 }),
  settingsLocale: () => "en",
}));
vi.mock("../runs/runs", () => ({
  ConversationBusyError: class extends Error {},
  startContinuation: vi.fn(),
  startTaskRun: vi.fn(async (taskId: string) => ({ id: `run-${taskId}` })),
}));
vi.mock("../files/files", () => ({ filePart: vi.fn() }));
vi.mock("../models/provider-policy", () => ({}));
vi.mock("../agents/model-chain", () => ({}));
vi.mock("./tasks", () => {
  class TaskBusyError extends Error {}
  return {
    addTaskComment: vi.fn(),
    isActiveTaskRunConflict: (error: unknown) => error instanceof TaskBusyError,
    TaskBusyError,
    updateTask: vi.fn(),
  };
});

const waiting = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  assigneeAgentId: null,
  delegatedByRunId: "manager-run",
  waitingForSlotSince: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  results.select = [];
  results.update = [];
  writes.length = 0;
});

describe("freePlaces", () => {
  it("counts the places left under the limit", () => {
    expect(freePlaces(2, 0)).toBe(2);
    expect(freePlaces(2, 1)).toBe(1);
    expect(freePlaces(2, 2)).toBe(0);
  });

  it("never goes below zero after the limit was lowered: the runs going are left alone", () => {
    expect(freePlaces(1, 3)).toBe(0);
  });
});

describe("startDelegatedTask", () => {
  it("starts the task while its conversation has a free place", async () => {
    results.select = [[{ conversationId: "c1" }], [{ busy: 1 }]];
    expect(await startDelegatedTask("t1", { parentRunId: "manager-run" })).toEqual({ id: "run-t1" });
    expect(startTaskRun).toHaveBeenCalledWith("t1", { parentRunId: "manager-run" });
    expect(writes).toEqual([]);
  });

  it("leaves the task waiting in the backlog once every place is taken", async () => {
    results.select = [[{ conversationId: "c1" }], [{ busy: 2 }]];
    expect(await startDelegatedTask("t1", { parentRunId: "manager-run" })).toBeNull();
    expect(startTaskRun).not.toHaveBeenCalled();
    expect(writes).toEqual([{ waitingForSlotSince: expect.any(Date) }]);
    expect(updateTask).toHaveBeenCalledWith("t1", { status: "backlog" }, "system");
  });

  it("decides under the conversation's lock, so parallel delegations cannot take the same place", async () => {
    results.select = [[{ conversationId: "c1" }], [{ busy: 0 }]];
    await startDelegatedTask("t1");
    expect(withLock).toHaveBeenCalledWith("abotica:conv:c1:delegation-slots", expect.any(Function));
  });

  it("starts a task no conversation delegated without asking for a place", async () => {
    results.select = [[]];
    await startDelegatedTask("t1");
    expect(startTaskRun).toHaveBeenCalledWith("t1", {});
    expect(withLock).not.toHaveBeenCalled();
  });
});

describe("startWaitingTasks", () => {
  it("gives the free places to the oldest waiting tasks and leaves the rest waiting", async () => {
    results.select = [[{ busy: 0 }]];
    results.update = [[waiting("a")], [waiting("b")], [waiting("c")]];
    expect(await startWaitingTasks("c1")).toBe(2);
    expect(vi.mocked(startTaskRun).mock.calls).toEqual([
      ["a", { parentRunId: "manager-run" }],
      ["b", { parentRunId: "manager-run" }],
    ]);
    // Claimed oldest first; the third one was never taken.
    expect(asc).toHaveBeenCalledWith("tasks.waitingForSlotSince");
    expect(results.update).toEqual([[waiting("c")]]);
    expect(writes).toEqual([{ waitingForSlotSince: null }, { waitingForSlotSince: null }]);
  });

  it("starts nothing while every place is taken", async () => {
    results.select = [[{ busy: 2 }]];
    results.update = [[waiting("a")]];
    expect(await startWaitingTasks("c1")).toBe(0);
    expect(startTaskRun).not.toHaveBeenCalled();
    expect(results.update).toHaveLength(1);
  });

  it("blocks a task that cannot start, with the reason, and gives its place to the next", async () => {
    results.select = [[{ busy: 1 }]];
    results.update = [[waiting("a")], [waiting("b")]];
    vi.mocked(startTaskRun).mockRejectedValueOnce(new UserError("tasks.errors.notAssigned"));
    expect(await startWaitingTasks("c1")).toBe(1);
    expect(updateTask).toHaveBeenCalledWith("a", { status: "blocked" }, "system");
    expect(addTaskComment).toHaveBeenCalledWith(
      "a",
      "This task waited for a free place and could not start when one freed up: The task is not assigned to an agent. Fix the cause, then start it again.",
      "system",
    );
    expect(startTaskRun).toHaveBeenLastCalledWith("b", { parentRunId: "manager-run" });
  });

  it("blocks a task whose assignee was disabled instead of starting a run that would fail", async () => {
    results.select = [[{ busy: 0 }], [{ slug: "writer", enabled: false }]];
    results.update = [[waiting("a", { assigneeAgentId: "writer-id" })]];
    expect(await startWaitingTasks("c1")).toBe(0);
    expect(startTaskRun).not.toHaveBeenCalled();
    expect(vi.mocked(addTaskComment).mock.calls[0]![1]).toContain("Agent writer is disabled");
  });

  it("counts a task the user started since it was claimed as holding its place", async () => {
    const { TaskBusyError } = (await import("./tasks")) as unknown as { TaskBusyError: new () => Error };
    results.select = [[{ busy: 1 }]];
    results.update = [[waiting("a")], [waiting("b")]];
    vi.mocked(startTaskRun).mockRejectedValueOnce(new TaskBusyError());
    expect(await startWaitingTasks("c1")).toBe(0);
    expect(updateTask).not.toHaveBeenCalled();
    expect(results.update).toEqual([[waiting("b")]]);
  });
});

describe("reportDelegatedTasks and the tasks waiting for a place", () => {
  const finished = { id: "worker-run", taskId: "a" } as Run;
  const origin = { delegator: { id: "manager-run", conversationId: "c1" }, agent: { id: "manager" } };

  it("does not report a round while one of its tasks waits for a place", async () => {
    results.select = [[origin], [{ busy: 2 }], [waiting("a"), waiting("b", { waitingForSlotSince: new Date() })]];
    expect(await reportDelegatedTasks(finished)).toBeNull();
    expect(writes).toEqual([]);
  });

  it("starts the waiting tasks first, so the one it starts keeps the round open", async () => {
    results.select = [[origin], [{ busy: 1 }], [waiting("a"), waiting("b")], [{ id: "run-b" }]];
    results.update = [[waiting("b", { waitingForSlotSince: new Date() })]];
    expect(await reportDelegatedTasks(finished)).toBeNull();
    expect(startTaskRun).toHaveBeenCalledWith("b", { parentRunId: "manager-run" });
    // Only the claim of the waiting task; no task was claimed for a report.
    expect(writes).toEqual([{ waitingForSlotSince: null }]);
  });

  it("claims the round for its report once nothing runs or waits", async () => {
    results.select = [[origin], [{ busy: 0 }], [waiting("a"), waiting("b")], []];
    results.update = [[], []];
    expect(await reportDelegatedTasks(finished)).toBeNull();
    expect(writes).toEqual([{ waitingForSlotSince: null }, { reportedAt: expect.any(Date) }]);
  });
});
