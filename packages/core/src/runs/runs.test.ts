import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeTaskRun, taskFailureStreak, TaskCircuitOpenError, updateTask } from "../tasks/tasks";
import { startTaskRun } from "./runs";

/** startTaskRun and the task's circuit breaker: refused while open, unless the user forces the start. */

const TASK = { id: "t1", assigneeAgentId: "a1", projectId: null, title: "Write the report" };

vi.mock("@abotica/db", () => ({
  agents: {},
  conversations: {},
  db: { select: () => ({ from: () => ({ where: async () => [TASK] }) }) },
  messages: {},
  runs: {},
  taskComments: {},
  taskDependencies: {},
  tasks: {},
}));
vi.mock("@abotica/db/orm", () => ({ and: vi.fn(), asc: vi.fn(), eq: vi.fn(), gt: vi.fn(), inArray: vi.fn() }));
vi.mock("../infra/events", () => ({ publish: vi.fn() }));
vi.mock("../infra/queues", () => ({ enqueueRun: vi.fn() }));
vi.mock("../files/files", () => ({ listFiles: vi.fn() }));
vi.mock("./run-lifecycle", () => ({}));
vi.mock("./conversations", () => ({ createConversation: vi.fn() }));
vi.mock("../tasks/tasks", async () => {
  const { UserError } = await import("@abotica/i18n");
  class TaskCircuitOpenError extends UserError {
    constructor(
      readonly taskId: string,
      readonly streak: { failures: number; reason: string | null },
    ) {
      super("tasks.errors.circuitOpen", { failures: streak.failures, reason: streak.reason ?? "-" });
    }
  }
  return {
    activeTaskRun: vi.fn(),
    assertTaskDependenciesDone: vi.fn(),
    isActiveTaskRunConflict: () => false,
    TaskBusyError: class extends Error {},
    TaskCircuitOpenError,
    taskFailureStreak: vi.fn(),
    updateTask: vi.fn(),
  };
});

/** Past the breaker the task moves to in progress; the brief and the run after it are not mocked here. */
const startPastBreaker = (opts?: Parameters<typeof startTaskRun>[1]) => startTaskRun("t1", opts).catch(() => null);

const OPEN = { failures: 1, reason: "All providers failed: anthropic/x: Provider not connected", open: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(activeTaskRun).mockResolvedValue(undefined);
  vi.mocked(taskFailureStreak).mockResolvedValue(OPEN);
});

describe("startTaskRun with the circuit breaker open", () => {
  it("refuses delegations and dependents before the task changes", async () => {
    const started = startTaskRun("t1", { parentRunId: "manager-run" });
    await expect(started).rejects.toBeInstanceOf(TaskCircuitOpenError);
    await expect(started).rejects.toThrow(
      "The last run of this task failed (All providers failed: anthropic/x: Provider not connected), so it does not start again on its own.",
    );
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("lets the user's forced start through", async () => {
    await startPastBreaker({ force: true });
    expect(taskFailureStreak).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith("t1", { status: "in_progress" }, "system");
  });

  it("starts a task whose breaker is closed", async () => {
    vi.mocked(taskFailureStreak).mockResolvedValue({ failures: 2, reason: "Loop", open: false });
    await startPastBreaker();
    expect(updateTask).toHaveBeenCalledWith("t1", { status: "in_progress" }, "system");
  });
});
