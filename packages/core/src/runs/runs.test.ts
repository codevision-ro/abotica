import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeTaskRun, resetFixRounds, taskFailureStreak, TaskCircuitOpenError, updateTask } from "../tasks/tasks";
import { clearHeldReplies, countHeldReply, takeResumeRequest } from "./run-lifecycle";
import { loadUnsteeredMessages, markUndelivered } from "./run-messages";
import { createConversation } from "./conversations";
import { holdStaleReply, noticeText, type Run, roundIntro, startFollowUpIfQueued, startTaskRun } from "./runs";
import { listFiles } from "../files/files";

/**
 * startTaskRun and the task's circuit breaker: refused while open, unless the user forces the start, which
 * also gives its pull requests their automatic fix rounds back.
 * After a run: the follow-up and the Telegram send gate, for messages the run did not take in.
 */

const TASK = {
  id: "t1",
  assigneeAgentId: "a1",
  projectId: null,
  title: "Write the report",
  priority: "medium",
  description: "The full description of the report.",
};

/**
 * A database that answers each query by its table: `rows[table]` holds the answers in the order the
 * queries come (tasks default to TASK, the rest to nothing). Inserts are recorded in `inserted`.
 */
const { rows, inserted, updated } = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[][]>,
  inserted: [] as { table: string; values: Record<string, unknown> }[],
  updated: [] as { table: string; values: Record<string, unknown> }[],
}));
vi.mock("@abotica/db", () => {
  const table = (name: string) => ({ name });
  const query = (start?: { name: string }) => {
    let name = start?.name ?? "";
    let values: Record<string, unknown> | undefined;
    const q: Record<string, unknown> = {
      then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => {
        if (values) inserted.push({ table: name, values });
        const answer = rows[name]?.shift() ?? (name === "tasks" ? [TASK] : values ? [{ id: "run-1", ...values }] : []);
        return Promise.resolve(answer).then(ok, fail);
      },
    };
    for (const m of ["where", "innerJoin", "leftJoin", "orderBy", "limit", "returning", "onConflictDoNothing"]) {
      q[m] = () => q;
    }
    q.set = (v: Record<string, unknown>) => (updated.push({ table: name, values: v }), q);
    q.from = (t: { name: string }) => ((name = t.name), q);
    q.values = (v: Record<string, unknown>) => ((values = v), q);
    return q;
  };
  return {
    agents: table("agents"),
    conversations: table("conversations"),
    db: { select: () => query(), insert: query, update: query, delete: query },
    messages: table("messages"),
    runs: table("runs"),
    taskComments: table("taskComments"),
    taskDependencies: table("taskDependencies"),
    taskEvents: table("taskEvents"),
    tasks: table("tasks"),
  };
});
vi.mock("@abotica/db/orm", () => ({
  and: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  gt: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  ne: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
}));
vi.mock("../infra/events", () => ({ publish: vi.fn() }));
vi.mock("../settings/settings", () => ({ getSettings: vi.fn(async () => ({ agents: { maxContinuations: 3 } })) }));
vi.mock("../infra/queues", () => ({ enqueueRun: vi.fn() }));
vi.mock("../files/files", () => ({ listFiles: vi.fn() }));
vi.mock("./run-lifecycle", () => ({
  clearHeldReplies: vi.fn(),
  countHeldReply: vi.fn(),
  failRun: vi.fn(),
  publishRunUpdate: vi.fn(),
  takeResumeRequest: vi.fn(async () => false),
}));
vi.mock("./run-messages", () => ({ loadUnsteeredMessages: vi.fn(), markUndelivered: vi.fn() }));
vi.mock("./conversations", () => ({ createConversation: vi.fn(async () => ({ id: "c-new" })) }));
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
  for (const key of Object.keys(rows)) delete rows[key];
  inserted.length = 0;
  updated.length = 0;
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

describe("startTaskRun and the places for delegated work", () => {
  it("starts the user's forced start of a task waiting for a place right away, out of the backlog", async () => {
    await startPastBreaker({ force: true });
    // Never held for a place; leaving the backlog drops the task's wait (leavesBacklog).
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

const since = new Date("2026-10-08T09:00:00Z");

/** A comment as the briefs load it: a note by the user, after the previous round started. */
const comment = (over: Record<string, unknown>) => ({
  id: "c1",
  body: "A comment",
  author: "user",
  agent: null,
  kind: "note",
  authorAgentId: null,
  createdAt: new Date(since.getTime() + 60_000),
  deliveredMessageId: null,
  ...over,
});

describe("startTaskRun for a task the assignee worked on before", () => {
  const textOf = (values: Record<string, unknown>) => (values.parts as { text: string }[])[0]!.text;

  beforeEach(() => {
    vi.mocked(taskFailureStreak).mockResolvedValue({ failures: 0, reason: null, open: false });
    vi.mocked(listFiles).mockResolvedValue([]);
  });

  it("continues its latest conversation, with only what changed since", async () => {
    // Its latest run there, then nothing going in the conversation and no compaction.
    rows.runs = [[{ conversationId: "c-old", createdAt: since }], []];
    rows.messages = [[]];
    rows.taskComments = [[comment({ body: "Use the 2025 figures" })]];
    const run = await startTaskRun("t1", { parentRunId: "manager-run" });

    expect(createConversation).not.toHaveBeenCalled();
    expect(run).toMatchObject({ conversationId: "c-old", taskId: "t1", trigger: "delegation" });
    const message = inserted.find((i) => i.table === "messages")!.values;
    expect(message.conversationId).toBe("c-old");
    expect(textOf(message)).toContain("The task was given back to you.");
    expect(textOf(message)).toContain("- user: Use the 2025 figures");
    expect(textOf(message)).not.toContain(TASK.description);
  });

  it("starts a new conversation with the full brief when that one has a run going", async () => {
    rows.runs = [[{ conversationId: "c-old", createdAt: since }], [{ id: "busy-run" }]];
    rows.messages = [[]];
    const run = await startTaskRun("t1");

    expect(createConversation).toHaveBeenCalledOnce();
    expect(run.conversationId).toBe("c-new");
    expect(textOf(inserted.find((i) => i.table === "messages")!.values)).toContain(TASK.description);
  });

  it("starts a new conversation the first time", async () => {
    const run = await startTaskRun("t1");
    expect(run.conversationId).toBe("c-new");
    expect(textOf(inserted.find((i) => i.table === "messages")!.values)).toContain(`# Task: ${TASK.title}`);
  });

  it("ends a specialist's brief with delivering, a manager's with delegating", async () => {
    rows.agents = Array.from({ length: 5 }, () => [{ kind: "specialist" }]);
    await startTaskRun("t1", { parentRunId: "manager-run" });
    const specialist = textOf(inserted.find((i) => i.table === "messages")!.values);
    expect(specialist).toContain("When you finish, call task_update with status 'review'");
    expect(specialist).not.toContain("This is your team's work");

    inserted.length = 0;
    rows.agents = Array.from({ length: 5 }, () => [{ kind: "manager" }]);
    await startTaskRun("t1", { parentRunId: "super-run" });
    const manager = textOf(inserted.find((i) => i.table === "messages")!.values);
    expect(manager).toContain("This is your team's work: plan it and delegate each piece");
    expect(manager).toContain("Do not produce the deliverable yourself.");
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

describe("roundIntro", () => {
  const counts = { continuation: 2, continuations: 3, attempt: 3 };

  it("gives every reason its own intro", () => {
    const reasons = ["given-back", "instruction", "answer", "resumed", "continue", "retry", "help"] as const;
    const intros = reasons.map((reason) => roundIntro(reason, counts));
    expect(new Set(intros).size).toBe(reasons.length);
    expect(roundIntro("given-back", counts)).toContain("The task was given back to you.");
    expect(roundIntro("instruction", counts)).toContain("the latest instruction wins over the brief");
  });

  it("counts the continuation and the attempt", () => {
    expect(roundIntro("continue", counts)).toContain("continuation 2 of 3");
    expect(roundIntro("continue", counts)).toContain("report_progress");
    expect(roundIntro("retry", counts)).toContain("attempt 3");
  });
});

describe("noticeText", () => {
  it("opens with the platform's header and says what, from whom and about which task", () => {
    const text = noticeText({ id: "t1", title: "Write the report" }, { kind: "instruction", text: "Use K", from: "Ana" });
    expect(text).toBe(
      '[Automatic notice from Abotica, not written by the user]\nNew instruction from Ana about the task "Write the report" (t1):\nUse K\n\nApply this to the work underway now, in this run: where it differs from your brief or from what you planned, it wins. Your output must reflect it.',
    );
  });

  it("adds nothing to a notice that only informs", () => {
    const text = noticeText({ id: "t1", title: "Write the report" }, { kind: "progress", text: "Half done", from: "Ana" });
    expect(text.endsWith("Half done")).toBe(true);
    const fyi = { kind: "answer" as const, text: "FYI: it was answered. Nothing to do.", from: "Abotica", fyi: true };
    expect(noticeText({ id: "t1", title: "Write the report" }, fyi).endsWith("Nothing to do.")).toBe(true);
  });
});

describe("startTaskRun brought back by a notice", () => {
  const textOf = (values: Record<string, unknown>) => (values.parts as { text: string }[])[0]!.text;
  const notice = { kind: "instruction" as const, text: "Include PINEAPPLE", commentId: "c-new", from: "the user" };

  beforeEach(() => {
    vi.mocked(taskFailureStreak).mockResolvedValue({ failures: 0, reason: null, open: false });
    vi.mocked(listFiles).mockResolvedValue([]);
    rows.runs = [[{ conversationId: "c-old", createdAt: since }], []];
    rows.messages = [[]];
  });

  it("leads with the notice and its reason's intro, and leaves out what was delivered already", async () => {
    rows.taskComments = [
      [
        comment({ id: "c-new", body: "Include PINEAPPLE", kind: "instruction" }),
        comment({ id: "c-seen", body: "Steered in earlier", kind: "instruction", deliveredMessageId: "m0" }),
        comment({ id: "c-q", body: "Which year?", kind: "question", author: "agent", agent: "manager" }),
      ],
    ];
    await startTaskRun("t1", { parentRunId: "manager-run", reason: "instruction", notice });

    const message = inserted.find((i) => i.table === "messages")!.values;
    const text = textOf(message);
    expect(text.startsWith("[Automatic notice from Abotica, not written by the user]\nNew instruction from the user")).toBe(
      true,
    );
    expect(text).toContain("A new instruction about the task came for you");
    expect(text).toContain("- manager (question): Which year?");
    expect(text).not.toContain("Steered in earlier");
    // The notice's own comment leads; it is not listed again.
    expect(text.match(/Include PINEAPPLE/g)).toHaveLength(1);
    expect(message.metadata).toMatchObject({
      kind: "task-notice",
      notice: "instruction",
      taskId: "t1",
      commentId: "c-new",
    });
    expect(updated).toContainEqual({
      table: "taskComments",
      values: { deliveredMessageId: message.id, deliveredRunId: "run-1" },
    });
  });

  it("queues the run at its task's priority, with its attempt", async () => {
    rows.tasks = [[{ ...TASK, priority: "urgent" }], [{ ...TASK, priority: "urgent" }]];
    await startTaskRun("t1", { parentRunId: "manager-run", reason: "retry", attempt: 2 });
    expect(inserted.find((i) => i.table === "runs")!.values).toMatchObject({ priority: 2, attempt: 2 });
  });
});

describe("startFollowUpIfQueued and the task's state", () => {
  const notice = {
    message: {
      id: "n1",
      role: "user" as const,
      parts: [],
      metadata: { kind: "task-notice", notice: "instruction", taskId: "t1", taskTitle: "T", projectId: null, from: "x" },
    },
    createdAt: new Date("2026-10-08T10:00:05Z"),
  };
  const onTask = { ...FINISHED, taskId: "t1" } as Run;

  it("starts none for a task put aside, cancelled or done", async () => {
    vi.mocked(loadUnsteeredMessages).mockResolvedValue([notice]);
    for (const status of ["paused", "cancelled", "done"]) {
      rows.tasks = [[{ status }]];
      expect(await startFollowUpIfQueued(onTask)).toBeNull();
    }
    expect(inserted.some((i) => i.table === "runs")).toBe(false);
  });

  it("reopens a task that settled while a notice arrived during the last step", async () => {
    vi.mocked(loadUnsteeredMessages).mockResolvedValue([notice]);
    rows.tasks = [[{ status: "review" }]];
    await startFollowUpIfQueued(onTask);
    expect(updateTask).toHaveBeenCalledWith("t1", { status: "in_progress" }, "system");
    expect(updated).toContainEqual({ table: "tasks", values: { reportedAt: null } });
  });

  it("leaves a task in review alone when only the user wrote", async () => {
    vi.mocked(loadUnsteeredMessages).mockResolvedValue(arrived);
    rows.tasks = [[{ status: "review" }]];
    await startFollowUpIfQueued(onTask);
    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe("holdStaleReply and task notices", () => {
  it("does not hold for a task notice: the user did not write", async () => {
    vi.mocked(loadUnsteeredMessages).mockResolvedValue([
      {
        message: { id: "n1", role: "user" as const, parts: [], metadata: { kind: "task-notice", notice: "progress" } },
        createdAt: new Date("2026-10-08T10:00:06Z"),
      },
    ]);
    expect(await holdStaleReply(FINISHED)).toBe(false);
    expect(markUndelivered).not.toHaveBeenCalled();
  });
});
