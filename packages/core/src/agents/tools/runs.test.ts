import { beforeEach, describe, expect, it, vi } from "vitest";
import { redelegateTask } from "../../tasks/delegation";
import { activeTaskRun, taskFailureStreak, TaskCircuitOpenError } from "../../tasks/tasks";
import { startDelegatedTask } from "../../tasks/delegation-slots";
import { runTools } from "./runs";

/**
 * delegate_task on a task whose runs keep failing: the delegator gets the error as data, no run starts.
 * With every place of its conversation taken, the task waits and the delegator is told it starts on its own.
 */

const TASK = { id: "t1", assigneeAgentId: "worker", projectId: null, redelegations: 0 };
const WORKER = { id: "worker", slug: "worker", isTemplate: false, enabled: true };
const OTHER = { id: "other", slug: "other", isTemplate: false, enabled: true };

vi.mock("@abotica/db", () => ({
  agents: {},
  approvals: {},
  files: {},
  runEvents: {},
  runs: {},
  tasks: {},
  db: { select: () => ({ from: () => ({ where: async () => [TASK] }) }) },
}));
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
vi.mock("../../tasks/delegation", () => ({
  answersUser: vi.fn(async () => false),
  loadDelegationProject: vi.fn(),
  MAX_REDELEGATIONS: 2,
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
  agent: { id: "manager", slug: "manager", isOrchestrator: false },
  managedProjectIds: [],
  projectId: null,
};

const delegate = (agentSlug: string) => {
  const tool = runTools.delegate_task!(ctx as never);
  const input = { agentSlug, taskId: TASK.id, priority: "medium", dependsOnTaskIds: [], userAsked: false, files: [] };
  return tool.execute!(input, { toolCallId: "call_1", messages: [], context: {} }) as Promise<Record<string, unknown>>;
};

const AUTH_FAILURE = { failures: 1, reason: "All providers failed: anthropic/x: Provider not connected", open: true };

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(await delegate("worker")).toEqual({ taskId: "t1", runId: "run-2", started: true });
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

describe("delegate_task with every place of the conversation taken", () => {
  it("leaves the task waiting and tells the delegator it starts on its own", async () => {
    vi.mocked(startDelegatedTask).mockResolvedValueOnce(null);
    const result = await delegate("worker");
    expect(result).toMatchObject({ taskId: "t1", started: false });
    expect(result.queued).toContain("starts on its own when one of them finishes. Do not start it again.");
    expect(result.runId).toBeUndefined();
  });
});
