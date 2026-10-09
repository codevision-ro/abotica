import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportTargetAgent } from "../../tasks/automation-target";
import { postInstruction } from "../../tasks/task-messages";
import { finishWithNothingNew, updateTask } from "../../tasks/tasks";
import { taskTools } from "./tasks";

/**
 * task_update on work a schedule or trigger fired (tasks.reportsUp): the assignee ends it with
 * nothingNew or sends it up with 'review'; only the agent above it marks it done. Its guards: a task put
 * aside changes only through task_control, a peer only comments, and an agent does not settle its own
 * task while work it delegated from the conversation is open. task_comment goes through postInstruction.
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
const PAUSED = { ...DELEGATED, id: "paused-1", status: "paused", pauseReason: "urgent work first" };
const OWN = { ...DELEGATED, id: "own-1", assigneeAgentId: "manager", delegatedByRunId: "super-run" };
const TASKS = [FIRED, DELEGATED, PAUSED, OWN];

/** What each table answers: the delegating run's agent, the project's manager, the open delegated work. */
const { answers } = vi.hoisted(() => ({ answers: { tasks: [] as unknown[] } }));
vi.mock("@abotica/db", () => {
  const select = () => {
    let table = "";
    const q = {
      from: (t: { name: string }) => ((table = t.name), q),
      innerJoin: () => q,
      where: async () =>
        table === "runs" ? [{ agentId: "boss" }] : table === "projects" ? [{ managerAgentId: "manager" }] : answers.tasks,
    };
    return q;
  };
  return {
    agents: { name: "agents" },
    projects: { name: "projects" },
    runs: { name: "runs" },
    taskComments: { name: "taskComments" },
    taskDependencies: { name: "taskDependencies" },
    tasks: { name: "tasks" },
    db: { select },
  };
});
vi.mock("../../tasks/task-messages", () => ({
  postInstruction: vi.fn(async () => ({ comment: { kind: "instruction" }, delivered: "steered", runId: "r9" })),
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

const contextOf = (agent: { id: string; kind: string }, taskId: string | null = null) => ({
  run: { id: `${agent.id}-run`, conversationId: "c1", taskId },
  agent: { ...agent, slug: agent.id },
  projectId: "p1",
});

const update = (agent: { id: string; kind: string }, input: Record<string, unknown>, taskId: string | null = null) =>
  taskTools.task_update!(contextOf(agent, taskId) as never).execute!(input as never, {
    toolCallId: "call_1",
    messages: [],
    context: {},
  }) as Promise<Record<string, unknown>>;

const WRITER = { id: "writer", kind: "specialist" };
const MANAGER = { id: "manager", kind: "manager" };

beforeEach(() => {
  vi.clearAllMocks();
  answers.tasks = [];
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

describe("task_update guards", () => {
  it("refuses changes on a task put aside, telling its assignee to end the turn", async () => {
    const own = await update(WRITER, { taskId: PAUSED.id, status: "review" });
    expect(own.error).toContain("put aside (urgent work first)");
    expect(own.error).toContain("End your turn");
    expect((await update(MANAGER, { taskId: PAUSED.id, priority: "high" })).error).toContain("task_control");
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("lets a peer only comment", async () => {
    const result = await update({ id: "peer", kind: "specialist" }, { taskId: DELEGATED.id, output: "My version" });
    expect(result.error).toContain("you can comment on it");
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("lets the delegator, the project's manager and the super agent edit", async () => {
    for (const agent of [{ id: "boss", kind: "manager" }, MANAGER, { id: "super", kind: "orchestrator" }]) {
      expect((await update(agent, { taskId: DELEGATED.id, priority: "high" })).error).toBeUndefined();
    }
    expect(updateTask).toHaveBeenCalledTimes(3);
  });

  it("refuses settling one's own task while delegated work is open, naming it", async () => {
    answers.tasks = [{ id: "sub-1", title: "Draft the copy", status: "in_progress" }];
    const result = await update(MANAGER, { taskId: OWN.id, status: "review", output: "All done" }, OWN.id);
    expect(result.error).toContain('"Draft the copy" (sub-1, in_progress)');
    expect(result.error).toContain("task_control");
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("lets one's own task settle once nothing delegated is open", async () => {
    expect(await update(MANAGER, { taskId: OWN.id, status: "review" }, OWN.id)).toMatchObject({ status: "review" });
  });
});

describe("task_comment", () => {
  it("goes through postInstruction and says what became of it", async () => {
    const result = await taskTools.task_comment!(contextOf(MANAGER) as never).execute!(
      { taskId: DELEGATED.id, body: "Use K names", deliver: "now" } as never,
      { toolCallId: "call_1", messages: [], context: {} },
    );
    expect(postInstruction).toHaveBeenCalledWith(
      DELEGATED.id,
      "Use K names",
      { agentId: "manager" },
      {
        deliver: "now",
        runId: "manager-run",
      },
    );
    expect(result).toEqual({ ok: true, kind: "instruction", delivered: "steered", runId: "r9" });
  });
});
