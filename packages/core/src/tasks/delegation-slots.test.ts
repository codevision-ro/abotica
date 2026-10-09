import { UserError } from "@abotica/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asc, desc, eq } from "@abotica/db/orm";
import { withLock } from "../infra/redis";
import { type Run, startTaskRun } from "../runs/runs";
import { reportDelegatedTasks } from "./delegation";
import { mayTakePlace, startDelegatedTask, startWaitingTasks } from "./delegation-slots";
import { addTaskComment, updateTask } from "./tasks";

/**
 * Places for delegated work: a task starts while its conversation has a free place and waits otherwise,
 * urgent work goes over the cap up to twice it; the waiting ones start most urgent first, then oldest,
 * as places free up (a report hands the place on first), and a start that fails blocks its task.
 */

// Every awaited query takes the next result of its kind; `set` patches are recorded in order.
const { results, writes, settings } = vi.hoisted(() => ({
  results: { select: [] as unknown[][], update: [] as unknown[][] },
  writes: [] as Record<string, unknown>[],
  settings: { agents: { parallelDelegations: 2, urgentOverflow: false } },
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
vi.mock("../settings/settings", () => ({
  getSettings: async () => settings,
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
  priority: "medium",
  assigneeAgentId: null,
  delegatedByRunId: "manager-run",
  waitingForSlotSince: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Urgent work over the cap is tested on its own.
  settings.agents.urgentOverflow = false;
  results.select = [];
  results.update = [];
  writes.length = 0;
});

describe("mayTakePlace", () => {
  const places = (busy: number, urgent = 0) => ({ limit: 2, busy, urgent });

  it("gives any task a free place under the cap", () => {
    expect(mayTakePlace("low", places(0), false)).toBe(true);
    expect(mayTakePlace("medium", places(1), false)).toBe(true);
    expect(mayTakePlace("high", places(2), true)).toBe(false);
  });

  it("lets urgent work over the cap while fewer urgent runs than the cap are over it", () => {
    expect(mayTakePlace("urgent", places(2), true)).toBe(true);
    expect(mayTakePlace("urgent", places(3, 1), true)).toBe(true);
    // Twice the cap is the ceiling.
    expect(mayTakePlace("urgent", places(4, 2), true)).toBe(false);
  });

  it("keeps urgent work under the cap with urgentOverflow off", () => {
    expect(mayTakePlace("urgent", places(2), false)).toBe(false);
  });

  it("counts only urgent runs as over the cap after it was lowered: the runs going are left alone", () => {
    // Three ordinary runs over a cap lowered to 2: urgent work still has its own room over it.
    expect(mayTakePlace("medium", { limit: 2, busy: 5, urgent: 0 }, true)).toBe(false);
    expect(mayTakePlace("urgent", { limit: 2, busy: 5, urgent: 1 }, true)).toBe(true);
    expect(mayTakePlace("urgent", { limit: 2, busy: 5, urgent: 2 }, true)).toBe(false);
  });
});

describe("startDelegatedTask", () => {
  it("starts the task while its conversation has a free place", async () => {
    results.select = [[{ conversationId: "c1", priority: "medium" }], [{ busy: 1, urgent: 0 }]];
    expect(await startDelegatedTask("t1", { parentRunId: "manager-run" })).toEqual({ id: "run-t1" });
    expect(startTaskRun).toHaveBeenCalledWith("t1", { parentRunId: "manager-run" });
    expect(writes).toEqual([]);
  });

  it("leaves the task waiting in the backlog once every place is taken", async () => {
    results.select = [[{ conversationId: "c1", priority: "high" }], [{ busy: 2, urgent: 0 }]];
    expect(await startDelegatedTask("t1", { parentRunId: "manager-run" })).toBeNull();
    expect(startTaskRun).not.toHaveBeenCalled();
    expect(writes).toEqual([{ waitingForSlotSince: expect.any(Date) }]);
    expect(updateTask).toHaveBeenCalledWith("t1", { status: "backlog" }, "system");
  });

  it("decides under the conversation's lock, so parallel delegations cannot take the same place", async () => {
    results.select = [[{ conversationId: "c1", priority: "medium" }], [{ busy: 0, urgent: 0 }]];
    await startDelegatedTask("t1");
    expect(withLock).toHaveBeenCalledWith("abotica:conv:c1:delegation-slots", expect.any(Function));
  });

  it("starts urgent work over the cap, and holds it once the urgent runs over it reach the cap", async () => {
    settings.agents.urgentOverflow = true;
    results.select = [[{ conversationId: "c1", priority: "urgent" }], [{ busy: 3, urgent: 1 }]];
    expect(await startDelegatedTask("t1")).toEqual({ id: "run-t1" });
    results.select = [[{ conversationId: "c1", priority: "urgent" }], [{ busy: 4, urgent: 2 }]];
    expect(await startDelegatedTask("t2")).toBeNull();
    expect(startTaskRun).toHaveBeenCalledOnce();
  });

  it("passes how the task starts through to startTaskRun", async () => {
    results.select = [[{ conversationId: "c1", priority: "medium" }], [{ busy: 0, urgent: 0 }]];
    const notice = { kind: "control" as const, text: "Resumed by the user.", from: "the user" };
    await startDelegatedTask("t1", { parentRunId: "manager-run", reason: "resumed", notice, force: true });
    expect(startTaskRun).toHaveBeenCalledWith("t1", { parentRunId: "manager-run", reason: "resumed", notice, force: true });
  });

  it("starts a task no conversation delegated without asking for a place", async () => {
    results.select = [[]];
    await startDelegatedTask("t1");
    expect(startTaskRun).toHaveBeenCalledWith("t1", {});
    expect(withLock).not.toHaveBeenCalled();
  });
});

describe("startWaitingTasks", () => {
  it("gives the free places to the most urgent, then oldest, waiting tasks and leaves the rest waiting", async () => {
    results.select = [[{ busy: 0, urgent: 0 }]];
    results.update = [[waiting("a")], [waiting("b")], [waiting("c")]];
    expect(await startWaitingTasks("c1")).toBe(2);
    expect(vi.mocked(startTaskRun).mock.calls).toEqual([
      ["a", { parentRunId: "manager-run" }],
      ["b", { parentRunId: "manager-run" }],
    ]);
    // Claimed by priority, then oldest first; the third one was never taken.
    expect(desc).toHaveBeenCalledWith("tasks.priority");
    expect(asc).toHaveBeenCalledWith("tasks.waitingForSlotSince");
    expect(results.update).toEqual([[waiting("c")]]);
    expect(writes).toEqual([{ waitingForSlotSince: null }, { waitingForSlotSince: null }]);
  });

  it("starts nothing while every place is taken and urgent work fills the room over the cap", async () => {
    settings.agents.urgentOverflow = true;
    results.select = [[{ busy: 4, urgent: 2 }]];
    results.update = [[waiting("a")]];
    expect(await startWaitingTasks("c1")).toBe(0);
    expect(startTaskRun).not.toHaveBeenCalled();
    expect(results.update).toHaveLength(1);
  });

  it("blocks a task that cannot start, with the reason, and gives its place to the next", async () => {
    results.select = [[{ busy: 1, urgent: 0 }]];
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
    results.select = [[{ busy: 0, urgent: 0 }], [{ slug: "writer", enabled: false }]];
    results.update = [[waiting("a", { assigneeAgentId: "writer-id" })]];
    expect(await startWaitingTasks("c1")).toBe(0);
    expect(startTaskRun).not.toHaveBeenCalled();
    expect(vi.mocked(addTaskComment).mock.calls[0]![1]).toContain("Agent writer is disabled");
  });

  it("gives the room over the cap to urgent waiting tasks only", async () => {
    settings.agents.urgentOverflow = true;
    results.select = [[{ busy: 2, urgent: 0 }]];
    results.update = [[waiting("u1", { priority: "urgent" })], [waiting("u2", { priority: "urgent" })], []];
    expect(await startWaitingTasks("c1")).toBe(2);
    // Over the cap, only urgent tasks are looked for; at twice the cap nothing more is claimed.
    expect(eq).toHaveBeenCalledWith("tasks.priority", "urgent");
    expect(results.update).toEqual([[]]);
  });

  it("counts a task the user started since it was claimed as holding its place", async () => {
    const { TaskBusyError } = (await import("./tasks")) as unknown as { TaskBusyError: new () => Error };
    results.select = [[{ busy: 1, urgent: 0 }]];
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

  it("gives the place the run held to the next waiting task before anything is reported", async () => {
    results.select = [[origin], [{ busy: 1, urgent: 0 }], []];
    results.update = [[waiting("b", { waitingForSlotSince: new Date() })]];
    expect(await reportDelegatedTasks(finished)).toBeNull();
    expect(startTaskRun).toHaveBeenCalledWith("b", { parentRunId: "manager-run" });
    expect(writes).toEqual([{ waitingForSlotSince: null }]);
  });
});
