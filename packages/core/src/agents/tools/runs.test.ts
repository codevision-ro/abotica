import { beforeEach, describe, expect, it, vi } from "vitest";
import { redelegateTask } from "../../tasks/delegation";
import { activeTaskRun, createTask, taskFailureStreak, TaskCircuitOpenError } from "../../tasks/tasks";
import { startDelegatedTask } from "../../tasks/delegation-slots";
import { pauseTask } from "../../tasks/control";
import { runTools } from "./runs";

/**
 * delegate_task on a task whose runs keep failing: the delegator gets the error as data, no run starts.
 * With every place of its conversation taken, the task waits and the delegator is told it starts on its own.
 * A new task takes the delegator's own priority by default; urgent work lists what the assignee is busy
 * with and, with putAside, pauses its lower-priority work the delegator controls.
 */

const TASK = {
  id: "t1",
  title: "Retry me",
  assigneeAgentId: "worker",
  projectId: null,
  redelegations: 0,
  priority: "medium",
};

// Each select takes the next rows queued for it, or the task above; `set` patches are recorded.
const { selects, sets } = vi.hoisted(() => ({ selects: [] as unknown[][], sets: [] as Record<string, unknown>[] }));
const WORKER = { id: "worker", slug: "worker", isTemplate: false, enabled: true };
const OTHER = { id: "other", slug: "other", isTemplate: false, enabled: true };

vi.mock("@abotica/db", () => {
  const query = (rows: () => unknown[]): object => {
    const q: object = new Proxy(
      {},
      {
        get: (_, step) =>
          step === "then"
            ? (resolve: (rows: unknown[]) => void) => resolve(rows())
            : (...args: unknown[]) => {
                if (step === "set") sets.push(args[0] as Record<string, unknown>);
                return q;
              },
      },
    );
    return q;
  };
  return {
    agents: {},
    approvals: {},
    files: {},
    projects: {},
    runEvents: {},
    runs: {},
    tasks: {},
    db: { select: () => query(() => selects.shift() ?? [TASK]), update: () => query(() => []) },
  };
});
vi.mock("@abotica/db/orm", () => ({
  and: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  gte: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  ne: vi.fn(),
  or: vi.fn(),
}));
vi.mock("../../platform/audit", () => ({ audit: vi.fn() }));
vi.mock("../../files/files", () => ({ deleteFile: vi.fn(), readFileBytes: vi.fn(), saveFile: vi.fn() }));
vi.mock("../../models/provider-policy", () => ({}));
vi.mock("../model-chain", () => ({}));
vi.mock("../../runs/runs", () => ({ cancelRun: vi.fn() }));
vi.mock("../../tasks/delegation-slots", () => ({ startDelegatedTask: vi.fn(async () => ({ id: "run-2" })) }));
vi.mock("../../tasks/control", () => ({ pauseTask: vi.fn() }));
// The delegator controls project p1 only.
vi.mock("./control", () => ({ inControl: (_ctx: unknown, projectId: string | null) => projectId === "p1" }));
vi.mock("../../tasks/delegation", () => ({
  answersUser: vi.fn(async () => false),
  loadDelegationProject: vi.fn(),
  redelegateTask: vi.fn(),
}));
vi.mock("../../tasks/tasks", () => ({
  activeTaskRun: vi.fn(),
  createTask: vi.fn(),
  isActiveTaskRunConflict: () => false,
  pendingDependencies: async () => [],
  TaskCircuitOpenError: class extends Error {
    constructor(
      readonly taskId: string,
      readonly streak: unknown,
    ) {
      super("circuit open");
    }
  },
  taskFailureStreak: vi.fn(),
  TASK_PRIORITIES: ["low", "medium", "high", "urgent"],
  updateTask: vi.fn(),
}));
vi.mock("../../tasks/team-rules", () => ({
  checkDelegationTarget: () => ({ ok: true }),
  delegationProjectId: () => ({ ok: true, value: null }),
}));
vi.mock("./delegate-files", () => ({ planHandover: () => ({ save: [], replace: [], keep: [] }) }));
vi.mock("./withheld", () => ({ withhold: vi.fn(), withholdClosed: vi.fn() }));
vi.mock("./workspace", () => ({ readWorkspaceBytes: vi.fn() }));
vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared")>()),
  agentBySlug: async (slug: string) => [WORKER, OTHER].find((a) => a.slug === slug),
}));

const ctx = {
  run: { id: "manager-run", conversationId: "c1" },
  agent: { id: "manager", slug: "manager", kind: "manager" },
  managedProjectIds: [],
  projectId: null,
  settings: { agents: { maxRedelegations: 2 } },
};

const delegate = (agentSlug: string) => {
  const tool = runTools.delegate_task!(ctx as never);
  const input = { agentSlug, taskId: TASK.id, priority: "medium", dependsOnTaskIds: [], userAsked: false, files: [] };
  return tool.execute!(input, { toolCallId: "call_1", messages: [], context: {} }) as Promise<Record<string, unknown>>;
};

const AUTH_FAILURE = { failures: 1, reason: "All providers failed: anthropic/x: Provider not connected", open: true };

beforeEach(() => {
  vi.clearAllMocks();
  selects.length = 0;
  sets.length = 0;
  vi.mocked(activeTaskRun).mockResolvedValue(undefined);
  vi.mocked(taskFailureStreak).mockResolvedValue({ failures: 0, reason: null, open: false });
});

describe("delegate_task and the task's circuit breaker", () => {
  it("returns the circuit-open error without starting a run after the provider rejected the key", async () => {
    vi.mocked(taskFailureStreak).mockResolvedValue(AUTH_FAILURE);

    const result = await delegate("worker");

    expect(result.error).toContain("Task t1 is stopped: its last 1 run(s) failed (All providers failed");
    expect(result.error).toContain("only they can start it again");
    expect(startDelegatedTask).not.toHaveBeenCalled();
    // Nothing changed on the task either: the send-back is not counted.
    expect(redelegateTask).not.toHaveBeenCalled();
  });

  it("starts a task whose breaker is closed", async () => {
    expect(await delegate("worker")).toEqual({
      taskId: "t1",
      runId: "run-2",
      started: true,
      next: expect.stringMatching(/end your turn \(no task_wait/),
    });
    expect(startDelegatedTask).toHaveBeenCalledWith("t1", { parentRunId: "manager-run" });
  });

  it("hands the task to another agent, which starts a new count", async () => {
    vi.mocked(taskFailureStreak).mockResolvedValue(AUTH_FAILURE);
    expect(await delegate("other")).toMatchObject({ started: true });
    expect(taskFailureStreak).not.toHaveBeenCalled();
  });

  it("reports a breaker that opened while it was delegating", async () => {
    vi.mocked(startDelegatedTask).mockRejectedValueOnce(new TaskCircuitOpenError("t1", AUTH_FAILURE));
    expect((await delegate("worker")).error).toContain("Task t1 is stopped");
  });
});

describe("delegate_task sending a task back", () => {
  const sendBack = (maxRedelegations: number) => {
    const tool = runTools.delegate_task!({ ...ctx, settings: { agents: { maxRedelegations } } } as never);
    const input = {
      agentSlug: "worker",
      taskId: TASK.id,
      priority: "medium",
      dependsOnTaskIds: [],
      userAsked: false,
      files: [],
    };
    return tool.execute!(input, { toolCallId: "call_1", messages: [], context: {} }) as Promise<Record<string, unknown>>;
  };

  it("stops at the send-backs Settings allow (agents.maxRedelegations)", async () => {
    TASK.redelegations = 2;
    try {
      expect((await sendBack(2)).error).toContain("was already sent back 2 times");
      expect(redelegateTask).not.toHaveBeenCalled();
      expect(await sendBack(3)).toMatchObject({ started: true });
      expect(redelegateTask).toHaveBeenCalledOnce();
    } finally {
      TASK.redelegations = 0;
    }
  });
});

describe("delegate_task with every place of the conversation taken", () => {
  it("leaves the task waiting and tells the delegator it starts on its own", async () => {
    vi.mocked(startDelegatedTask).mockResolvedValueOnce(null);
    const result = await delegate("worker");
    expect(result).toMatchObject({ taskId: "t1", started: false });
    expect(result.queued).toContain("starts on its own when one of them finishes. Do not start it again.");
    expect(result.runId).toBeUndefined();
  });
});

describe("delegate_task from a run on a task of its own", () => {
  const delegateNew = (run: { id: string; conversationId: string; taskId?: string }) => {
    const tool = runTools.delegate_task!({ ...ctx, run } as never);
    const input = {
      agentSlug: "worker",
      title: "Draft the landing page",
      description: "Write the copy for the landing page.",
      priority: "medium",
      dependsOnTaskIds: [],
      userAsked: false,
      files: [],
    };
    return tool.execute!(input, { toolCallId: "call_1", messages: [], context: {} }) as Promise<Record<string, unknown>>;
  };

  beforeEach(() => vi.mocked(createTask).mockResolvedValue({ id: "t2" } as never));

  it("makes the new task a subtask of it, in the same project", async () => {
    // The own task (TASK) and the new one are both outside any project here.
    await delegateNew({ id: "manager-run", conversationId: "c1", taskId: "own-1" });
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ parentId: "own-1" }), expect.anything());
  });

  it("hands its own task on as a new subtask with the same brief, never reassigning it", async () => {
    const own = { ...TASK, id: "own-1", assigneeAgentId: "manager", title: "Name the bread line" };
    selects.push([{ ...own, description: "Ten names for the new bread line." }]);
    const tool = runTools.delegate_task!({ ...ctx, run: { ...ctx.run, taskId: "own-1" } } as never);
    const input = { agentSlug: "worker", taskId: "own-1", dependsOnTaskIds: [], userAsked: false, files: [] };
    const result = (await tool.execute!(input, { toolCallId: "call_1", messages: [], context: {} })) as Record<
      string,
      unknown
    >;

    expect(result.error).toBeUndefined();
    expect(redelegateTask).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Name the bread line",
        description: "Ten names for the new bread line.",
        assigneeAgentId: "worker",
      }),
      expect.anything(),
    );
  });

  it("leaves the parent out without a task of its own", async () => {
    await delegateNew({ id: "manager-run", conversationId: "c1" });
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ parentId: null }), expect.anything());
  });
});

describe("delegate_task's priority and the assignee's other work", () => {
  const delegateNew = (input: Record<string, unknown>, run: Record<string, unknown> = {}) => {
    const tool = runTools.delegate_task!({ ...ctx, run: { id: "manager-run", conversationId: "c1", ...run } } as never);
    const base = {
      agentSlug: "worker",
      title: "Fix the checkout",
      description: "The checkout page fails for every customer.",
      dependsOnTaskIds: [],
      userAsked: false,
      putAside: false,
      files: [],
    };
    return tool.execute!({ ...base, ...input }, { toolCallId: "call_1", messages: [], context: {} }) as Promise<
      Record<string, unknown>
    >;
  };

  beforeEach(() => {
    vi.mocked(createTask).mockImplementation(
      async (input) => ({ id: "t2", title: input.title, priority: input.priority }) as never,
    );
  });

  it("gives a new task the delegator's own task priority when none is asked", async () => {
    selects.push([{ projectId: null, priority: "high" }], []);
    await delegateNew({}, { taskId: "own-1" });
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ priority: "high" }), expect.anything());
  });

  it("falls back to medium outside a task of its own", async () => {
    await delegateNew({});
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ priority: "medium" }), expect.anything());
  });

  it("lists what the assignee is busy with when the work is urgent, without pausing anything", async () => {
    selects.push([{ taskId: "low-1", title: "Blog post", priority: "low", projectId: "p1", project: "Shop" }]);
    const result = await delegateNew({ priority: "urgent" });
    expect(result.assigneeBusy).toEqual([
      { taskId: "low-1", title: "Blog post", priority: "low", project: "Shop", controllable: true },
    ]);
    expect(pauseTask).not.toHaveBeenCalled();
  });

  it("with putAside pauses the lower-priority work it controls for the new task, and names the rest", async () => {
    selects.push([
      { taskId: "low-1", title: "Blog post", priority: "low", projectId: "p1", project: "Shop" },
      { taskId: "other-1", title: "Ads", priority: "medium", projectId: "p2", project: "Ads" },
      { taskId: "urgent-1", title: "Outage", priority: "urgent", projectId: "p1", project: "Shop" },
    ]);
    const result = await delegateNew({ priority: "urgent", putAside: true });
    expect(pauseTask).toHaveBeenCalledExactlyOnceWith("low-1", {
      by: { agentId: "manager" },
      reason: "it goes first",
      pausedForTaskId: "t2",
    });
    expect(result).toMatchObject({
      started: true,
      putAside: [{ taskId: "low-1", title: "Blog post" }],
      busyElsewhere: [{ taskId: "other-1", title: "Ads", project: "Ads" }],
      hint: expect.stringContaining("ask the super agent"),
      // What still runs next to it: the other project's work and the urgent work it does not outrank.
      assigneeBusy: [
        expect.objectContaining({ taskId: "other-1", controllable: false }),
        expect.objectContaining({ taskId: "urgent-1", controllable: true }),
      ],
    });
    // Paused before the new task starts.
    expect(vi.mocked(pauseTask).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(startDelegatedTask).mock.invocationCallOrder[0]!,
    );
  });

  it("groups the task's report with reportTogether", async () => {
    await delegateNew({ reportTogether: "launch" });
    expect(sets).toContainEqual({ reportGroup: "launch" });
  });
});
