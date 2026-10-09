import { beforeEach, describe, expect, it, vi } from "vitest";
import { addProjectMembers } from "../../projects/projects";
import { deliverToSuperior } from "../../runs/deliver";
import { loadDelegationProject } from "../../tasks/delegation";
import { startDelegatedTask } from "../../tasks/delegation-slots";
import { createTask } from "../../tasks/tasks";
import type { RunContext } from "../context";
import { helpTitle, peerTools } from "./peers";
import { readHandover, storeHandover } from "./runs";
import { agentBySlug, closedProjects } from "./shared";

/**
 * The team tools on a fake database: ask_colleague turns a question into a help task under the asker's
 * own, team_add changes only the team of a project the manager leads, work_in_project gives the super
 * agent a task of its own in the project. What they start and deliver goes through mocked modules.
 */

const TABLES = vi.hoisted(() => ({ tasks: { name: "tasks" }, projects: { name: "projects" } }));
const state = vi.hoisted(() => ({
  tasks: [] as Record<string, unknown>[],
  projects: [] as Record<string, unknown>[],
  openHelp: 0,
}));

vi.mock("@abotica/db", () => ({
  agents: {},
  tasks: TABLES.tasks,
  projects: TABLES.projects,
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: async () =>
          fields && "open" in fields ? [{ open: state.openHelp }] : table === TABLES.tasks ? state.tasks : state.projects,
      }),
    }),
  },
}));
vi.mock("@abotica/db/orm", () => ({ and: vi.fn(), count: vi.fn(), eq: vi.fn(), isNull: vi.fn() }));
vi.mock("../../models/provider-policy", () => ({}));
vi.mock("../model-chain", () => ({}));
vi.mock("../../settings/settings", () => ({ settingsLocale: () => "en" }));
vi.mock("../../projects/projects", () => ({ addProjectMembers: vi.fn(async () => ["d"]) }));
vi.mock("../../runs/deliver", () => ({ deliverToSuperior: vi.fn(async () => ({ result: "stored" })) }));
vi.mock("../../tasks/delegation", () => ({ loadDelegationProject: vi.fn() }));
vi.mock("../../tasks/delegation-slots", () => ({ startDelegatedTask: vi.fn(async () => ({ id: "run-help" })) }));
vi.mock("../../tasks/tasks", () => ({ createTask: vi.fn(async () => ({ id: "help-1" })) }));
vi.mock("./runs", () => ({ readHandover: vi.fn(async () => []), storeHandover: vi.fn() }));
vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared")>()),
  agentBySlug: vi.fn(),
  closedProjects: vi.fn(async () => new Set()),
}));

const call = { toolCallId: "call-1", messages: [], context: {} };

const PROJECT = { id: "p1", name: "Crumb", managerAgentId: "m", managerSlug: "manager", memberIds: ["w", "r", "m"] };
const WRITER_TASK = {
  id: "t1",
  title: "Write the opening hours page",
  kind: "work",
  projectId: "p1",
  priority: "high",
};
const RESEARCHER = {
  id: "r",
  slug: "researcher",
  name: "Researcher",
  kind: "specialist",
  enabled: true,
  isTemplate: false,
};

const writerCtx = (taskId: string | null = "t1") =>
  ({
    run: { id: "run-w", taskId },
    agent: { id: "w", slug: "writer", name: "Writer", kind: "specialist" },
    project: null,
    projectId: "p1",
    managedProjectIds: [],
    settings: {},
  }) as unknown as RunContext;

beforeEach(() => {
  vi.clearAllMocks();
  state.tasks = [WRITER_TASK];
  state.projects = [];
  state.openHelp = 0;
  vi.mocked(loadDelegationProject).mockResolvedValue(PROJECT);
  vi.mocked(agentBySlug).mockResolvedValue(RESEARCHER as never);
});

async function ask(ctx: RunContext, input: { agentSlug?: string; question?: string; files?: string[] } = {}) {
  const tool = peerTools.ask_colleague!(ctx);
  return (await tool.execute!(
    { agentSlug: "researcher", question: "What are Crumb's opening hours?", files: [], ...input },
    call,
  )) as Record<string, unknown>;
}

describe("ask_colleague", () => {
  it("creates a help task under the asker's task and starts it in the asker's places", async () => {
    const result = await ask(writerCtx());
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Help: What are Crumb's opening hours?",
        description: expect.stringContaining('Writer (writer) on Crumb asks for your help with their task "Write the'),
        projectId: "p1",
        parentId: "t1",
        priority: "high",
        assigneeAgentId: "r",
        delegatedByRunId: "run-w",
        kind: "help",
      }),
      "agent:writer",
    );
    expect(startDelegatedTask).toHaveBeenCalledWith("help-1", { parentRunId: "run-w", reason: "help" });
    expect(result).toEqual({
      taskId: "help-1",
      colleague: "researcher",
      started: true,
      next: expect.stringMatching(/comes back here as a notice/),
    });
  });

  it("tells whoever gave the asker its task, without waking them, with the question as data", async () => {
    await ask(writerCtx());
    expect(deliverToSuperior).toHaveBeenCalledWith(
      "t1",
      {
        kind: "progress",
        from: "Writer",
        text: expect.stringMatching(
          /^Asked Researcher \(researcher\) for help, as help task help-1\. The question:\n<untrusted-data id="[0-9a-f]+"/,
        ),
      },
      { wake: "never" },
    );
  });

  it("keeps the help going when the notice to the superior fails", async () => {
    vi.mocked(deliverToSuperior).mockRejectedValueOnce(new Error("down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await ask(writerCtx())).toMatchObject({ taskId: "help-1", started: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("hands over the files it names, stored for the help task, and says when it waits for a place", async () => {
    const file = { path: "notes/hours.md", name: "hours.md", data: new Uint8Array([1]) };
    vi.mocked(readHandover).mockResolvedValueOnce([file]);
    vi.mocked(startDelegatedTask).mockResolvedValueOnce(null);
    const result = await ask(writerCtx(), { files: ["notes/hours.md"] });
    expect(storeHandover).toHaveBeenCalledWith(expect.anything(), "help-1", { save: [file], replace: [], keep: [] });
    expect(result).toMatchObject({ started: false, files: ["hours.md"] });
  });

  it("asks nothing when a file cannot be read", async () => {
    vi.mocked(readHandover).mockResolvedValueOnce({ error: "notes/x.md does not exist. Nothing was delegated." });
    expect(await ask(writerCtx(), { files: ["notes/x.md"] })).toEqual({
      error: "notes/x.md does not exist. Nothing was delegated.",
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("refuses outside a task, from a help task, to someone off the team and past the open help limit", async () => {
    expect(await ask(writerCtx(null))).toEqual({ error: expect.stringMatching(/only while working on a task/) });

    state.tasks = [{ ...WRITER_TASK, kind: "help" }];
    expect(await ask(writerCtx())).toEqual({ error: expect.stringMatching(/answering a colleague's question/) });

    state.tasks = [WRITER_TASK];
    vi.mocked(agentBySlug).mockResolvedValueOnce({ ...RESEARCHER, id: "x", slug: "outsider" } as never);
    expect(await ask(writerCtx(), { agentSlug: "outsider" })).toEqual({
      error: expect.stringMatching(/^outsider is not a specialist on the Crumb team/),
    });

    vi.mocked(agentBySlug).mockResolvedValueOnce(undefined);
    expect(await ask(writerCtx(), { agentSlug: "nobody" })).toEqual({
      error: expect.stringMatching(/^Agent nobody does not exist/),
    });

    state.openHelp = 2;
    expect(await ask(writerCtx())).toEqual({ error: expect.stringMatching(/already waits for 2 colleagues' answers/) });
    expect(createTask).not.toHaveBeenCalled();
    expect(startDelegatedTask).not.toHaveBeenCalled();
  });
});

describe("helpTitle", () => {
  const prefix = (q: string) => `Help: ${q}`;

  it("keeps a short question whole, on one line", () => {
    expect(helpTitle(prefix, "  What are\nthe hours? ")).toBe("Help: What are the hours?");
  });

  it("cuts a long question at a word", () => {
    const title = helpTitle(prefix, `${"word ".repeat(30)}end`);
    expect(title).toBe(`Help: ${"word ".repeat(12).trimEnd()}...`);
  });
});

const managerCtx = (over: Partial<RunContext> = {}) =>
  ({
    run: { id: "run-m", taskId: null },
    agent: { id: "m", slug: "manager", name: "Manager", kind: "manager" },
    project: null,
    projectId: null,
    managedProjectIds: ["p1", "p2"],
    ...over,
  }) as unknown as RunContext;

const DESIGNER = { id: "d", slug: "designer", name: "Designer", kind: "specialist", enabled: true, isTemplate: false };

async function teamAdd(ctx: RunContext, input: { agentSlug?: string; projectId?: string } = {}) {
  return (await peerTools.team_add!(ctx).execute!({ agentSlug: "designer", ...input }, call)) as Record<string, unknown>;
}

describe("team_add", () => {
  beforeEach(() => vi.mocked(agentBySlug).mockResolvedValue(DESIGNER as never));

  it("adds a specialist to the team of the run's project, as the manager", async () => {
    expect(await teamAdd(managerCtx({ projectId: "p1" }))).toEqual({
      agentSlug: "designer",
      projectId: "p1",
      added: true,
      next: "You can delegate to it now.",
    });
    expect(addProjectMembers).toHaveBeenCalledWith("p1", ["d"], { actor: "agent:manager" });
  });

  it("says so when the specialist was already on the team", async () => {
    vi.mocked(addProjectMembers).mockResolvedValueOnce([]);
    expect(await teamAdd(managerCtx(), { projectId: "p2" })).toMatchObject({ added: false, projectId: "p2" });
  });

  it("changes only a project it leads, and inside a project only that one", async () => {
    expect(await teamAdd(managerCtx())).toEqual({
      error: expect.stringMatching(/projectId of a project you lead \(p1, p2\)/),
    });
    expect(await teamAdd(managerCtx({ projectId: "p1" }), { projectId: "p2" })).toEqual({
      error: "You can change only the team of the project of this run.",
    });
    expect(await teamAdd(managerCtx(), { projectId: "p3" })).toEqual({ error: "You do not lead project p3." });
    expect(addProjectMembers).not.toHaveBeenCalled();
  });

  it("refuses what cannot join a team: managers, disabled agents, templates and unknown slugs", async () => {
    const ctx = managerCtx({ projectId: "p1" });
    vi.mocked(agentBySlug).mockResolvedValueOnce({ ...DESIGNER, kind: "manager" } as never);
    expect(await teamAdd(ctx)).toEqual({ error: expect.stringMatching(/not a specialist/) });
    vi.mocked(agentBySlug).mockResolvedValueOnce({ ...DESIGNER, enabled: false } as never);
    expect(await teamAdd(ctx)).toEqual({ error: expect.stringMatching(/is disabled/) });
    vi.mocked(agentBySlug).mockResolvedValueOnce({ ...DESIGNER, isTemplate: true } as never);
    expect(await teamAdd(ctx)).toEqual({ error: expect.stringMatching(/does not exist/) });
    vi.mocked(agentBySlug).mockResolvedValueOnce(undefined);
    expect(await teamAdd(ctx)).toEqual({ error: expect.stringMatching(/does not exist/) });
    expect(addProjectMembers).not.toHaveBeenCalled();
  });
});

const superCtx = (over: Partial<RunContext> = {}) =>
  ({
    run: { id: "run-s", taskId: null },
    agent: { id: "s", slug: "super", name: "Super", kind: "orchestrator" },
    project: null,
    projectId: null,
    managedProjectIds: [],
    ...over,
  }) as unknown as RunContext;

async function workIn(ctx: RunContext, projectId = "p1") {
  return (await peerTools.work_in_project!(ctx).execute!(
    { projectId, title: "Check the build script", brief: "Read package.json and say which build script runs." },
    call,
  )) as Record<string, unknown>;
}

describe("work_in_project", () => {
  beforeEach(() => {
    state.projects = [{ id: "p1", name: "Crumb", status: "active" }];
  });

  it("creates a task of its own in the project, delegated by this run, and starts it", async () => {
    vi.mocked(createTask).mockResolvedValueOnce({ id: "own-1" } as never);
    vi.mocked(startDelegatedTask).mockResolvedValueOnce({ id: "run-own" } as never);
    expect(await workIn(superCtx())).toEqual({
      taskId: "own-1",
      runId: "run-own",
      started: true,
      next: expect.stringMatching(/comes back here/),
    });
    expect(createTask).toHaveBeenCalledWith(
      {
        title: "Check the build script",
        description: "Read package.json and say which build script runs.",
        projectId: "p1",
        assigneeAgentId: "s",
        delegatedByRunId: "run-s",
      },
      "agent:super",
    );
    expect(startDelegatedTask).toHaveBeenCalledWith("own-1", { parentRunId: "run-s" });
  });

  it("refuses inside a project, and projects that are unknown, archived or closed to its models", async () => {
    expect(await workIn(superCtx({ project: { name: "Crumb" } as RunContext["project"] }))).toEqual({
      error: "You are already working inside Crumb: do this step in this run.",
    });
    state.projects = [];
    expect(await workIn(superCtx())).toEqual({ error: expect.stringMatching(/^Project p1 does not exist/) });
    state.projects = [{ id: "p1", name: "Crumb", status: "archived" }];
    expect(await workIn(superCtx())).toEqual({ error: "Project Crumb is archived." });
    state.projects = [{ id: "p1", name: "Crumb", status: "active" }];
    vi.mocked(closedProjects).mockResolvedValueOnce(new Set(["p1"]));
    expect(await workIn(superCtx())).toEqual({ error: expect.stringMatching(/^Project Crumb: Withheld/) });
    expect(createTask).not.toHaveBeenCalled();
  });
});
