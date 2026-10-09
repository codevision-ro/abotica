import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SentQuery } from "./test-queries";

/**
 * The follow-up sweeper, onRunEnded and the retries. The database client is the real one with its
 * queries intercepted (test-queries.ts): each test answers the queries it cares about by their SQL and checks
 * what was asked. Delivery, the chain of command and the other packages' modules are mocked.
 */

const state = vi.hoisted(() => {
  // The schema's client needs a URL; nothing connects.
  process.env.DATABASE_URL ??= "postgres://test@localhost/test";
  return {
    sent: [] as SentQuery[],
    routes: [] as [RegExp, unknown[] | ((q: SentQuery) => unknown[])][],
  };
});

vi.mock("@abotica/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@abotica/db")>();
  const { interceptQueries } = await import("./test-queries");
  interceptQueries(actual.db, actual.tasks, (q) => {
    state.sent.push(q);
    const route = state.routes.find(([re]) => re.test(q.sql))?.[1];
    return typeof route === "function" ? route(q) : (route ?? []);
  });
  return actual;
});
vi.mock("../runs/deliver", () => ({
  deliverToTask: vi.fn(async () => ({ result: "stored" })),
  deliverToSuperior: vi.fn(async () => ({ result: "woke" })),
  deliverToConversation: vi.fn(async () => ({ result: "woke" })),
}));
vi.mock("../runs/run-lifecycle", () => ({
  isLimitStop: (kind: string | null) => kind === "step_limit" || kind === "timeout" || kind === "loop",
}));
vi.mock("../runs/runs", () => ({
  ConversationBusyError: class extends Error {},
  noticeMessage: (task: { id: string }, notice: { kind: string; text: string }) => ({ taskId: task.id, ...notice }),
  startContinuation: vi.fn(async () => ({ id: "retry-run" })),
}));
vi.mock("../infra/queues", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("../settings/settings", () => ({
  getSettings: async () => ({
    general: { locale: "en" },
    agents: { maxContinuations: 2, staleTaskMinutes: 60, deadlineEscalationMinutes: 60 },
  }),
  settingsLocale: () => "en",
}));
vi.mock("./chain", () => ({ chainOfCommand: vi.fn() }));
vi.mock("./control", () => ({ resumePausedFor: vi.fn(async () => 0) }));
vi.mock("./delegation", () => ({ reportTask: vi.fn(async () => {}) }));
vi.mock("./delegation-slots", () => ({ startDelegatedTask: vi.fn(async () => ({ id: "next-run" })) }));
vi.mock("./handoffs", () => ({ alertDependents: vi.fn(async () => {}) }));
vi.mock("./task-messages", () => ({
  escalateQuestion: vi.fn(async () => "escalated"),
  systemQuestion: vi.fn(async () => ({})),
}));
vi.mock("./waiting-for-user", () => ({ sendWaitingReminders: vi.fn(async () => 0) }));
vi.mock("./tasks", async () => {
  const { UserError } = await import("@abotica/i18n");
  class TaskBusyError extends UserError {
    constructor() {
      super("tasks.errors.alreadyRunning");
    }
  }
  return {
    TaskBusyError,
    activeTaskRun: vi.fn(async () => undefined),
    addTaskComment: vi.fn(async () => ({})),
    awaitsAnswer: vi.fn(async () => false),
    awaitsDelegatedWork: vi.fn(async () => false),
    awaitsWakeup: vi.fn(async () => false),
    isActiveTaskRunConflict: (error: unknown) => error instanceof TaskBusyError,
    updateTask: vi.fn(async () => ({})),
  };
});

const { UserError } = await import("@abotica/i18n");
const { deliverToConversation, deliverToSuperior, deliverToTask } = await import("../runs/deliver");
const { startContinuation } = await import("../runs/runs");
const { notify } = await import("../infra/queues");
const { chainOfCommand } = await import("./chain");
const { resumePausedFor } = await import("./control");
const { reportTask } = await import("./delegation");
const { startDelegatedTask } = await import("./delegation-slots");
const { alertDependents } = await import("./handoffs");
const { escalateQuestion, systemQuestion } = await import("./task-messages");
const { sendWaitingReminders } = await import("./waiting-for-user");
const tasksModule = await import("./tasks");
const { deadlineReminderAt, formatMinutes, onRunEnded, onTaskSettled, startRetry, sweepFollowUps } =
  await import("./followups");

const NOW = new Date("2026-10-09T12:00:00Z");
const MINUTE = 60_000;
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * MINUTE);

const task = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  title: "Write the newsletter",
  status: "in_progress",
  projectId: "p1",
  assigneeAgentId: "a1",
  deadline: null as Date | null,
  createdAt: minutesAgo(120),
  activityAt: minutesAgo(90),
  followUps: 1,
  continuations: 0,
  ...over,
});

const answer = (sql: RegExp, rows: unknown[] | ((q: SentQuery) => unknown[])) => state.routes.push([sql, rows]);
const sentLike = (sql: RegExp) => state.sent.filter((q) => sql.test(q.sql));
const inserted = (type: string) => sentLike(/^insert into "task_events"/).filter((q) => q.params.includes(type));

beforeEach(() => {
  state.sent.length = 0;
  state.routes.length = 0;
  vi.clearAllMocks();
});

describe("deadlineReminderAt", () => {
  const at = (givenMinutes: number) =>
    (minutesAgo(0).getTime() +
      givenMinutes * MINUTE -
      deadlineReminderAt(NOW, new Date(NOW.getTime() + givenMinutes * MINUTE)).getTime()) /
    MINUTE;

  it("reminds a fifth of the time given before the deadline", () => {
    expect(at(5 * 60)).toBe(60);
  });

  it("reminds at least 10 minutes and at most a day before", () => {
    expect(at(5)).toBe(10);
    expect(at(30 * 24 * 60)).toBe(24 * 60);
  });
});

describe("formatMinutes", () => {
  it("reads as minutes, hours or days", () => {
    expect([45, 60, 200, 24 * 60, 52 * 60].map(formatMinutes)).toEqual(["45 min", "1 h", "3 h 20 min", "1 d", "2 d 4 h"]);
  });
});

describe("sweepFollowUps", () => {
  it("escalates the questions whose time is up", async () => {
    answer(/^select "id" from "task_comments"/, [{ id: "q1" }, { id: "q2" }]);
    await sweepFollowUps(NOW);

    expect(escalateQuestion).toHaveBeenCalledWith("q1", NOW);
    expect(escalateQuestion).toHaveBeenCalledWith("q2", NOW);
    const [query] = sentLike(/from "task_comments"/);
    expect(query!.sql).toContain('"task_comments"."question_status" = $1 and "task_comments"."escalate_at" <= $2');
  });

  it("reminds the assignee of a deadline once, without waking it", async () => {
    const deadline = new Date(NOW.getTime() + 9 * MINUTE);
    answer(/^update "tasks" set "deadline_reminded_at"/, [task({ deadline })]);
    await sweepFollowUps(NOW);

    const [claim] = sentLike(/^update "tasks" set "deadline_reminded_at"/);
    expect(claim!.sql).toContain('"tasks"."deadline_reminded_at" is null');
    expect(claim!.sql).toContain("least(greatest((");
    expect(claim!.sql).toContain('"tasks"."status" not in');
    expect(deliverToTask).toHaveBeenCalledExactlyOnceWith(
      "t1",
      { kind: "reminder", text: expect.stringContaining("in 9 min"), from: "Abotica" },
      { wake: "never", by: "system", reason: "instruction" },
    );
    expect(inserted("deadline-reminded")).toHaveLength(1);
  });

  it("alerts the superior of a missed deadline and wakes it", async () => {
    answer(/^update "tasks" set "deadline_missed_at"/, [task({ deadline: minutesAgo(5) })]);
    await sweepFollowUps(NOW);

    expect(sentLike(/^update "tasks" set "deadline_missed_at"/)[0]!.sql).toContain('"tasks"."deadline_missed_at" is null');
    expect(deliverToSuperior).toHaveBeenCalledExactlyOnceWith(
      "t1",
      {
        kind: "alert",
        text: expect.stringMatching(/missed its deadline .*late by 5 min.*extend the deadline/),
        from: "Abotica",
      },
      { wake: "now" },
    );
    expect(inserted("deadline-missed")).toHaveLength(1);
  });

  describe("a deadline still missed after deadlineEscalationMinutes", () => {
    const late = () => answer(/^update "tasks" set "deadline_escalated_at"/, [task({ deadline: minutesAgo(70) })]);
    const manager = {
      kind: "agent",
      agent: { id: "m1" },
      conversationId: "c-m",
      taskId: "tm",
      runId: "rm",
      trigger: "delegation",
    };

    it("goes to the agent above the superior, in the conversation where it gave the work on", async () => {
      late();
      vi.mocked(chainOfCommand).mockResolvedValue([
        manager,
        { kind: "agent", agent: { id: "super" }, conversationId: "c-s", taskId: null, runId: "rs", trigger: "chat" },
      ] as never);
      await sweepFollowUps(NOW);

      expect(chainOfCommand).toHaveBeenCalledWith("t1", 2);
      expect(deliverToConversation).toHaveBeenCalledExactlyOnceWith({
        conversationId: "c-s",
        agentId: "super",
        message: expect.objectContaining({ kind: "alert", text: expect.stringContaining("still late by 1 h 10 min") }),
        wake: "now",
        run: { taskId: null, projectId: null, trigger: "chat", parentRunId: "rs" },
        contentProjectIds: ["p1"],
      });
      expect(notify).not.toHaveBeenCalled();
    });

    it("notifies the user when they are the next level", async () => {
      late();
      vi.mocked(chainOfCommand).mockResolvedValue([manager, { kind: "user", conversationId: null }] as never);
      await sweepFollowUps(NOW);

      expect(notify).toHaveBeenCalledExactlyOnceWith({
        kind: "text",
        text: expect.stringContaining('Task "Write the newsletter" is late by 70 min'),
        projectId: "p1",
      });
      expect(deliverToConversation).not.toHaveBeenCalled();
    });

    it("sends nothing more when the user already is the superior", async () => {
      late();
      vi.mocked(chainOfCommand).mockResolvedValue([{ kind: "user", conversationId: null }] as never);
      await sweepFollowUps(NOW);

      expect(notify).not.toHaveBeenCalled();
      expect(deliverToConversation).not.toHaveBeenCalled();
    });
  });

  describe("quiet tasks", () => {
    const quiet = (followUps: number) => {
      answer(/^select "id" from "tasks" where/, [{ id: "t1" }]);
      answer(/^update "tasks" set "follow_ups" = "tasks"."follow_ups" \+ 1/, [task({ followUps })]);
    };

    it("look only at tasks in progress that nothing moves", async () => {
      await sweepFollowUps(NOW);
      const [select] = sentLike(/^select "id" from "tasks" where/);
      for (const part of [
        '"tasks"."status" = $',
        '"tasks"."activity_at" < $',
        '"tasks"."follow_ups" <= $',
        'not exists (select "id" from "runs"',
        'not exists (select "id" from "task_wakeups"',
        'not exists (select "id" from "task_comments"',
        "sub.reported_at is null",
        '"tasks"."waiting_for_slot_since" is null',
      ]) {
        expect(select!.sql).toContain(part);
      }
    });

    it("go to the superior twice, with a wake", async () => {
      quiet(2);
      await sweepFollowUps(NOW);

      expect(deliverToSuperior).toHaveBeenCalledExactlyOnceWith(
        "t1",
        { kind: "alert", text: expect.stringMatching(/quiet for 1 h 30 min.*Follow-up 2 of 2/), from: "Abotica" },
        { wake: "now" },
      );
      expect(notify).not.toHaveBeenCalled();
    });

    it("go to the user the third time", async () => {
      quiet(3);
      await sweepFollowUps(NOW);

      expect(deliverToSuperior).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledExactlyOnceWith({
        kind: "text",
        text: expect.stringContaining('Task "Write the newsletter" has been quiet for 90 min'),
        projectId: "p1",
      });
    });

    it("claim only what is still due, so two sweeps never both follow up", async () => {
      answer(/^select "id" from "tasks" where/, [{ id: "t1" }]);
      await sweepFollowUps(NOW);
      const [claim] = sentLike(/^update "tasks" set "follow_ups" = "tasks"."follow_ups" \+ 1/);
      expect(claim!.sql).toContain('"tasks"."followed_up_at" is null or "tasks"."followed_up_at" <= $');
      expect(deliverToSuperior).not.toHaveBeenCalled();
    });
  });

  it("reminds the delegator of a task left in review, once", async () => {
    answer(/^update "tasks" set "follow_ups" = \$1, "followed_up_at" = \$2.* where \("tasks"."status" = \$\d+/, (q) =>
      q.params.includes("review") ? [task({ status: "review", activityAt: minutesAgo(200) })] : [],
    );
    await sweepFollowUps(NOW);

    expect(deliverToSuperior).toHaveBeenCalledExactlyOnceWith(
      "t1",
      { kind: "reminder", text: expect.stringContaining("waited in review for 3 h 20 min"), from: "Abotica" },
      { wake: "now" },
    );
  });

  it("takes a task left blocked one level above its delegator", async () => {
    answer(/^update "tasks" set "follow_ups" = \$1, "followed_up_at" = \$2/, (q) =>
      q.params.includes("blocked") ? [task({ status: "blocked", activityAt: minutesAgo(200) })] : [],
    );
    vi.mocked(chainOfCommand).mockResolvedValue([
      { kind: "agent", agent: { id: "m1" }, conversationId: "c-m", taskId: null, runId: "rm", trigger: "delegation" },
      { kind: "user", conversationId: null },
    ] as never);
    await sweepFollowUps(NOW);

    expect(notify).toHaveBeenCalledExactlyOnceWith({
      kind: "text",
      text: expect.stringContaining('Task "Write the newsletter" has been blocked for 200 min'),
      projectId: "p1",
    });
  });

  it("starts the retries that are due, sends the user's reminders and resumes work put aside", async () => {
    answer(/^select "id" from "runs" where \("runs"."retry_at" <= /, [{ id: "r1" }]);
    answer(/^select distinct "paused_for_task_id"/, [{ id: "u1" }, { id: "u2" }]);
    answer(/^select "id" from "tasks" where \("tasks"."id" in/, [{ id: "u1" }]);
    await sweepFollowUps(NOW);

    expect(sentLike(/^update "runs" set "retry_at" = \$1/)[0]!.params).toContain("r1");
    expect(sendWaitingReminders).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(resumePausedFor).toHaveBeenCalledExactlyOnceWith("u1");
  });

  it("goes on with the other steps and rows when one fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    answer(/^select "id" from "task_comments"/, [{ id: "q1" }, { id: "q2" }]);
    vi.mocked(escalateQuestion).mockRejectedValueOnce(new Error("not ready"));
    vi.mocked(sendWaitingReminders).mockRejectedValueOnce(new Error("down"));
    answer(/^select distinct "paused_for_task_id"/, [{ id: "u1" }]);
    answer(/^select "id" from "tasks" where \("tasks"."id" in/, [{ id: "u1" }]);
    await sweepFollowUps(NOW);

    expect(escalateQuestion).toHaveBeenCalledWith("q2", NOW);
    expect(resumePausedFor).toHaveBeenCalledWith("u1");
    expect(error).toHaveBeenCalledWith("[followups] escalating question q1 failed:", expect.any(Error));
    expect(error).toHaveBeenCalledWith("[followups] user reminders failed:", expect.any(Error));
    error.mockRestore();
  });
});

const run = (over: Record<string, unknown> = {}) =>
  ({
    id: "r1",
    taskId: "t1",
    agentId: "a1",
    conversationId: "c1",
    projectId: "p1",
    trigger: "delegation",
    status: "succeeded",
    failureKind: "step_limit",
    error: "The run used up its 3 steps while still working",
    attempt: 1,
    retryAt: null,
    retriedByRunId: null,
    createdAt: minutesAgo(5),
    ...over,
  }) as never;

describe("onRunEnded", () => {
  const taskRow = (over: Record<string, unknown> = {}) =>
    answer(/^select .* from "tasks" where "tasks"."id" = \$1$/, [task(over)]);

  it("leaves the report to a run that is retried later", async () => {
    expect(await onRunEnded(run({ status: "failed", failureKind: "rate_limited", retryAt: NOW }))).toBe("retry-scheduled");
  });

  it("does nothing about a run that ended its work, failed or has no task", async () => {
    expect(await onRunEnded(run({ failureKind: null }))).toBe("none");
    expect(await onRunEnded(run({ status: "failed", failureKind: "other" }))).toBe("none");
    expect(await onRunEnded(run({ taskId: null }))).toBe("none");
    expect(state.sent).toEqual([]);
  });

  it("continues a task stopped at its step limit, counting the continuation", async () => {
    taskRow();
    answer(/^update "tasks" set "continuations" = "tasks"."continuations" \+ 1/, [{ continuations: 1 }]);

    expect(await onRunEnded(run())).toBe("continued");
    // The newer-run check leaves the run itself out: its created_at read back lost its microseconds.
    const [newer] = sentLike(/^select "id" from "runs" where \("runs"."task_id"/);
    expect(newer!.sql).toContain('"runs"."id" <> $');
    expect(newer!.params).toContain("r1");
    const [claim] = sentLike(/^update "tasks" set "continuations"/);
    expect(claim!.sql).toContain('"tasks"."continuations" < $');
    expect(claim!.params).toContain(2);
    expect(startDelegatedTask).toHaveBeenCalledExactlyOnceWith("t1", {
      reason: "continue",
      parentRunId: "r1",
      trigger: "delegation",
    });
    expect(inserted("continued")).toHaveLength(1);
    expect(systemQuestion).not.toHaveBeenCalled();
  });

  it("asks the delegator once the continuations are used up", async () => {
    taskRow({ continuations: 2 });

    expect(await onRunEnded(run({ failureKind: "timeout", error: "Past its time limit" }))).toBe("asked");
    expect(startDelegatedTask).not.toHaveBeenCalled();
    expect(systemQuestion).toHaveBeenCalledExactlyOnceWith("t1", {
      system: "needs-more-time",
      text: expect.stringMatching(/reached its time limit again \(Past its time limit\) after 2 automatic continuations/),
      options: ["continue", "redirect", "cancel"],
    });
  });

  it("asks at once about a loop, with the tools it repeated", async () => {
    taskRow();

    expect(await onRunEnded(run({ failureKind: "loop", error: "Stopped: repeating file_read" }))).toBe("asked");
    expect(sentLike(/^update "tasks" set "continuations"/)).toEqual([]);
    expect(systemQuestion).toHaveBeenCalledExactlyOnceWith("t1", {
      system: "loop",
      text: expect.stringContaining("(Stopped: repeating file_read)"),
      options: ["continue", "redirect", "cancel"],
    });
  });

  it("leaves a task that something else moves", async () => {
    taskRow();
    vi.mocked(tasksModule.awaitsAnswer).mockResolvedValueOnce(true);
    expect(await onRunEnded(run())).toBe("none");

    vi.mocked(tasksModule.activeTaskRun).mockResolvedValueOnce({ id: "r2" });
    expect(await onRunEnded(run())).toBe("none");

    answer(
      /^select "id" from "runs" where \("runs"."task_id" = \$1 and \("runs"."created_at" >= \$2 and "runs"."id" <> \$3\)\)/,
      [{ id: "r2" }],
    );
    expect(await onRunEnded(run())).toBe("none");

    expect(startDelegatedTask).not.toHaveBeenCalled();
    expect(systemQuestion).not.toHaveBeenCalled();
  });

  it("leaves a task that settled meanwhile", async () => {
    taskRow({ status: "review" });
    expect(await onRunEnded(run())).toBe("none");
  });
});

describe("startRetry", () => {
  const claim = (over: Record<string, unknown> = {}) =>
    answer(/^update "runs" set "retry_at" = \$1/, [
      run({ status: "failed", failureKind: "rate_limited", retryAt: null, ...over }),
    ]);

  it("starts nothing for a retry already claimed", async () => {
    expect(await startRetry("r1")).toBeNull();
    const [query] = sentLike(/^update "runs" set "retry_at"/);
    expect(query!.sql).toContain('"runs"."retry_at" is not null and "runs"."retried_by_run_id" is null');
    expect(startDelegatedTask).not.toHaveBeenCalled();
  });

  it("goes on with a task run as the next attempt, and links the two runs", async () => {
    claim({ attempt: 2 });
    answer(/^select "status" from "tasks"/, [{ status: "in_progress" }]);

    expect(await startRetry("r1")).toEqual({ id: "next-run" });
    expect(startDelegatedTask).toHaveBeenCalledExactlyOnceWith("t1", {
      reason: "retry",
      parentRunId: "r1",
      trigger: "delegation",
      attempt: 3,
    });
    expect(sentLike(/^update "runs" set "retried_by_run_id"/)[0]!.params).toEqual(["next-run", "r1"]);
  });

  it("leaves a task that is no longer in progress to whoever moved it", async () => {
    claim();
    answer(/^select "status" from "tasks"/, [{ status: "paused" }]);

    expect(await startRetry("r1")).toBeNull();
    expect(startDelegatedTask).not.toHaveBeenCalled();
  });

  it("blocks and reports a task whose retry cannot start", async () => {
    claim();
    answer(/^select "status" from "tasks"/, [{ status: "in_progress" }]);
    vi.mocked(startDelegatedTask).mockRejectedValueOnce(new UserError("tasks.errors.notAssigned"));

    expect(await startRetry("r1")).toBeNull();
    expect(tasksModule.updateTask).toHaveBeenCalledWith("t1", { status: "blocked" }, "system");
    expect(tasksModule.addTaskComment).toHaveBeenCalledWith(
      "t1",
      expect.stringContaining("The automatic retry could not start:"),
      "system",
    );
    expect(reportTask).toHaveBeenCalledWith("t1");
  });

  it("continues a chat cut by a restart in its conversation", async () => {
    claim({ taskId: null, trigger: "chat", failureKind: "worker_restarted" });

    expect(await startRetry("r1")).toEqual({ id: "retry-run" });
    expect(startContinuation).toHaveBeenCalledExactlyOnceWith({
      agentId: "a1",
      trigger: "chat",
      conversationId: "c1",
      projectId: "p1",
      parentRunId: "r1",
      attempt: 2,
    });
  });

  it("does not continue a chat that went on since", async () => {
    claim({ taskId: null, trigger: "chat" });
    answer(
      /^select "id" from "runs" where \("runs"."conversation_id" = \$1 and \("runs"."created_at" >= \$2 and "runs"."id" <> \$3\)\)/,
      [{ id: "r2" }],
    );

    expect(await startRetry("r1")).toBeNull();
    expect(startContinuation).not.toHaveBeenCalled();
  });
});

describe("onTaskSettled", () => {
  const status = (s: string) => answer(/^select "status" from "tasks"/, [{ status: s }]);

  it("starts the continuations over, resumes work put aside and alerts the dependents of a blocked task", async () => {
    status("blocked");
    await onTaskSettled("t1");

    expect(sentLike(/^update "tasks" set "continuations" = \$1/)).toHaveLength(1);
    expect(resumePausedFor).toHaveBeenCalledExactlyOnceWith("t1");
    expect(alertDependents).toHaveBeenCalledExactlyOnceWith("t1", "blocked");
  });

  it("alerts no one about a task that is done", async () => {
    status("done");
    await onTaskSettled("t1");
    expect(resumePausedFor).toHaveBeenCalledWith("t1");
    expect(alertDependents).not.toHaveBeenCalled();
  });

  it("does nothing while the task is still open", async () => {
    status("in_progress");
    await onTaskSettled("t1");
    expect(resumePausedFor).not.toHaveBeenCalled();
    expect(sentLike(/^update/)).toEqual([]);
  });
});
