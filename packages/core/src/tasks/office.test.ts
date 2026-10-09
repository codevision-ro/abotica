import { describe, expect, it, vi } from "vitest";
import { buildOfficeState, officeActivity, officeExcerpt, type OfficeInput } from "./office";

/** The office from loaded rows, without the database: statuses, seats, the lounge and interactions. */

vi.mock("@abotica/db", () => ({ db: {} }));

const NOW = new Date("2026-10-09T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const SUPER = "00000000-0000-4000-8000-000000000001";
const MANAGER = "00000000-0000-4000-8000-000000000002";
const ANA = "00000000-0000-4000-8000-000000000003";
const BOB = "00000000-0000-4000-8000-000000000004";
const CARA = "00000000-0000-4000-8000-000000000005";
const OFF = "00000000-0000-4000-8000-000000000006";
const ALPHA = "10000000-0000-4000-8000-000000000001";
const BETA = "10000000-0000-4000-8000-000000000002";
const TASK = "20000000-0000-4000-8000-000000000001";
const OTHER_TASK = "20000000-0000-4000-8000-000000000002";

type Agent = OfficeInput["agents"][number];
const agent = (id: string, name: string, kind: Agent["kind"] = "specialist", over: Partial<Agent> = {}): Agent => ({
  id,
  slug: name.toLowerCase(),
  name,
  role: `${name} role`,
  kind,
  avatar: null,
  enabled: true,
  ...over,
});

/** A company: the super agent, a manager leading Beta and Alpha, Ana and Bob on Alpha, Cara on no team. */
function company(over: Partial<OfficeInput> = {}): OfficeInput {
  return {
    agents: [
      agent(SUPER, "Super", "orchestrator"),
      agent(MANAGER, "Mara", "manager"),
      agent(ANA, "Ana"),
      agent(BOB, "Bob"),
      agent(CARA, "Cara"),
      agent(OFF, "Off", "specialist", { enabled: false }),
    ],
    projects: [
      { id: BETA, name: "Beta", status: "paused", managerAgentId: MANAGER },
      { id: ALPHA, name: "Alpha", status: "active", managerAgentId: MANAGER },
    ],
    memberships: [
      { projectId: ALPHA, agentId: BOB },
      { projectId: ALPHA, agentId: ANA },
      { projectId: ALPHA, agentId: OFF },
    ],
    activeRuns: [],
    openTasks: [],
    userQuestions: [],
    events: [],
    comments: [],
    handoffSources: [],
    reports: [],
    ...over,
  };
}

type Run = OfficeInput["activeRuns"][number];
const run = (over: Partial<Run> = {}): Run => ({
  id: "30000000-0000-4000-8000-000000000001",
  agentId: ANA,
  projectId: ALPHA,
  status: "running",
  taskId: TASK,
  taskTitle: "Build the page",
  startedAt: ago(10),
  createdAt: ago(11),
  lastStepTools: null,
  ...over,
});

type OpenTask = OfficeInput["openTasks"][number];
const openTask = (over: Partial<OpenTask> = {}): OpenTask => ({
  id: TASK,
  title: "Build the page",
  projectId: ALPHA,
  assigneeAgentId: ANA,
  status: "in_progress",
  updatedAt: ago(30),
  ...over,
});

const build = (over: Partial<OfficeInput> = {}) => buildOfficeState(company(over), NOW);
const room = (state: ReturnType<typeof build>, id: string) => state.rooms.find((r) => r.projectId === id)!;
const seatOf = (state: ReturnType<typeof build>, projectId: string, agentId: string) =>
  room(state, projectId).seats.find((s) => s.agentId === agentId);

describe("officeActivity", () => {
  it("thinks before the first step and on a step without tools", () => {
    expect(officeActivity(null)).toBe("thinking");
    expect(officeActivity([])).toBe("thinking");
  });

  it("uses the last tool of the step", () => {
    expect(officeActivity(["file_write", "shell_run"])).toBe("terminal");
    expect(officeActivity(["shell_run", "file_edit"])).toBe("writing");
  });

  it("maps tools to what the monitor shows", () => {
    expect(officeActivity(["shell_run_root"])).toBe("terminal");
    for (const t of ["file_share", "memory_save", "knowledge_add"]) expect(officeActivity([t])).toBe("writing");
    for (const t of ["web_fetch", "web_search", "playwright__browser_navigate", "scrapling__fetch", "x__browser_click"]) {
      expect(officeActivity([t])).toBe("browser");
    }
    for (const t of ["delegate_task", "ask", "answer", "ask_colleague", "task_comment", "report_progress"]) {
      expect(officeActivity([t])).toBe("talking");
    }
    expect(officeActivity(["memory_search"])).toBe("thinking");
  });
});

describe("officeExcerpt", () => {
  it("collapses whitespace and caps the length with an ellipsis", () => {
    expect(officeExcerpt("  one\n\n two\tthree ")).toBe("one two three");
    const long = officeExcerpt("word ".repeat(100))!;
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("...")).toBe(true);
    expect(officeExcerpt("x".repeat(160))).toBe("x".repeat(160));
  });

  it("is null for nothing", () => {
    expect(officeExcerpt(null)).toBeNull();
    expect(officeExcerpt("   ")).toBeNull();
  });
});

describe("rooms", () => {
  it("lists rooms by name with the manager first, then the team by name, enabled agents only", () => {
    const state = build();
    expect(state.rooms.map((r) => r.name)).toEqual(["Alpha", "Beta"]);
    expect(room(state, ALPHA)).toMatchObject({ status: "active", managerAgentId: MANAGER, memberIds: [MANAGER, ANA, BOB] });
    expect(room(state, BETA).memberIds).toEqual([MANAGER]);
  });

  it("has no seats when nobody works", () => {
    const state = build();
    expect(state.rooms.every((r) => r.seats.length === 0)).toBe(true);
  });
});

describe("statuses", () => {
  it("is working with the run's task, activity and start while a run is queued or running", () => {
    const state = build({ activeRuns: [run({ lastStepTools: ["web_fetch"] })] });
    expect(seatOf(state, ALPHA, ANA)).toEqual({
      agentId: ANA,
      status: "working",
      activity: "browser",
      task: { id: TASK, title: "Build the page" },
      since: ago(10).toISOString(),
    });
    const queued = build({ activeRuns: [run({ status: "queued", startedAt: null, taskId: null, taskTitle: null })] });
    expect(seatOf(queued, ALPHA, ANA)).toMatchObject({
      status: "working",
      activity: "thinking",
      task: null,
      since: ago(11).toISOString(),
    });
  });

  it("needs the user while a run waits for an approval", () => {
    const state = build({ activeRuns: [run({ status: "waiting_approval", lastStepTools: ["shell_run"] })] });
    expect(seatOf(state, ALPHA, ANA)).toMatchObject({ status: "needs_you", activity: null });
  });

  it("needs the user while its question to the user is open", () => {
    const state = build({
      userQuestions: [
        { taskId: TASK, taskTitle: "Build the page", projectId: ALPHA, authorAgentId: BOB, createdAt: ago(5) },
      ],
    });
    expect(seatOf(state, ALPHA, BOB)).toMatchObject({
      status: "needs_you",
      task: { id: TASK, title: "Build the page" },
      since: ago(5).toISOString(),
    });
  });

  it("is blocked by a blocked task, and waits on an in-progress task with no run", () => {
    const state = build({
      openTasks: [openTask({ status: "blocked" }), openTask({ id: OTHER_TASK, title: "Copy", assigneeAgentId: BOB })],
    });
    expect(seatOf(state, ALPHA, ANA)).toMatchObject({ status: "blocked", since: ago(30).toISOString() });
    expect(seatOf(state, ALPHA, BOB)).toMatchObject({ status: "waiting", task: { id: OTHER_TASK, title: "Copy" } });
  });

  it("does not wait on an in-progress task whose run is active", () => {
    const state = build({ activeRuns: [run({ agentId: BOB })], openTasks: [openTask()] });
    expect(seatOf(state, ALPHA, ANA)).toBeUndefined();
    expect(seatOf(state, ALPHA, BOB)?.status).toBe("working");
  });

  it("shows the most urgent status: needs_you over working over blocked over waiting", () => {
    const waitingBlocked = build({
      openTasks: [openTask(), openTask({ id: OTHER_TASK, title: "Copy", status: "blocked" })],
    });
    expect(seatOf(waitingBlocked, ALPHA, ANA)?.status).toBe("blocked");

    const working = build({
      activeRuns: [run({ taskId: OTHER_TASK, taskTitle: "Copy" })],
      openTasks: [openTask({ status: "blocked" })],
    });
    expect(seatOf(working, ALPHA, ANA)).toMatchObject({ status: "working", task: { id: OTHER_TASK } });

    const needsYou = build({
      activeRuns: [run()],
      userQuestions: [{ taskId: OTHER_TASK, taskTitle: "Copy", projectId: ALPHA, authorAgentId: ANA, createdAt: ago(1) }],
    });
    expect(seatOf(needsYou, ALPHA, ANA)).toMatchObject({ status: "needs_you", task: { id: OTHER_TASK } });
  });

  it("prefers a running run over a queued one", () => {
    const state = build({
      activeRuns: [
        run({ id: "q", status: "queued", taskId: OTHER_TASK, taskTitle: "Copy", createdAt: ago(60), startedAt: null }),
        run({ id: "r", lastStepTools: ["shell_run"] }),
      ],
    });
    expect(seatOf(state, ALPHA, ANA)).toMatchObject({ activity: "terminal", task: { id: TASK } });
  });

  it("is idle otherwise: no seat, in the lounge", () => {
    const state = build({ activeRuns: [run()] });
    expect(seatOf(state, ALPHA, BOB)).toBeUndefined();
    expect(state.loungeIds).toContain(BOB);
  });
});

describe("seats", () => {
  it("seats an agent per room it has work in", () => {
    const state = build({
      activeRuns: [run({ agentId: MANAGER })],
      openTasks: [openTask({ assigneeAgentId: MANAGER, projectId: BETA, status: "blocked" })],
    });
    expect(seatOf(state, ALPHA, MANAGER)?.status).toBe("working");
    expect(seatOf(state, BETA, MANAGER)?.status).toBe("blocked");
  });

  it("puts work without a project in the first room the agent is a member of", () => {
    const state = build({ activeRuns: [run({ agentId: MANAGER, projectId: null })] });
    expect(seatOf(state, ALPHA, MANAGER)?.status).toBe("working");
    expect(room(state, BETA).seats).toEqual([]);
  });

  it("ignores work without a project for an agent on no team", () => {
    const state = build({ activeRuns: [run({ agentId: CARA, projectId: null })] });
    expect(state.rooms.flatMap((r) => r.seats)).toEqual([]);
    expect(state.loungeIds).toContain(CARA);
  });

  it("gives a desk to an agent working in a room it is not a member of", () => {
    const state = build({ activeRuns: [run({ agentId: CARA })] });
    expect(seatOf(state, ALPHA, CARA)?.status).toBe("working");
    expect(room(state, ALPHA).memberIds).toEqual([MANAGER, ANA, BOB, CARA]);
    expect(state.loungeIds).not.toContain(CARA);
  });

  it("ignores work in a project with no room and of disabled agents", () => {
    const state = build({
      activeRuns: [run({ projectId: "archived" }), run({ id: "off", agentId: OFF })],
    });
    expect(state.rooms.flatMap((r) => r.seats)).toEqual([]);
  });
});

describe("super agent", () => {
  it("sits at its own desk, idle without work", () => {
    const state = build();
    expect(state.superAgent).toEqual({ agentId: SUPER, seat: null });
  });

  it("takes its work from any project, never a room seat", () => {
    const state = build({
      activeRuns: [run({ agentId: SUPER, projectId: null, lastStepTools: ["delegate_task"] })],
      openTasks: [openTask({ assigneeAgentId: SUPER, status: "blocked" })],
    });
    expect(state.superAgent?.seat).toMatchObject({ agentId: SUPER, status: "working", activity: "talking" });
    expect(state.rooms.flatMap((r) => r.seats)).toEqual([]);

    const asking = build({
      activeRuns: [run({ agentId: SUPER })],
      userQuestions: [
        { taskId: TASK, taskTitle: "Build the page", projectId: BETA, authorAgentId: SUPER, createdAt: ago(2) },
      ],
    });
    expect(asking.superAgent?.seat?.status).toBe("needs_you");
  });

  it("is null when there is no super agent", () => {
    const state = buildOfficeState({ ...company(), agents: company().agents.filter((a) => a.id !== SUPER) }, NOW);
    expect(state.superAgent).toBeNull();
  });
});

describe("lounge and agents", () => {
  it("holds every enabled agent with no seat but the super agent, by name", () => {
    const state = build({ activeRuns: [run()] });
    expect(state.loungeIds).toEqual([BOB, CARA, MANAGER]);
  });

  it("lists every agent the state names, with a normalized avatar", () => {
    const state = build();
    expect(state.agents.map((a) => a.id)).toEqual([ANA, BOB, CARA, MANAGER, SUPER]);
    expect(state.agents[0]).toEqual({
      id: ANA,
      name: "Ana",
      role: "Ana role",
      kind: "specialist",
      avatar: { icon: "bot", color: "#6d28d9", background: "#ede9fe" },
    });
    expect(state.generatedAt).toBe(NOW.toISOString());
  });
});

// Interactions.

type Event = OfficeInput["events"][number];
let eventSeq = 0;
const event = (type: string, over: Partial<Omit<Event, "task">> & { task?: Partial<Event["task"]> } = {}): Event => {
  eventSeq += 1;
  return {
    id: `e${eventSeq}`,
    type,
    actor: "system",
    data: {},
    createdAt: ago(eventSeq),
    ...over,
    task: {
      id: TASK,
      title: "Build the page",
      projectId: ALPHA,
      assigneeAgentId: ANA,
      kind: "work",
      delegatorAgentId: MANAGER,
      managerAgentId: MANAGER,
      ...over.task,
    },
  };
};

type Comment = OfficeInput["comments"][number];
const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
  id,
  authorAgentId: ANA,
  addresseeAgentId: MANAGER,
  addressedToUser: false,
  body: `${id} body`,
  ...over,
});

/** The single interaction the events make, or undefined when they make none. */
const one = (over: Partial<OfficeInput>) => {
  const { interactions } = build(over);
  expect(interactions.length).toBeLessThanOrEqual(1);
  return interactions[0];
};

describe("interactions", () => {
  it("shapes an interaction from a task event", () => {
    const e = event("created");
    expect(one({ events: [e] })).toEqual({
      id: `event:${e.id}`,
      at: e.createdAt.toISOString(),
      kind: "delegated",
      fromAgentId: MANAGER,
      toAgentId: ANA,
      projectId: ALPHA,
      task: { id: TASK, title: "Build the page" },
      text: null,
    });
  });

  it("created: delegated or help from the delegator, from the user, else nothing", () => {
    expect(one({ events: [event("created", { task: { kind: "help", delegatorAgentId: BOB } })] })).toMatchObject({
      kind: "help",
      fromAgentId: BOB,
      toAgentId: ANA,
    });
    expect(one({ events: [event("created", { actor: "user", task: { delegatorAgentId: null } })] })).toMatchObject({
      kind: "delegated",
      fromAgentId: null,
      toAgentId: ANA,
    });
    expect(one({ events: [event("created", { actor: "agent:bob", task: { delegatorAgentId: null } })] })).toBeUndefined();
    expect(one({ events: [event("created", { task: { assigneeAgentId: null } })] })).toBeUndefined();
  });

  it("question: from its author to its addressee or the user, never the platform's", () => {
    const q = "40000000-0000-4000-8000-000000000001";
    expect(one({ events: [event("question", { data: { questionId: q } })], comments: [comment(q)] })).toMatchObject({
      kind: "question",
      fromAgentId: ANA,
      toAgentId: MANAGER,
      text: `${q} body`,
    });
    expect(
      one({
        events: [event("question", { data: { questionId: q } })],
        comments: [comment(q, { addressedToUser: true, addresseeAgentId: null })],
      }),
    ).toMatchObject({ fromAgentId: ANA, toAgentId: null });
    expect(
      one({ events: [event("question", { data: { questionId: q } })], comments: [comment(q, { authorAgentId: null })] }),
    ).toBeUndefined();
  });

  it("answered: from the answer's author to the question's author, with the answer", () => {
    const q = "40000000-0000-4000-8000-000000000001";
    const a = "40000000-0000-4000-8000-000000000002";
    expect(
      one({
        events: [event("answered", { data: { questionId: q, answerId: a } })],
        comments: [comment(q), comment(a, { authorAgentId: MANAGER })],
      }),
    ).toMatchObject({ kind: "answer", fromAgentId: MANAGER, toAgentId: ANA, text: `${a} body` });
  });

  it("escalated: from the agent who forwarded it, or the asker when the platform moved it", () => {
    const q = "40000000-0000-4000-8000-000000000001";
    const comments = [comment(q)];
    expect(
      one({ events: [event("escalated", { actor: `agent:${MANAGER}`, data: { questionId: q, to: SUPER } })], comments }),
    ).toMatchObject({ kind: "escalated", fromAgentId: MANAGER, toAgentId: SUPER, text: `${q} body` });
    expect(one({ events: [event("escalated", { data: { questionId: q, to: "user" } })], comments })).toMatchObject({
      fromAgentId: ANA,
      toAgentId: null,
    });
  });

  it("instruction and progress: with the comment, to the assignee and up to the delegator or manager", () => {
    const c = "40000000-0000-4000-8000-000000000003";
    expect(
      one({
        events: [event("instruction-delivered", { actor: "agent:mara", data: { commentId: c } })],
        comments: [comment(c)],
      }),
    ).toMatchObject({ kind: "instruction", fromAgentId: MANAGER, toAgentId: ANA, text: `${c} body` });
    expect(
      one({
        events: [event("progress", { actor: `agent:${ANA}`, data: { commentId: c }, task: { delegatorAgentId: BOB } })],
        comments: [comment(c)],
      }),
    ).toMatchObject({ kind: "progress", fromAgentId: ANA, toAgentId: BOB });
    expect(
      one({
        events: [event("progress", { actor: `agent:${ANA}`, data: { commentId: c }, task: { delegatorAgentId: null } })],
        comments: [comment(c)],
      }),
    ).toMatchObject({ toAgentId: MANAGER });
  });

  it("paused: put aside for urgent work, paused, or skipped when paused with the task above", () => {
    const by = { actor: "agent:mara" };
    expect(
      one({ events: [event("paused", { ...by, data: { reason: "urgent first", pausedForTaskId: OTHER_TASK } })] }),
    ).toMatchObject({ kind: "put_aside", fromAgentId: MANAGER, toAgentId: ANA, text: "urgent first" });
    expect(one({ events: [event("paused", { ...by, data: { reason: "wait", pausedForTaskId: null } })] })).toMatchObject({
      kind: "paused",
      text: "wait",
    });
    expect(one({ events: [event("paused", { ...by, data: { reason: "x", pausedWith: OTHER_TASK } })] })).toBeUndefined();
  });

  it("resumed, cancelled (the root only) and redirected", () => {
    const by = { actor: "agent:mara" };
    expect(one({ events: [event("resumed", { ...by, data: { note: "go on" } })] })).toMatchObject({
      kind: "resumed",
      fromAgentId: MANAGER,
      toAgentId: ANA,
      text: "go on",
    });
    expect(one({ events: [event("cancelled", { ...by, data: { reason: "no", rootTaskId: TASK } })] })).toMatchObject({
      kind: "cancelled",
      text: "no",
    });
    expect(
      one({ events: [event("cancelled", { ...by, data: { reason: "no", rootTaskId: OTHER_TASK } })] }),
    ).toBeUndefined();
    expect(
      one({ events: [event("redirected", { ...by, data: { reassignTo: BOB, instructions: "take it", reason: "r" } })] }),
    ).toMatchObject({ kind: "redirected", toAgentId: BOB, text: "take it" });
    expect(
      one({ events: [event("redirected", { ...by, data: { reassignTo: null, instructions: null, reason: "r" } })] }),
    ).toMatchObject({ toAgentId: ANA, text: "r" });
  });

  it("handoff: from the assignee of the finished task to this one's", () => {
    expect(
      one({
        events: [event("handoff", { data: { fromTaskId: OTHER_TASK, files: ["a.txt"] } })],
        handoffSources: [{ id: OTHER_TASK, assigneeAgentId: BOB }],
      }),
    ).toMatchObject({ kind: "handoff", fromAgentId: BOB, toAgentId: ANA });
  });

  it("report: from the assignee back to the delegator, with a stable id", () => {
    const reportedAt = ago(3);
    expect(
      one({
        reports: [
          {
            taskId: TASK,
            title: "Build the page",
            projectId: ALPHA,
            assigneeAgentId: ANA,
            delegatorAgentId: MANAGER,
            reportedAt,
          },
        ],
      }),
    ).toEqual({
      id: `report:${TASK}:${reportedAt.getTime()}`,
      at: reportedAt.toISOString(),
      kind: "report",
      fromAgentId: ANA,
      toAgentId: MANAGER,
      projectId: ALPHA,
      task: { id: TASK, title: "Build the page" },
      text: null,
    });
  });

  it("skips interactions with no one on either side and with oneself", () => {
    expect(one({ events: [event("resumed", { actor: "user", task: { assigneeAgentId: null } })] })).toBeUndefined();
    expect(one({ events: [event("resumed", { actor: `agent:${ANA}` })] })).toBeUndefined();
  });

  it("drops what agents deleted since and the platform did, which nobody in the office did", () => {
    expect(one({ events: [event("resumed", { actor: "agent:gone" })] })).toBeUndefined();
    expect(one({ events: [event("resumed", { actor: "system" })] })).toBeUndefined();
    expect(one({ events: [event("resumed", { actor: "user" })] })).toMatchObject({ fromAgentId: null, toAgentId: ANA });
    expect(one({ events: [event("resumed", { actor: "user", task: { assigneeAgentId: "gone" } })] })).toBeUndefined();
  });

  it("keeps the last 24 hours, newest first, at most 40, and lists their agents", () => {
    const events = Array.from({ length: 45 }, (_, i) =>
      event("resumed", { id: `n${i}`, actor: "agent:mara", createdAt: ago(i), task: { assigneeAgentId: OFF } }),
    );
    const old = event("resumed", { actor: "agent:mara", createdAt: ago(24 * 60 + 1) });
    const state = build({ events: [old, ...events.reverse()] });
    expect(state.interactions).toHaveLength(40);
    expect(state.interactions[0]!.id).toBe("event:n0");
    expect(state.interactions.at(-1)!.id).toBe("event:n39");
    // A disabled agent named by an interaction is listed, though it has no desk.
    expect(state.agents.map((a) => a.id)).toContain(OFF);
    expect(state.loungeIds).not.toContain(OFF);
  });
});
