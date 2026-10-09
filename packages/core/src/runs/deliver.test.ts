import { beforeEach, describe, expect, it, vi } from "vitest";
import { notify } from "../infra/queues";
import { deniesEveryModel } from "../models/provider-policy";
import { startDelegatedTask } from "../tasks/delegation-slots";
import { TaskCircuitOpenError } from "../tasks/tasks";
import { deliverToConversation, deliverToLevel, deliverToTask, NOTICE_WAKES_PER_HOUR, type TaskNotice } from "./deliver";
import { appendUserMessage, ConversationBusyError, startContinuation } from "./runs";

/**
 * Delivery by the task's state (design 4.1): stored when the task is over or not started, into the
 * active run's conversation, into the paused round without a wake, otherwise a wake through the
 * delegation places, within the guards: agents' rounds, the circuit breaker (the user goes past it),
 * the notice wakes of a conversation, and the provider policy.
 */

const fake = await vi.hoisted(async () => (await import("../tasks/test-db")).fakeDb());
const redisCounts = vi.hoisted(() => new Map<string, number>());

vi.mock("@abotica/db", async () => ({
  ...(await import("../tasks/test-db")).tables(
    "agents",
    "conversations",
    "messages",
    "runs",
    "taskComments",
    "taskEvents",
    "tasks",
  ),
  db: fake.db,
}));
vi.mock("@abotica/db/orm", async () => (await import("../tasks/test-db")).ormStubs());
vi.mock("../agents/model-chain", () => ({ fullModelChain: () => [] }));
vi.mock("../infra/env", () => ({ env: () => ({ APP_URL: "http://app" }) }));
vi.mock("../infra/events", () => ({ publish: vi.fn() }));
vi.mock("../infra/queues", () => ({ notify: vi.fn() }));
vi.mock("../infra/redis", () => ({
  redis: () => ({
    incr: async (key: string) => {
      redisCounts.set(key, (redisCounts.get(key) ?? 0) + 1);
      return redisCounts.get(key)!;
    },
    expire: async () => 1,
    set: async (key: string) => (redisCounts.has(key) ? null : (redisCounts.set(key, 1), "OK")),
  }),
}));
vi.mock("../models/provider-policy", () => ({
  combinePolicies: () => ({}),
  deniesEveryModel: vi.fn(() => false),
  projectsProviderPolicy: async () => ({}),
  runProviderPolicy: async () => ({}),
}));
vi.mock("../settings/settings", () => ({
  getSettings: async () => ({ agents: { maxAutoRounds: 10 }, general: { language: "en" } }),
  settingsLocale: () => "en",
}));
vi.mock("../tasks/chain", () => ({ superiorOf: vi.fn() }));
vi.mock("../tasks/delegation-slots", () => ({ startDelegatedTask: vi.fn() }));
vi.mock("../tasks/tasks", async () => {
  const { UserError } = await import("@abotica/i18n");
  class TaskCircuitOpenError extends UserError {
    constructor() {
      super("tasks.errors.circuitOpen", { failures: 5, reason: "Loop" });
    }
  }
  class TaskBusyError extends Error {}
  return { isActiveTaskRunConflict: (e: unknown) => e instanceof TaskBusyError, TaskCircuitOpenError, TaskBusyError };
});
vi.mock("./runs", () => {
  class ConversationBusyError extends Error {}
  return {
    appendUserMessage: vi.fn(),
    ConversationBusyError,
    noticeMessage: (task: { id: string }, notice: TaskNotice) => ({
      id: `m-${notice.kind}`,
      role: "user",
      parts: [{ type: "text", text: notice.text }],
      metadata: { kind: "task-notice", notice: notice.kind, taskId: task.id },
    }),
    startContinuation: vi.fn(async () => ({ id: "woken-run" })),
  };
});

const TASK = {
  id: "t1",
  title: "Write the copy",
  projectId: "p1",
  status: "review",
  assigneeAgentId: "writer",
  delegatedByRunId: "manager-run",
  agentRounds: 0,
  reportedAt: new Date("2026-10-09T10:00:00Z"),
};
const NOTICE: TaskNotice = { kind: "instruction", text: "Use K names", commentId: "c1", from: "Manager" };
const ROUND = { id: "r-last", conversationId: "c-round" };
const MANAGER = { agentId: "manager" };

/** The task, its active run (none by default) and its latest round, as deliverToTask reads them. */
function taskState(over: Partial<typeof TASK> = {}, active: unknown[] = [], round: unknown[] = [ROUND]) {
  fake.answers.tasks = [[{ ...TASK, ...over }]];
  fake.answers.runs = [active, round];
}

const deliver = (opts: Partial<Parameters<typeof deliverToTask>[2]> = {}) =>
  deliverToTask("t1", NOTICE, { wake: "now", by: MANAGER, reason: "instruction", ...opts });

const updatesOf = (table: string) => fake.writes.filter((w) => w.op === "update" && w.table === table).map((w) => w.values);

beforeEach(() => {
  vi.clearAllMocks();
  fake.reset();
  redisCounts.clear();
  vi.mocked(startDelegatedTask).mockResolvedValue({ id: "new-run" } as never);
});

describe("deliverToTask", () => {
  it("only stores it on a task that is done or cancelled", async () => {
    for (const status of ["done", "cancelled"]) {
      taskState({ status });
      expect(await deliver()).toEqual({ result: "stored" });
    }
    expect(appendUserMessage).not.toHaveBeenCalled();
    expect(startDelegatedTask).not.toHaveBeenCalled();
  });

  it("steers it into the task's running run and marks the comment delivered there", async () => {
    taskState({ status: "in_progress" }, [{ id: "r-active", status: "running", conversationId: "c-run" }]);
    expect(await deliver()).toEqual({ result: "steered", runId: "r-active" });
    expect(appendUserMessage).toHaveBeenCalledWith("c-run", expect.objectContaining({ id: "m-instruction" }));
    expect(updatesOf("taskComments")).toContainEqual({ deliveredMessageId: "m-instruction", deliveredRunId: "r-active" });
    expect(startDelegatedTask).not.toHaveBeenCalled();
  });

  it("leaves it for the follow-up of a run waiting for an approval", async () => {
    taskState({ status: "in_progress" }, [{ id: "r-wait", status: "waiting_approval", conversationId: "c-run" }]);
    expect(await deliver()).toEqual({ result: "follow-up", runId: "r-wait" });
  });

  it("puts it into the paused round without waking anyone", async () => {
    taskState({ status: "paused" });
    expect(await deliver()).toEqual({ result: "stored" });
    expect(appendUserMessage).toHaveBeenCalledWith("c-round", expect.anything());
    expect(updatesOf("taskComments")).toContainEqual({ deliveredMessageId: "m-instruction", deliveredRunId: null });
    expect(startDelegatedTask).not.toHaveBeenCalled();
  });

  it("only stores it on a task not started yet: the brief lists the comment", async () => {
    taskState({ status: "backlog" });
    expect(await deliver()).toEqual({ result: "stored" });
    taskState({ status: "in_progress" }, [], []);
    expect(await deliver()).toEqual({ result: "stored" });
    expect(appendUserMessage).not.toHaveBeenCalled();
  });

  it("wakes a settled task in its conversation, to be reported again, and counts the agent's round", async () => {
    taskState({ status: "review", agentRounds: 3 });
    expect(await deliver()).toEqual({ result: "woke", runId: "new-run" });
    expect(startDelegatedTask).toHaveBeenCalledWith("t1", {
      parentRunId: "manager-run",
      reason: "instruction",
      notice: NOTICE,
      force: false,
    });
    expect(updatesOf("tasks")).toEqual([{ reportedAt: null }, { agentRounds: 4 }]);
  });

  it("says when the task waits for a delegation place", async () => {
    taskState({ status: "blocked" });
    vi.mocked(startDelegatedTask).mockResolvedValue(null);
    expect(await deliver()).toEqual({ result: "slot" });
  });

  it("stores a notice that does not wake: a comment for the next brief, anything else in the round", async () => {
    taskState({ status: "review" });
    expect(await deliver({ wake: "never" })).toEqual({ result: "stored" });
    expect(appendUserMessage).not.toHaveBeenCalled();
    taskState({ status: "review" });
    await deliverToTask("t1", { ...NOTICE, commentId: null }, { wake: "if-open", by: "system", reason: "instruction" });
    expect(appendUserMessage).toHaveBeenCalledWith("c-round", expect.anything());
    expect(startDelegatedTask).not.toHaveBeenCalled();
  });

  it("refuses an agent's wake past agents.maxAutoRounds: stored, recorded, the user told", async () => {
    taskState({ status: "review", agentRounds: 10 });
    const sent = await deliver();
    expect(sent.result).toBe("refused");
    expect(sent.error).toContain("not woken again");
    expect(fake.writes).toContainEqual({
      op: "insert",
      table: "taskEvents",
      values: expect.objectContaining({ type: "rounds-limit" }),
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "text" }));
    expect(startDelegatedTask).not.toHaveBeenCalled();
  });

  it("does not count answers or the user's wakes, and forces the user's past the breaker", async () => {
    taskState({ status: "review", agentRounds: 10 });
    expect((await deliver({ reason: "answer" })).result).toBe("woke");
    taskState({ status: "review", agentRounds: 10 });
    expect((await deliver({ by: "user" })).result).toBe("woke");
    expect(vi.mocked(startDelegatedTask).mock.calls[1]![1]).toMatchObject({ force: true });
    expect(updatesOf("tasks").some((v) => v && "agentRounds" in v)).toBe(false);
  });

  it("refuses an agent's wake on a task whose runs keep failing, and puts back its report mark", async () => {
    taskState({ status: "blocked" });
    vi.mocked(startDelegatedTask).mockRejectedValue(new (TaskCircuitOpenError as never as new () => Error)());
    const sent = await deliver();
    expect(sent.result).toBe("refused");
    expect(updatesOf("tasks")).toEqual([{ reportedAt: null }, { reportedAt: TASK.reportedAt }]);
  });

  it("falls back to the run that started meanwhile", async () => {
    const { TaskBusyError } = (await import("../tasks/tasks")) as unknown as { TaskBusyError: new () => Error };
    taskState({ status: "review" });
    fake.answers.runs!.push([{ id: "r-race", status: "queued", conversationId: "c-race" }]);
    vi.mocked(startDelegatedTask).mockRejectedValue(new TaskBusyError());
    expect(await deliver()).toEqual({ result: "steered", runId: "r-race" });
    expect(appendUserMessage).toHaveBeenCalledWith("c-race", expect.anything());
  });
});

describe("deliverToConversation", () => {
  const AGENT = { id: "manager", name: "Manager", kind: "manager" };
  const message = {
    id: "m1",
    role: "user" as const,
    parts: [],
    metadata: { kind: "task-notice", notice: "question", taskId: "t1", taskTitle: "T", projectId: "p1" },
  };
  const input = (wake: "now" | "if-open" | "never") => ({
    conversationId: "c-boss",
    agentId: "manager",
    message,
    wake,
    run: { taskId: "own", projectId: "p1", trigger: "delegation" as const, parentRunId: "r1", priority: 2 },
    contentProjectIds: ["p1"],
  });
  /** The agent, its conversation, then the runs active there. */
  const state = (active: unknown[] = []) => {
    fake.answers.agents = [[AGENT]];
    fake.answers.conversations = [[]];
    fake.answers.runs = [active];
  };

  it("wakes the agent in the conversation with the run it describes", async () => {
    state();
    expect(await deliverToConversation(input("now"))).toEqual({ result: "woke", runId: "woken-run" });
    expect(startContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c-boss", taskId: "own", priority: 2, message }),
    );
  });

  it("steers it into the run active there", async () => {
    state([{ id: "r-active", status: "running" }]);
    expect(await deliverToConversation(input("now"))).toEqual({ result: "steered", runId: "r-active" });
    expect(appendUserMessage).toHaveBeenCalledWith("c-boss", message);
    expect(startContinuation).not.toHaveBeenCalled();
  });

  it("only stores it with wake never, or if-open on a settled task", async () => {
    state();
    expect(await deliverToConversation(input("never"))).toEqual({ result: "stored" });
    state();
    fake.answers.tasks = [[{ status: "review" }]];
    expect(await deliverToConversation(input("if-open"))).toEqual({ result: "stored" });
    expect(startContinuation).not.toHaveBeenCalled();
  });

  it("says a run took it when the conversation got busy meanwhile", async () => {
    state();
    fake.answers.runs!.push([{ id: "r-race", status: "waiting_approval" }]);
    vi.mocked(startContinuation).mockRejectedValueOnce(new (ConversationBusyError as never as new () => Error)());
    expect(await deliverToConversation(input("now"))).toEqual({ result: "follow-up", runId: "r-race" });
  });

  it("gives it to the user when the agent's models may not read the project", async () => {
    state();
    vi.mocked(deniesEveryModel).mockReturnValueOnce(true);
    expect(await deliverToConversation(input("now"))).toEqual({ result: "withheld" });
    expect(appendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "text", projectId: "p1" }));
  });

  it("stops waking past the notice wakes of an hour, telling the user once", async () => {
    redisCounts.set("abotica:conv:c-boss:notice-wakes", NOTICE_WAKES_PER_HOUR);
    for (let i = 0; i < 2; i++) {
      state();
      expect(await deliverToConversation(input("now"))).toEqual({ result: "stored" });
    }
    expect(startContinuation).not.toHaveBeenCalled();
    expect(appendUserMessage).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledOnce();
  });
});

describe("deliverToLevel to the user", () => {
  const TO_USER = { kind: "user" as const, conversationId: null };
  const task = { ...TASK, status: "in_progress" } as never;

  it("sends a question as a question notification, to answer from it", async () => {
    await deliverToLevel(TO_USER, task, { kind: "question", text: "x", questionId: "q1", from: "Writer" }, { wake: "now" });
    expect(notify).toHaveBeenCalledExactlyOnceWith({ kind: "question", questionId: "q1" });
  });

  it("sends other notices as text, and nothing for one that does not wake", async () => {
    await deliverToLevel(TO_USER, task, { kind: "alert", text: "Late", from: "Abotica" }, { wake: "now" });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "text", projectId: "p1" }));
    vi.mocked(notify).mockClear();
    await deliverToLevel(TO_USER, task, { kind: "progress", text: "Half", from: "Writer" }, { wake: "never" });
    expect(notify).not.toHaveBeenCalled();
  });
});
