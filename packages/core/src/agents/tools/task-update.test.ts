import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportTargetAgent } from "../../tasks/automation-target";
import { finishWithNothingNew, updateTask } from "../../tasks/tasks";
import { taskTools } from "./tasks";

/**
 * task_update on work a schedule or trigger fired (tasks.reportsUp): the assignee ends it with
 * nothingNew or sends it up with 'review'; only the agent above it marks it done.
 */

const FIRED = {
  id: "fired-1",
  title: "Weekly audit",
  assigneeAgentId: "writer",
  status: "in_progress",
  projectId: "p1",
  reportsUp: true,
  delegatedByRunId: null as string | null,
};
const DELEGATED = { ...FIRED, id: "delegated-1", reportsUp: false, delegatedByRunId: "boss-run" };
const TASKS = [FIRED, DELEGATED];

vi.mock("@abotica/db", () => ({
  agents: {},
  runs: {},
  taskComments: {},
  taskDependencies: {},
  tasks: {},
  db: { select: () => ({ from: () => ({ where: async () => [{ agentId: "boss" }] }) }) },
}));
vi.mock("../../platform/audit", () => ({ audit: vi.fn() }));
vi.mock("../../files/files", () => ({ listFiles: vi.fn() }));
vi.mock("../../tasks/pull-requests", () => ({ listTaskPullRequests: vi.fn(async () => []) }));
vi.mock("../../tasks/wakeups", () => ({ armWakeup: vi.fn(), listTaskWakeups: vi.fn() }));
vi.mock("../../tasks/automation-target", () => ({ reportTargetAgent: vi.fn() }));
vi.mock("../../tasks/tasks", () => ({
  activeTaskRun: vi.fn(),
  addTaskComment: vi.fn(),
  awaitingReportTo: vi.fn(),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  finishWithNothingNew: vi.fn(async (id: string) => ({ ...TASKS.find((t) => t.id === id)!, status: "done" })),
  TASK_PRIORITIES: ["low", "medium", "high", "urgent"],
  TASK_STATUSES: ["backlog", "in_progress", "blocked", "review", "done"],
  updateTask: vi.fn(async (id: string, patch: object) => ({ ...TASKS.find((t) => t.id === id)!, ...patch })),
}));
vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared")>()),
  visibleTask: async (_ctx: unknown, id: string) => TASKS.find((t) => t.id === id) ?? { error: "not found" },
}));

const contextOf = (agent: { id: string; kind: string }) => ({
  run: { id: `${agent.id}-run`, conversationId: "c1", taskId: null },
  agent: { ...agent, slug: agent.id },
  projectId: "p1",
});

const update = (agent: { id: string; kind: string }, input: Record<string, unknown>) =>
  taskTools.task_update!(contextOf(agent) as never).execute!(input as never, {
    toolCallId: "call_1",
    messages: [],
    context: {},
  }) as Promise<Record<string, unknown>>;

const WRITER = { id: "writer", kind: "specialist" };
const MANAGER = { id: "manager", kind: "manager" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reportTargetAgent).mockResolvedValue({ agent: { id: "manager" } as never, target: "manager" });
});

describe("task_update with nothingNew", () => {
  it("ends fired work as done without a report", async () => {
    const result = await update(WRITER, { taskId: FIRED.id, nothingNew: true, output: "No change this week." });
    expect(finishWithNothingNew).toHaveBeenCalledWith(FIRED.id, "No change this week.", "agent:writer");
    expect(result).toMatchObject({ id: FIRED.id, status: "done" });
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("is refused on a delegated task", async () => {
    const result = await update(WRITER, { taskId: DELEGATED.id, nothingNew: true });
    expect(result.error).toContain("schedule or trigger");
    expect(finishWithNothingNew).not.toHaveBeenCalled();
  });

  it("is refused with a status other than done", async () => {
    const result = await update(WRITER, { taskId: FIRED.id, nothingNew: true, status: "blocked" });
    expect(result.error).toContain("leave out status");
    expect(finishWithNothingNew).not.toHaveBeenCalled();
  });
});

describe("task_update done on fired work", () => {
  it("is refused to the assignee: the result goes up", async () => {
    const result = await update(WRITER, { taskId: FIRED.id, status: "done" });
    expect(result.error).toContain("goes up on its own");
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("is allowed to the agent above it", async () => {
    expect(await update(MANAGER, { taskId: FIRED.id, status: "done" })).toMatchObject({ status: "done" });
  });

  it("is allowed to the super agent", async () => {
    vi.mocked(reportTargetAgent).mockResolvedValue({ agent: { id: "manager" } as never, target: "manager" });
    expect(await update({ id: "super", kind: "orchestrator" }, { taskId: FIRED.id, status: "done" })).toMatchObject({
      status: "done",
    });
    expect(reportTargetAgent).not.toHaveBeenCalled();
  });

  it("keeps the delegator's rule for delegated work", async () => {
    expect((await update(WRITER, { taskId: DELEGATED.id, status: "done" })).error).toContain("delegated to you");
    expect(await update({ id: "boss", kind: "manager" }, { taskId: DELEGATED.id, status: "done" })).toMatchObject({
      status: "done",
    });
  });
});
