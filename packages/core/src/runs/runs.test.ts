import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeTaskRun, resetFixRounds, taskFailureStreak, TaskCircuitOpenError, updateTask } from "../tasks/tasks";
import { clearHeldReplies, countHeldReply, takeResumeRequest } from "./run-lifecycle";
import { loadUnsteeredMessages, markUndelivered } from "./run-messages";
import { holdStaleReply, type Run, startFollowUpIfQueued, startTaskRun } from "./runs";

/**
 * startTaskRun and the task's circuit breaker: refused while open, unless the user forces the start, which
 * also gives its pull requests their automatic fix rounds back.
 * After a run: the follow-up and the Telegram send gate, for messages the run did not take in.
 */

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
vi.mock("./run-lifecycle", () => ({
  clearHeldReplies: vi.fn(),
  countHeldReply: vi.fn(),
  takeResumeRequest: vi.fn(async () => false),
}));
vi.mock("./run-messages", () => ({ loadUnsteeredMessages: vi.fn(), markUndelivered: vi.fn() }));
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
    resetFixRounds: vi.fn(),
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

describe("startTaskRun and the pull requests' fix rounds", () => {
  it("resets them on the user's start: a person stepped in", async () => {
    await startPastBreaker({ force: true });
    expect(resetFixRounds).toHaveBeenCalledExactlyOnceWith("t1");
  });

  it("keeps them on an automatic start (a wake-up, a dependency, a delegation)", async () => {
    vi.mocked(taskFailureStreak).mockResolvedValue({ failures: 0, reason: null, open: false });
    await startPastBreaker();
    await startPastBreaker({ parentRunId: "manager-run" });
    expect(resetFixRounds).not.toHaveBeenCalled();
  });

  it("keeps them when the start is refused", async () => {
    vi.mocked(activeTaskRun).mockResolvedValue({ id: "r0" });
    await startPastBreaker({ force: true });
    expect(resetFixRounds).not.toHaveBeenCalled();
  });
});

const FINISHED = {
  id: "r1",
  agentId: "a1",
  conversationId: "c1",
  status: "succeeded",
  trigger: "telegram",
  startedAt: new Date("2026-10-08T10:00:00Z"),
} as Run;
const arrived = [
  {
    message: { id: "m2", role: "user" as const, parts: [{ type: "text" as const, text: "And add an index" }] },
    createdAt: new Date("2026-10-08T10:00:05Z"),
  },
];

describe("startFollowUpIfQueued", () => {
  it("starts none when the run took in every message sent meanwhile", async () => {
    vi.mocked(loadUnsteeredMessages).mockResolvedValue([]);
    expect(await startFollowUpIfQueued(FINISHED)).toBeNull();
    expect(loadUnsteeredMessages).toHaveBeenCalledWith("c1", FINISHED.startedAt);
    expect(takeResumeRequest).toHaveBeenCalledWith("c1");
  });
});

describe("holdStaleReply", () => {
  it("holds an answer the user wrote past and marks it undelivered", async () => {
    vi.mocked(loadUnsteeredMessages).mockResolvedValue(arrived);
    vi.mocked(countHeldReply).mockResolvedValue(1);
    expect(await holdStaleReply(FINISHED)).toBe(true);
    expect(markUndelivered).toHaveBeenCalledWith(FINISHED);
    expect(clearHeldReplies).not.toHaveBeenCalled();
  });

  it("holds twice in a row, then delivers the third answer whatever arrived", async () => {
    vi.mocked(loadUnsteeredMessages).mockResolvedValue(arrived);
    let held = 0;
    vi.mocked(countHeldReply).mockImplementation(async () => ++held);
    expect([await holdStaleReply(FINISHED), await holdStaleReply(FINISHED), await holdStaleReply(FINISHED)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(markUndelivered).toHaveBeenCalledTimes(2);
    expect(clearHeldReplies).toHaveBeenCalledExactlyOnceWith("c1");
  });

  it("delivers when nothing arrived, and clears the count", async () => {
    vi.mocked(loadUnsteeredMessages).mockResolvedValue([]);
    expect(await holdStaleReply(FINISHED)).toBe(false);
    expect(countHeldReply).not.toHaveBeenCalled();
    expect(clearHeldReplies).toHaveBeenCalledWith("c1");
  });

  it("does not hold for a delegation report alone: the user did not write", async () => {
    const report = {
      message: { id: "r1", role: "user" as const, parts: [], metadata: { kind: "delegation-report", tasks: [] } },
      createdAt: new Date("2026-10-08T10:00:06Z"),
    };
    vi.mocked(loadUnsteeredMessages).mockResolvedValue([report]);
    expect(await holdStaleReply(FINISHED)).toBe(false);
    expect(countHeldReply).not.toHaveBeenCalled();
    expect(markUndelivered).not.toHaveBeenCalled();
  });

  it("never holds a failure, a stop or a question for approval", async () => {
    for (const status of ["failed", "cancelled", "waiting_approval"] as const) {
      expect(await holdStaleReply({ ...FINISHED, status })).toBe(false);
    }
    expect(loadUnsteeredMessages).not.toHaveBeenCalled();
    expect(markUndelivered).not.toHaveBeenCalled();
  });
});
