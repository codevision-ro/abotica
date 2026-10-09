import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueTaskEvent } from "../infra/queues";
import { deliverToTask } from "../runs/deliver";
import { cancelPendingRun } from "../runs/run-lifecycle";
import { cancelRun } from "../runs/runs";
import {
  cancelTask,
  pauseTask,
  redirectTask,
  requestSoftStop,
  resumeHeldWork,
  resumePausedFor,
  resumeTask,
  takeSoftStop,
} from "./control";
import { loadDelegationProject, reportTask } from "./delegation";
import { startDelegatedTask } from "./delegation-slots";
import { postInstruction } from "./task-messages";
import { addTaskComment, pendingDependencies, TaskBusyError, updateTask } from "./tasks";

/**
 * Work in flight under control: a pause stops the task's run at its next step (or cancels a queued one)
 * after the task is paused, so nothing is blocked or reported; a resume goes on in the same conversation;
 * a cancel settles the whole subtree before its runs stop and reports the root only to a delegator that
 * did not cancel it; a redirect hands the task on without counting a send-back.
 */

// Every awaited query takes the next result of its kind; writes are recorded in order, with their kind.
const { results, writes, store } = vi.hoisted(() => ({
  results: { select: [] as unknown[][], update: [] as unknown[][] },
  writes: [] as { kind: string; value: Record<string, unknown> }[],
  store: new Map<string, string>(),
}));

vi.mock("@abotica/db", () => {
  const query = (kind: "select" | "update" | "insert" | "delete"): object => {
    const q: object = new Proxy(
      {},
      {
        get: (_, step) =>
          step === "then"
            ? (resolve: (rows: unknown[]) => void) =>
                resolve((kind === "select" || kind === "update" ? results[kind].shift() : undefined) ?? [])
            : (...args: unknown[]) => {
                if (step === "set" || step === "values") writes.push({ kind, value: args[0] as Record<string, unknown> });
                if (kind === "delete" && step === "where") writes.push({ kind, value: {} });
                return q;
              },
      },
    );
    return q;
  };
  const table = (name: string) => new Proxy({}, { get: (_, column) => `${name}.${String(column)}` });
  return {
    agents: table("agents"),
    projects: table("projects"),
    runs: table("runs"),
    taskComments: table("taskComments"),
    taskEvents: table("taskEvents"),
    tasks: table("tasks"),
    taskWakeups: table("taskWakeups"),
    db: {
      select: () => query("select"),
      update: () => query("update"),
      insert: () => query("insert"),
      delete: () => query("delete"),
    },
  };
});
vi.mock("@abotica/db/orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  notInArray: vi.fn(),
  or: vi.fn(),
  sql: Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join("?"), values }), {
    identifier: (name: string) => name,
  }),
}));
vi.mock("../infra/queues", () => ({ enqueueTaskEvent: vi.fn() }));
vi.mock("../infra/redis", () => ({
  redis: () => ({
    set: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    getdel: async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
  }),
}));
vi.mock("../runs/deliver", () => ({ deliverToTask: vi.fn(async () => ({ result: "stored" })) }));
vi.mock("../runs/run-lifecycle", () => ({ cancelPendingRun: vi.fn() }));
vi.mock("../runs/runs", () => ({ cancelRun: vi.fn() }));
vi.mock("../settings/settings", () => ({
  getSettings: async () => ({ agents: { maxContinuations: 3 } }),
  settingsLocale: () => "en",
  settingsTranslator: async () => (await import("@abotica/i18n")).getTranslator("en"),
}));
vi.mock("./delegation", () => ({ loadDelegationProject: vi.fn(), reportTask: vi.fn() }));
vi.mock("./delegation-slots", () => ({ startDelegatedTask: vi.fn(async () => ({ id: "run-new" })) }));
vi.mock("./task-messages", () => ({ postInstruction: vi.fn() }));
vi.mock("./tasks", () => {
  class TaskBusyError extends Error {
    readonly key = "tasks.errors.alreadyRunning";
    override name = "UserError";
  }
  return {
    addTaskComment: vi.fn(async () => ({ id: "comment-1" })),
    isActiveTaskRunConflict: (error: unknown) => error instanceof TaskBusyError,
    pendingDependencies: vi.fn(async () => []),
    TaskBusyError,
    updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
  };
});

const MANAGER = { agentId: "manager" };
const MANAGER_ROW = { name: "Mara", slug: "mara" };

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  status: "in_progress",
  priority: "medium",
  projectId: "p1",
  assigneeAgentId: "writer",
  delegatedByRunId: "manager-run",
  reportsUp: false,
  reportedAt: null,
  pauseReason: null,
  pausedForTaskId: null,
  continuations: 0,
  ...over,
});

const patches = (kind = "update") => writes.filter((w) => w.kind === kind).map((w) => w.value);
const order = (mock: unknown, call = 0) =>
  (mock as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[call]!;

beforeEach(() => {
  vi.clearAllMocks();
  results.select = [];
  results.update = [];
  writes.length = 0;
  store.clear();
});

describe("soft stop", () => {
  it("is taken once, with its reason", async () => {
    await requestSoftStop("run-1", "Paused by Mara: urgent work");
    expect(await takeSoftStop("run-1")).toBe("Paused by Mara: urgent work");
    expect(await takeSoftStop("run-1")).toBeNull();
  });
});

describe("pauseTask", () => {
  it("pauses the task first, then asks its running run to stop at its next step, and leaves a notice", async () => {
    results.select = [[task("a1")], [{ id: "run-1", status: "running" }], [MANAGER_ROW]];
    await pauseTask("a1", { by: MANAGER, reason: "the client changed the brief" });

    expect(patches()[0]).toEqual({ pauseReason: "the client changed the brief", pausedForTaskId: null });
    expect(updateTask).toHaveBeenCalledWith("a1", { status: "paused" }, "agent:mara");
    expect(await takeSoftStop("run-1")).toBe("Paused by Mara: the client changed the brief");
    expect(cancelPendingRun).not.toHaveBeenCalled();
    expect(patches("insert")).toContainEqual(
      expect.objectContaining({ taskId: "a1", type: "paused", actor: "agent:mara" }),
    );
    // Read when the task is resumed: nobody is woken.
    expect(deliverToTask).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ kind: "control", commentId: "comment-1", from: "Mara" }),
      expect.objectContaining({ wake: "never", by: MANAGER }),
    );
    expect(vi.mocked(deliverToTask).mock.calls[0]![1].text).toContain("Put aside by Mara: the client changed the brief");
  });

  it("cancels a queued run as paused, which frees its place, instead of a soft stop", async () => {
    results.select = [[task("a1")], [{ id: "run-1", status: "queued" }], [MANAGER_ROW]];
    vi.mocked(cancelPendingRun).mockResolvedValueOnce({ id: "run-1" } as never);
    await pauseTask("a1", { by: MANAGER, reason: "later" });
    expect(cancelPendingRun).toHaveBeenCalledWith("run-1", "Paused by Mara: later", "paused");
    expect(order(updateTask)).toBeLessThan(order(cancelPendingRun));
    expect(store.size).toBe(0);
  });

  it("stops a queued run that a worker claimed meanwhile at its next step", async () => {
    results.select = [[task("a1")], [{ id: "run-1", status: "queued" }], [MANAGER_ROW]];
    vi.mocked(cancelPendingRun).mockResolvedValueOnce(null);
    await pauseTask("a1", { by: MANAGER, reason: "later" });
    expect(store.get("abotica:run:run-1:soft-stop")).toBe("Paused by Mara: later");
  });

  it("names the urgent task it makes room for", async () => {
    results.select = [[task("a1")], [], [MANAGER_ROW], [{ title: "Fix checkout" }]];
    await pauseTask("a1", { by: MANAGER, reason: "it goes first", pausedForTaskId: "u1" });
    expect(patches()[0]).toEqual({ pauseReason: "it goes first", pausedForTaskId: "u1" });
    expect(vi.mocked(deliverToTask).mock.calls[0]![1].text).toContain('for the more urgent task "Fix checkout"');
  });

  it("puts the open work under it aside with it, naming the work it belongs to", async () => {
    results.select = [
      [task("a1", { title: "Window plan" })],
      [],
      [MANAGER_ROW],
      // The subtree, level by level, then the tasks in it still waiting or underway.
      [{ id: "s1" }, { id: "s2" }],
      [],
      [{ id: "s1" }],
      [task("s1")],
      [{ id: "run-s1", status: "running" }],
      [MANAGER_ROW],
    ];
    await pauseTask("a1", { by: MANAGER, reason: "the apology goes first" });

    expect(updateTask).toHaveBeenCalledWith("s1", { status: "paused" }, "agent:mara");
    expect(updateTask).not.toHaveBeenCalledWith("s2", expect.anything(), expect.anything());
    expect(await takeSoftStop("run-s1")).toBe("Paused by Mara: the apology goes first");
    expect(patches("insert")).toContainEqual(
      expect.objectContaining({ taskId: "s1", type: "paused", data: expect.objectContaining({ pausedWith: "a1" }) }),
    );
    expect(vi.mocked(deliverToTask).mock.calls[1]![1].text).toContain(
      'Put aside by Mara with "Window plan", the work it belongs to: the apology goes first',
    );
  });

  it("refuses a task whose run waits for an approval, and a settled one", async () => {
    results.select = [[task("a1")], [{ id: "run-1", status: "waiting_approval" }]];
    await expect(pauseTask("a1", { by: "user", reason: "x" })).rejects.toThrow(/waits for an approval/);
    results.select = [[task("a1", { status: "review" })]];
    await expect(pauseTask("a1", { by: "user", reason: "x" })).rejects.toThrow(/can be paused/);
    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe("resumeTask", () => {
  it("goes on in the conversation it worked in, through the delegation places, with the note leading", async () => {
    const paused = task("a1", { status: "paused", pauseReason: "later", pausedForTaskId: "u1" });
    results.select = [[paused], [], [], [paused]];
    const { run } = await resumeTask("a1", { by: "user", note: "use the new prices" });

    expect(run).toEqual({ id: "run-new" });
    expect(patches()[0]).toEqual({ pauseReason: null, pausedForTaskId: null, reportedAt: null, continuations: 0 });
    // The platform's open question ("needs more time") is answered by the resume, so the task does not wait on it.
    expect(patches()).toContainEqual({ questionStatus: "withdrawn" });
    expect(startDelegatedTask).toHaveBeenCalledWith("a1", {
      parentRunId: "manager-run",
      reason: "resumed",
      notice: {
        kind: "control",
        text: "Resumed by the user: use the new prices",
        commentId: "comment-1",
        from: "the user",
      },
      force: true,
    });
    expect(enqueueTaskEvent).not.toHaveBeenCalled();
  });

  it("gives back the continuations asked for, and an agent's resume does not force past the breaker", async () => {
    results.select = [[task("a1", { status: "blocked", continuations: 3 })], [], [MANAGER_ROW], [], [task("a1")]];
    await resumeTask("a1", { by: MANAGER, extraContinuations: 2 });
    expect(patches()[0]).toMatchObject({ continuations: 1 });
    expect(vi.mocked(startDelegatedTask).mock.calls[0]![1]).toMatchObject({ force: false, reason: "resumed" });
    expect(addTaskComment).not.toHaveBeenCalled();
  });

  it("waits in the backlog while its dependencies are pending, and has its wakeups checked", async () => {
    results.select = [[task("a1", { status: "paused" })], [], [], [task("a1")]];
    vi.mocked(pendingDependencies).mockResolvedValueOnce([{ id: "dep", title: "Dep" }]);
    expect((await resumeTask("a1", { by: "user" })).run).toBeNull();
    expect(updateTask).toHaveBeenCalledWith("a1", { status: "backlog" }, "user");
    expect(startDelegatedTask).not.toHaveBeenCalled();
    expect(enqueueTaskEvent).toHaveBeenCalledWith({ taskId: "a1", event: "wakeups" });
  });

  it("puts the task back as it was when it cannot start", async () => {
    const paused = task("a1", { status: "paused", pauseReason: "later", pausedForTaskId: "u1" });
    results.select = [[paused], []];
    vi.mocked(startDelegatedTask).mockRejectedValueOnce(new Error("circuit open"));
    await expect(resumeTask("a1", { by: "user" })).rejects.toThrow("circuit open");
    expect(patches().at(-1)).toEqual({ pauseReason: "later", pausedForTaskId: "u1", reportedAt: null, continuations: 0 });
  });

  it("refuses a task with a run going, and one that is over", async () => {
    results.select = [[task("a1")], [{ id: "run-1", status: "running" }]];
    await expect(resumeTask("a1", { by: "user" })).rejects.toBeInstanceOf(TaskBusyError);
    results.select = [[task("a1", { status: "done" })]];
    await expect(resumeTask("a1", { by: "user" })).rejects.toThrow(/can be resumed/);
  });
});

describe("cancelTask", () => {
  /** M with subtask A1, A2 delegated by M's run, and A3 under A1 that is already done. */
  const tree = () => [
    [task("m", { delegatedByRunId: "super-run" })], // the root
    [MANAGER_ROW], // who
    [{ id: "a1" }, { id: "a2" }], // below m: its subtask and the task its run delegated
    [{ id: "a3" }], // below a1 and a2
    [], // below a3
    [{ id: "m" }, { id: "a1" }, { id: "a2" }], // the ones not over yet
  ];

  it("settles the whole subtree and marks it reported before its runs stop", async () => {
    // The manager's own task was given by the super agent; a manager cancels it.
    results.select = [...tree(), [{ agentId: "super" }], [{ id: "run-a1" }, { id: "run-a2" }]];
    vi.mocked(cancelRun).mockResolvedValue(null);
    const { cancelled } = await cancelTask("m", { by: MANAGER, reason: "the client dropped it" });

    expect(cancelled).toEqual(["m", "a1", "a2"]);
    // Marked reported (the root too: it goes up as its own report), then cancelled, then its runs stopped.
    expect(patches()[0]).toEqual({ reportedAt: expect.any(Date) });
    expect(patches()).toContainEqual({ reportedAt: null });
    expect(patches()).toContainEqual({ questionStatus: "withdrawn" });
    expect(vi.mocked(updateTask).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["m", { status: "cancelled" }],
      ["a1", { status: "cancelled" }],
      ["a2", { status: "cancelled" }],
    ]);
    expect(order(updateTask, 2)).toBeLessThan(order(cancelRun));
    expect(cancelRun).toHaveBeenCalledWith("run-a1", "Cancelled by Mara: the client dropped it", "cancelled_by_agent");
    expect(cancelRun).toHaveBeenCalledTimes(2);
    // Its wakeups are gone; each task says why it stopped.
    expect(patches("delete")).toHaveLength(1);
    expect(vi.mocked(addTaskComment).mock.calls.map((c) => c[1])).toEqual([
      "Cancelled by Mara: the client dropped it",
      'Cancelled by Mara together with "Task m": the client dropped it',
      'Cancelled by Mara together with "Task m": the client dropped it',
    ]);
    expect(reportTask).toHaveBeenCalledExactlyOnceWith("m");
  });

  it("does not report the root to the delegator that cancelled it", async () => {
    results.select = [...tree(), [{ agentId: "manager" }], []];
    await cancelTask("m", { by: MANAGER, reason: "not needed" });
    expect(reportTask).not.toHaveBeenCalled();
    expect(patches()).not.toContainEqual({ reportedAt: null });
  });

  it("stops only the task itself without cascade, with the user's kind", async () => {
    results.select = [[task("a1")], [{ id: "a1" }], [{ id: "run-a1" }]];
    await cancelTask("a1", { by: "user", reason: "wrong brief", cascade: false });
    expect(updateTask).toHaveBeenCalledExactlyOnceWith("a1", { status: "cancelled" }, "user");
    expect(cancelRun).toHaveBeenCalledWith("run-a1", "Cancelled by the user: wrong brief", "cancelled_by_user");
    // The user is not the agent that delegated it: its manager hears of it at once.
    expect(reportTask).toHaveBeenCalledWith("a1");
  });

  it("refuses a task that is already over", async () => {
    results.select = [[task("a1", { status: "cancelled" })]];
    await expect(cancelTask("a1", { by: "user", reason: "x" })).rejects.toThrow(/already done or cancelled/);
  });
});

describe("redirectTask", () => {
  it("sends new instructions through the task's message stream", async () => {
    results.select = [[task("a1")], [MANAGER_ROW], [task("a1")]];
    await redirectTask("a1", { by: MANAGER, instructions: "Use the K names only" });
    expect(postInstruction).toHaveBeenCalledWith("a1", "Use the K names only", MANAGER);
    expect(patches("insert")).toContainEqual(expect.objectContaining({ type: "redirected" }));
  });

  it("changes priority and deadline in place", async () => {
    const deadline = new Date("2026-10-10T12:00:00Z");
    results.select = [[task("a1")], [MANAGER_ROW], [task("a1")]];
    await redirectTask("a1", { by: MANAGER, priority: "urgent", deadline });
    expect(updateTask).toHaveBeenCalledWith("a1", { priority: "urgent", deadline }, "agent:mara");
    expect(postInstruction).not.toHaveBeenCalled();
  });

  it("hands the task to another team member without counting a send-back", async () => {
    const target = {
      id: "researcher",
      slug: "researcher",
      name: "Rita",
      kind: "specialist",
      enabled: true,
      isTemplate: false,
    };
    results.select = [
      [task("a1")],
      [MANAGER_ROW],
      [target],
      [{ agentId: "manager" }], // the task's delegator
      [{ id: "manager", kind: "manager" }],
      [{ id: "p1" }], // the projects it leads
      [{ id: "run-1", status: "running" }],
      [task("a1")],
    ];
    vi.mocked(loadDelegationProject).mockResolvedValueOnce({
      id: "p1",
      name: "Shop",
      managerAgentId: "manager",
      managerSlug: "mara",
      memberIds: ["writer", "researcher"],
    });
    vi.mocked(startDelegatedTask).mockRejectedValueOnce(new TaskBusyError("a1"));
    await redirectTask("a1", {
      by: MANAGER,
      reassignTo: "researcher",
      instructions: "Start over",
      reason: "writer is busy",
    });

    // Back in the backlog with the new assignee before the old run stops.
    expect(updateTask).toHaveBeenCalledWith(
      "a1",
      { status: "backlog", assigneeAgentId: "researcher", assignedToUser: false },
      "agent:mara",
    );
    expect(order(updateTask)).toBeLessThan(order(cancelRun));
    expect(cancelRun).toHaveBeenCalledWith("run-1", "Reassigned by Mara to Rita: writer is busy", "cancelled_by_agent");
    const handedOn = patches().find((p) => "agentRounds" in p)!;
    expect(handedOn).toMatchObject({ reportedAt: null, agentRounds: { sql: "? + 1" } });
    expect(handedOn).not.toHaveProperty("redelegations");
    // The instruction is part of the new assignee's brief, not delivered to the old run.
    expect(addTaskComment).toHaveBeenCalledWith("a1", "Start over", MANAGER, { kind: "instruction" });
    expect(postInstruction).not.toHaveBeenCalled();
    // The old run has not stopped yet: the task takes the place it frees.
    expect(patches()).toContainEqual({ waitingForSlotSince: expect.any(Date) });
  });

  it("refuses an assignee its delegator could not give it to", async () => {
    const outsider = { id: "x", slug: "outsider", name: "X", kind: "specialist", enabled: true, isTemplate: false };
    results.select = [
      [task("a1")],
      [MANAGER_ROW],
      [outsider],
      [{ agentId: "manager" }],
      [{ id: "manager", kind: "manager" }],
      [{ id: "p1" }],
    ];
    vi.mocked(loadDelegationProject).mockResolvedValueOnce({
      id: "p1",
      name: "Shop",
      managerAgentId: "manager",
      managerSlug: "mara",
      memberIds: ["writer"],
    });
    await expect(redirectTask("a1", { by: MANAGER, reassignTo: "x" })).rejects.toThrow(/cannot go to outsider/);
    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe("resumeHeldWork", () => {
  it("brings back the work put aside with the task resumed, and only that work", async () => {
    results.select = [
      [task("a1", { status: "paused" })],
      [],
      [
        { id: "s1", withId: "a1" },
        { id: "x1", withId: "other" },
      ],
      [task("s1", { status: "paused" })],
      [],
      [],
      [task("s1")],
      [task("a1")],
    ];
    await resumeTask("a1", { by: "user" });
    expect(vi.mocked(startDelegatedTask).mock.calls.map((c) => c[0])).toEqual(["a1", "s1"]);
  });

  it("in the sweep, waits while the work above is still paused and leaves a run still stopping for later", async () => {
    results.select = [
      [
        { id: "s1", withId: "a1" },
        { id: "s2", withId: "a2" },
      ],
      [{ id: "a2" }],
      [task("s1", { status: "paused" })],
      [{ id: "run-s1", status: "running" }],
    ];
    expect(await resumeHeldWork(null)).toBe(0);
    expect(startDelegatedTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(reportTask).not.toHaveBeenCalled();
  });
});

describe("resumePausedFor", () => {
  it("resumes each task put aside for the settled one, and blocks and reports one that cannot go on", async () => {
    results.update = [[{ id: "l1" }, { id: "l2" }]];
    results.select = [
      [{ title: "Fix checkout" }],
      [task("l1", { status: "paused" })],
      [],
      [task("l1")],
      [task("l2", { status: "paused" })],
      [],
    ];
    vi.mocked(startDelegatedTask)
      .mockResolvedValueOnce({ id: "run-l1" } as never)
      .mockRejectedValueOnce(new Error("its runs keep failing"));

    expect(await resumePausedFor("u1")).toBe(1);
    expect(vi.mocked(startDelegatedTask).mock.calls[0]![1]).toMatchObject({
      reason: "resumed",
      force: false,
      notice: expect.objectContaining({ text: expect.stringContaining('"Fix checkout" is settled') }),
    });
    expect(updateTask).toHaveBeenCalledWith("l2", { status: "blocked" }, "system");
    expect(reportTask).toHaveBeenCalledWith("l2");
  });

  it("gives the link back to a task whose paused run is still stopping, for the sweeper to resume later", async () => {
    results.update = [[{ id: "l1" }]];
    results.select = [
      [{ title: "Fix checkout" }],
      [task("l1", { status: "paused" })],
      [{ id: "run-l1", status: "running" }],
    ];
    expect(await resumePausedFor("u1")).toBe(0);
    expect(patches()).toEqual([{ pausedForTaskId: null }, { pausedForTaskId: "u1" }]);
    expect(updateTask).not.toHaveBeenCalled();
    expect(reportTask).not.toHaveBeenCalled();
  });

  it("does nothing when no task waits for it (another resume took them)", async () => {
    expect(await resumePausedFor("u1")).toBe(0);
    expect(startDelegatedTask).not.toHaveBeenCalled();
  });
});
