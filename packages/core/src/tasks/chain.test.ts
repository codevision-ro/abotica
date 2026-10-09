import { beforeEach, describe, expect, it, vi } from "vitest";
import { superAgentInbox } from "../runs/super-agent-inbox";
import { reportTargetAgent } from "./automation-target";
import { chainAgentIds, chainOfCommand, superiorOf } from "./chain";

/**
 * Who stands above a task: its delegator in the conversation it delegated from, the agent above the
 * assignee for work a schedule or trigger fired, the user at the top.
 */

const fake = await vi.hoisted(async () => (await import("./test-db")).fakeDb());

vi.mock("@abotica/db", async () => ({
  ...(await import("./test-db")).tables("agents", "conversations", "runs", "tasks"),
  db: fake.db,
}));
vi.mock("@abotica/db/orm", async () => (await import("./test-db")).ormStubs());
vi.mock("../runs/runs", () => ({ getOrchestrator: async () => SUPER }));
vi.mock("../runs/super-agent-inbox", () => ({ superAgentInbox: vi.fn(async () => ({ id: "c-inbox", channel: "web" })) }));
vi.mock("./automation-target", () => ({ reportTargetAgent: vi.fn() }));

const SUPER = { id: "super", kind: "orchestrator", name: "Super" };
const MANAGER = { id: "manager", kind: "manager", name: "Manager" };

const task = (over: Record<string, unknown> = {}) => ({ id: "t1", projectId: "p1", reportsUp: false, ...over });
const run = (over: Record<string, unknown> = {}) => ({
  id: "r-manager",
  conversationId: "c-manager",
  taskId: "m-task",
  trigger: "delegation",
  projectId: "p1",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fake.reset();
});

describe("superiorOf", () => {
  it("is the agent whose run delegated the task, in that run's conversation", async () => {
    fake.answers.tasks = [[{ task: task(), run: run(), agent: MANAGER }]];
    expect(await superiorOf("t1")).toEqual({
      kind: "agent",
      agent: MANAGER,
      conversationId: "c-manager",
      taskId: "m-task",
      runId: "r-manager",
      trigger: "delegation",
      projectId: "p1",
    });
  });

  it("is the user for a task nobody delegated", async () => {
    fake.answers.tasks = [[{ task: task(), run: null, agent: null }]];
    expect(await superiorOf("t1")).toEqual({ kind: "user", conversationId: null });
  });

  it("is the super agent where the user talks to it for fired work it oversees", async () => {
    fake.answers.tasks = [[{ task: task({ reportsUp: true }), run: null, agent: null }]];
    fake.answers.runs = [[{ id: "r-fired", trigger: "schedule" }]];
    vi.mocked(reportTargetAgent).mockResolvedValue({ agent: SUPER as never, target: "orchestrator" });
    expect(await superiorOf("t1")).toMatchObject({
      kind: "agent",
      agent: SUPER,
      conversationId: "c-inbox",
      taskId: null,
      runId: "r-fired",
      trigger: "chat",
      projectId: null,
    });
    expect(superAgentInbox).toHaveBeenCalledWith("p1");
  });

  it("is the manager in its project's inbox for fired work of its team", async () => {
    fake.answers.tasks = [[{ task: task({ reportsUp: true }), run: null, agent: null }]];
    fake.answers.runs = [[{ id: "r-fired", trigger: "webhook" }]];
    fake.answers.conversations = [[{ id: "c-manager-inbox" }]];
    vi.mocked(reportTargetAgent).mockResolvedValue({ agent: MANAGER as never, target: "manager" });
    expect(await superiorOf("t1")).toMatchObject({
      kind: "agent",
      agent: MANAGER,
      conversationId: "c-manager-inbox",
      trigger: "webhook",
      projectId: "p1",
    });
  });
});

describe("chainOfCommand", () => {
  it("walks from the specialist's task through the manager's to the super agent's chat and the user", async () => {
    fake.answers.tasks = [
      [{ task: task(), run: run(), agent: MANAGER }],
      [
        {
          task: task({ id: "m-task" }),
          run: run({ id: "r-super", conversationId: "c-chat", taskId: null, trigger: "chat", projectId: null }),
          agent: SUPER,
        },
      ],
    ];
    const chain = await chainOfCommand("t1");
    expect(chain.map((l) => (l.kind === "agent" ? l.agent.id : "user"))).toEqual(["manager", "super", "user"]);
    expect(chainAgentIds(chain)).toEqual(["manager", "super"]);
  });

  it("takes a manager working outside a task up to the super agent, not straight to the user", async () => {
    fake.answers.tasks = [[{ task: task(), run: run({ taskId: null, trigger: "schedule" }), agent: MANAGER }]];
    const chain = await chainOfCommand("t1");
    expect(chain.map((l) => (l.kind === "agent" ? l.agent.id : "user"))).toEqual(["manager", "super", "user"]);
    expect(chain[1]).toMatchObject({ conversationId: "c-inbox", runId: "r-manager" });
  });

  it("goes to the user right above a manager talking with them", async () => {
    fake.answers.tasks = [[{ task: task(), run: run({ taskId: null, trigger: "chat" }), agent: MANAGER }]];
    expect((await chainOfCommand("t1")).map((l) => l.kind)).toEqual(["agent", "user"]);
  });

  it("stops at max levels", async () => {
    fake.answers.tasks = [[{ task: task(), run: run(), agent: MANAGER }]];
    expect(await chainOfCommand("t1", 1)).toHaveLength(1);
  });
});
