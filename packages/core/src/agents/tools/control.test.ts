import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTask, pauseTask, redirectTask, resumeTask } from "../../tasks/control";
import { teamStatus } from "../../tasks/team-status";
import { controlTools } from "./control";

/**
 * task_control reaches only tasks the run may control (a manager: the projects it leads, never its own
 * task) and maps each action onto tasks/control.ts; team_status reads the projects the run sees and
 * withholds the content of closed ones.
 */

const { rows } = vi.hoisted(() => ({ rows: [] as unknown[][] }));

vi.mock("@abotica/db", () => {
  const q: object = new Proxy(
    {},
    { get: (_, step) => (step === "then" ? (resolve: (r: unknown[]) => void) => resolve(rows.shift() ?? []) : () => q) },
  );
  return { db: { select: () => q }, projects: {}, tasks: {} };
});
vi.mock("@abotica/db/orm", () => ({ eq: vi.fn() }));
vi.mock("../../tasks/control", () => ({
  cancelTask: vi.fn(async () => ({ cancelled: ["t1", "t2"] })),
  pauseTask: vi.fn(async () => ({ status: "paused" })),
  redirectTask: vi.fn(async () => ({ status: "backlog", priority: "high", deadline: null })),
  resumeTask: vi.fn(async () => ({ task: { status: "in_progress" }, run: { id: "run-2" } })),
}));
vi.mock("../../tasks/team-status", () => ({ TEAM_STATUS_LIMIT: 100, teamStatus: vi.fn(async () => []) }));
vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared")>()),
  agentBySlug: async (slug: string) => (slug === "rita" ? { id: "rita-id", slug: "rita" } : undefined),
  closedProjects: async () => new Set(["closed"]),
}));

const manager = (over: Record<string, unknown> = {}) => ({
  agent: { id: "manager", kind: "manager" },
  run: { id: "run-1", taskId: "own" },
  projectId: null,
  managedProjectIds: ["p1", "closed"],
  ...over,
});
const call = (name: string, input: Record<string, unknown>, ctx = manager()) =>
  controlTools[name]!(ctx as never).execute!(input, { toolCallId: "c", messages: [], context: {} }) as Promise<
    Record<string, unknown>
  >;
const inP1 = (id = "t1") => [{ task: { id, projectId: "p1" }, managerAgentId: "manager" }];

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
});

describe("task_control", () => {
  it("pauses a task in a project the manager leads", async () => {
    rows.push(inP1());
    expect(await call("task_control", { taskId: "t1", action: "pause", reason: "urgent work", cascade: true })).toEqual({
      taskId: "t1",
      status: "paused",
      next: expect.stringContaining("resume it with task_control"),
    });
    expect(pauseTask).toHaveBeenCalledWith("t1", { by: { agentId: "manager" }, reason: "urgent work" });
  });

  it("refuses a task of a project led by someone else, and the run's own task", async () => {
    rows.push([{ task: { id: "t1", projectId: "p2" }, managerAgentId: "other" }]);
    expect((await call("task_control", { taskId: "t1", action: "pause", reason: "x" })).error).toContain(
      "not in a project you lead",
    );
    rows.push(inP1("own"));
    expect((await call("task_control", { taskId: "own", action: "cancel", reason: "x" })).error).toContain("your own task");
    // Inside a project, only that project's tasks.
    rows.push(inP1());
    const inOther = manager({ projectId: "closed" });
    expect((await call("task_control", { taskId: "t1", action: "pause", reason: "x" }, inOther)).error).toBeDefined();
    expect(pauseTask).not.toHaveBeenCalled();
  });

  it("lets the super agent control any task", async () => {
    rows.push([{ task: { id: "t1", projectId: null }, managerAgentId: null }]);
    const orchestrator = manager({ agent: { id: "super", kind: "orchestrator" }, managedProjectIds: [] });
    await call("task_control", { taskId: "t1", action: "cancel", reason: "dropped", cascade: false }, orchestrator);
    expect(cancelTask).toHaveBeenCalledWith("t1", { by: { agentId: "super" }, reason: "dropped", cascade: false });
  });

  it("resumes with the reason as the note and more continuations", async () => {
    rows.push(inP1());
    expect(
      await call("task_control", { taskId: "t1", action: "resume", reason: "go on", extraContinuations: 2 }),
    ).toMatchObject({ status: "in_progress", runId: "run-2" });
    expect(resumeTask).toHaveBeenCalledWith("t1", { by: { agentId: "manager" }, note: "go on", extraContinuations: 2 });
  });

  it("redirects to another agent by slug, and needs something to change", async () => {
    rows.push(inP1());
    expect((await call("task_control", { taskId: "t1", action: "redirect", reason: "x" })).error).toContain(
      "Say what changes",
    );
    rows.push(inP1());
    await call("task_control", {
      taskId: "t1",
      action: "redirect",
      reason: "faster",
      reassignTo: "rita",
      priority: "high",
    });
    expect(redirectTask).toHaveBeenCalledWith("t1", {
      by: { agentId: "manager" },
      reason: "faster",
      instructions: undefined,
      reassignTo: "rita-id",
      priority: "high",
      deadline: undefined,
    });
    rows.push(inP1());
    expect(
      (await call("task_control", { taskId: "t1", action: "redirect", reason: "x", reassignTo: "nobody" })).error,
    ).toContain("does not exist");
  });
});

describe("team_status", () => {
  it("reads the projects the manager leads and withholds the progress of closed ones", async () => {
    vi.mocked(teamStatus).mockResolvedValueOnce([
      { id: "t1", projectId: "p1", lastProgress: { text: "half done" } },
      { id: "t2", projectId: "closed", lastProgress: { text: "secret" } },
    ] as never);
    const result = (await call("team_status", { includeDone: false })) as { tasks: { lastProgress: unknown }[] };
    expect(teamStatus).toHaveBeenCalledWith({ projectIds: ["p1", "closed"] }, { includeDone: false });
    expect(result.tasks[0]!.lastProgress).toEqual({ text: "half done" });
    expect(result.tasks[1]!.lastProgress).toMatch(/^Withheld/);
  });

  it("refuses a project the manager does not lead; the super agent reads every project", async () => {
    expect((await call("team_status", { projectId: "11111111-1111-4111-8111-111111111111" })).error).toContain(
      "not one you lead",
    );
    await call("team_status", {}, manager({ agent: { id: "super", kind: "orchestrator" } }));
    expect(teamStatus).toHaveBeenCalledWith({ projectIds: undefined }, { includeDone: undefined });
  });
});
