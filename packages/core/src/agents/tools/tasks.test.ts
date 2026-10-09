import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitingReportTo } from "../../tasks/tasks";
import { armWakeup } from "../../tasks/wakeups";
import { taskTools } from "./tasks";

/**
 * task_wait on work the agent delegated: its result already comes back as a delegation report, so a
 * wakeup would process it a second time in a new conversation. The wait is refused and nothing is set.
 */

const OWN = { id: "own-1", assigneeAgentId: "manager", status: "in_progress", projectId: "p1" };
const SUBTASK = { id: "sub-1", assigneeAgentId: "writer", status: "in_progress", projectId: "p1" };

const { subtasks } = vi.hoisted(() => ({ subtasks: [] as { id: string; status: string }[] }));
vi.mock("@abotica/db", () => ({
  agents: {},
  runs: {},
  taskComments: {},
  taskDependencies: {},
  tasks: {},
  db: {
    select: () => ({
      from: () => ({ where: async () => subtasks, innerJoin: () => ({ where: async () => subtasks }) }),
    }),
  },
}));
vi.mock("../../tasks/task-messages", () => ({
  postInstruction: vi.fn(async () => ({ comment: { kind: "note" }, delivered: "stored" })),
}));
vi.mock("../../platform/audit", () => ({ audit: vi.fn() }));
vi.mock("../../files/files", () => ({ listFiles: vi.fn() }));
vi.mock("../../tasks/pull-requests", () => ({ listTaskPullRequests: vi.fn(async () => []) }));
vi.mock("../../tasks/wakeups", () => ({
  armWakeup: vi.fn(async () => ({ id: "w1", kind: "task_status", nextCheckAt: null, expiresAt: null, maxFires: 1 })),
  listTaskWakeups: vi.fn(),
}));
vi.mock("../../tasks/tasks", () => ({
  activeTaskRun: vi.fn(),
  addTaskComment: vi.fn(),
  awaitingReportTo: vi.fn(),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  TASK_PRIORITIES: ["low", "medium", "high", "urgent"],
  TASK_STATUSES: ["backlog", "in_progress", "blocked", "review", "done"],
  updateTask: vi.fn(),
}));
vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared")>()),
  visibleTask: async (_ctx: unknown, id: string) => [OWN, SUBTASK].find((t) => t.id === id) ?? { error: "not found" },
}));

const ctx = {
  run: { id: "manager-run", conversationId: "c1", taskId: OWN.id },
  agent: { id: "manager", slug: "manager", kind: "manager" },
  projectId: "p1",
};

const wait = (input: Record<string, unknown>) => {
  const tool = taskTools.task_wait!(ctx as never);
  return tool.execute!({ repeat: false, notes: "", ...input } as never, {
    toolCallId: "call_1",
    messages: [],
    context: {},
  }) as Promise<Record<string, unknown>>;
};

beforeEach(() => {
  vi.clearAllMocks();
  subtasks.length = 0;
  vi.mocked(awaitingReportTo).mockImplementation(async (_agent, ids) => ids);
});

describe("task_wait on delegated work", () => {
  it("refuses waiting for a delegated task to settle: the report brings it back", async () => {
    const result = await wait({ kind: "task_status", watchTaskId: SUBTASK.id, status: "review" });
    expect(result.error).toContain("comes back to you automatically as a notice");
    expect(awaitingReportTo).toHaveBeenCalledWith("manager", [SUBTASK.id]);
    expect(armWakeup).not.toHaveBeenCalled();
  });

  it("waits on a task whose result does not come back to this agent", async () => {
    vi.mocked(awaitingReportTo).mockResolvedValue([]);
    expect(await wait({ kind: "task_status", watchTaskId: SUBTASK.id, status: "review" })).toMatchObject({ ok: true });
    expect(armWakeup).toHaveBeenCalledOnce();
  });

  it("waits for a status the report does not carry", async () => {
    expect(await wait({ kind: "task_status", watchTaskId: SUBTASK.id, status: "in_progress" })).toMatchObject({
      ok: true,
    });
  });

  it("refuses waiting for subtasks that all come back as reports", async () => {
    subtasks.push({ id: "sub-1", status: "in_progress" }, { id: "sub-2", status: "done" });
    expect((await wait({ kind: "subtasks_done" })).error).toContain("comes back to you automatically");
    expect(awaitingReportTo).toHaveBeenCalledWith("manager", ["sub-1"]);
    expect(armWakeup).not.toHaveBeenCalled();
  });

  it("waits for subtasks when one of them is not delegated by this agent", async () => {
    subtasks.push({ id: "sub-1", status: "in_progress" }, { id: "mine", status: "backlog" });
    vi.mocked(awaitingReportTo).mockResolvedValue(["sub-1"]);
    expect(await wait({ kind: "subtasks_done" })).toMatchObject({ ok: true });
  });
});

describe("task_comment on its own task", () => {
  const comment = (taskId: string) => {
    const tool = taskTools.task_comment!(ctx as never);
    return tool.execute!({ taskId, body: "Every name must start with K.", deliver: "now" } as never, {
      toolCallId: "call_1",
      messages: [],
      context: {},
    }) as Promise<Record<string, unknown>>;
  };

  it("says the agents working on its subtasks do not see it, and where they read", async () => {
    subtasks.push({ taskId: SUBTASK.id, title: "Ten names", assignee: "writer" } as never);
    const result = await comment(OWN.id);
    expect(result.next).toContain("do not see it");
    expect(result.subtasks).toEqual([{ taskId: SUBTASK.id, title: "Ten names", assignee: "writer" }]);
  });

  it("adds nothing on a task with nobody working under it", async () => {
    expect((await comment(OWN.id)).next).toBeUndefined();
  });
});
