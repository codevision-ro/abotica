/**
 * The office view of the company (office-types.ts): rooms per project, a seat per agent with work in one,
 * and the latest interactions between agents. Loaded in a few batched reads, then derived by
 * buildOfficeState, which needs no database.
 */
import { agents, db, projectAgents, projects, runEvents, runs, taskComments, taskEvents, tasks } from "@abotica/db";
import { toAgentAvatar } from "@abotica/db/avatar";
import { aliasedTable, and, desc, eq, gt, inArray, isNotNull, ne, sql } from "@abotica/db/orm";
import type {
  OfficeActivity,
  OfficeAgent,
  OfficeAgentKind,
  OfficeInteraction,
  OfficeInteractionKind,
  OfficeRoom,
  OfficeSeat,
  OfficeState,
  OfficeTaskRef,
} from "./office-types";

/** How far back interactions go, and how many the office shows at most. */
export const OFFICE_INTERACTION_WINDOW_MS = 24 * 60 * 60_000;
export const OFFICE_INTERACTION_LIMIT = 40;
const EXCERPT_MAX = 160;

const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_approval"] as const;

/** Task events that become interactions; the others (updates, follow-ups, wakeups) are bookkeeping. */
const INTERACTION_EVENTS = [
  "created",
  "question",
  "answered",
  "escalated",
  "instruction-delivered",
  "progress",
  "paused",
  "resumed",
  "cancelled",
  "redirected",
  "handoff",
];

/** What the office is built from: the rows the loaders read, unchanged but for joins. */
export type OfficeInput = {
  /** Every non-template agent, disabled ones included: past interactions may name them. */
  agents: {
    id: string;
    slug: string;
    name: string;
    role: string;
    kind: OfficeAgentKind;
    avatar: unknown;
    enabled: boolean;
  }[];
  /** Projects that are not archived. */
  projects: { id: string; name: string; status: "active" | "paused"; managerAgentId: string | null }[];
  memberships: { projectId: string; agentId: string }[];
  /** Queued, running and waiting_approval runs; `projectId` is the run's, else its task's. */
  activeRuns: {
    id: string;
    agentId: string | null;
    projectId: string | null;
    status: (typeof ACTIVE_RUN_STATUSES)[number];
    taskId: string | null;
    taskTitle: string | null;
    startedAt: Date | null;
    createdAt: Date;
    /** Tool names called in the run's latest step, in order; null before its first step. */
    lastStepTools: string[] | null;
  }[];
  /** Tasks assigned to an agent that are blocked or in progress. */
  openTasks: {
    id: string;
    title: string;
    projectId: string | null;
    assigneeAgentId: string;
    status: "blocked" | "in_progress";
    updatedAt: Date;
  }[];
  /** Open questions agents addressed to the user. */
  userQuestions: { taskId: string; taskTitle: string; projectId: string | null; authorAgentId: string; createdAt: Date }[];
  /** Task events of the window with their task, newest first. */
  events: {
    id: string;
    type: string;
    actor: string;
    data: Record<string, unknown>;
    createdAt: Date;
    task: {
      id: string;
      title: string;
      projectId: string | null;
      assigneeAgentId: string | null;
      kind: "work" | "help";
      /** The agent of the run that delegated it. */
      delegatorAgentId: string | null;
      /** The manager of its project. */
      managerAgentId: string | null;
    };
  }[];
  /** The comments the events name (questions, answers, instructions, progress). */
  comments: {
    id: string;
    authorAgentId: string | null;
    addresseeAgentId: string | null;
    addressedToUser: boolean;
    body: string;
  }[];
  /** The tasks handoffs came from, with their assignee. */
  handoffSources: { id: string; assigneeAgentId: string | null }[];
  /** Delegated tasks reported back within the window. */
  reports: {
    taskId: string;
    title: string;
    projectId: string | null;
    assigneeAgentId: string | null;
    delegatorAgentId: string;
    reportedAt: Date;
  }[];
};

// Activity: what the monitor shows, from the last tool the run called.

const TERMINAL_TOOLS = new Set(["shell_run", "shell_run_root", "repo_open_pr", "preview_publish"]);
const WRITING_TOOLS = new Set([
  "file_write",
  "file_edit",
  "file_share",
  "memory_save",
  "memory_update",
  "knowledge_add",
  "task_create",
  "task_update",
]);
const BROWSER_TOOLS = new Set(["web_fetch", "web_search", "preview_open"]);
/** MCP servers whose tools browse or read the web; an MCP tool is named `<server>__<tool>`. */
const BROWSER_SERVERS = ["playwright", "scrapling", "parallel_search"];
const TALKING_TOOLS = new Set([
  "delegate_task",
  "ask",
  "answer",
  "ask_colleague",
  "task_comment",
  "report_progress",
  "task_control",
]);

/** What a run is doing, from the tools of its latest step: the last call counts; none yet is thinking. */
export function officeActivity(tools: readonly string[] | null): OfficeActivity {
  const name = tools?.at(-1);
  if (!name) return "thinking";
  if (TERMINAL_TOOLS.has(name)) return "terminal";
  if (WRITING_TOOLS.has(name)) return "writing";
  if (TALKING_TOOLS.has(name)) return "talking";
  const [server, tool] = name.includes("__")
    ? [name.slice(0, name.indexOf("__")), name.slice(name.indexOf("__") + 2)]
    : ["", name];
  if (
    BROWSER_TOOLS.has(name) ||
    tool.startsWith("browser_") ||
    name.includes("playwright") ||
    BROWSER_SERVERS.some((s) => server === s)
  ) {
    return "browser";
  }
  return "thinking";
}

/** A short, one-line excerpt of a comment or a reason. */
export function officeExcerpt(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length <= EXCERPT_MAX ? line : `${line.slice(0, EXCERPT_MAX - 3).trimEnd()}...`;
}

// Seats.

const RANK: Record<OfficeSeat["status"], number> = { needs_you: 0, working: 1, blocked: 2, waiting: 3 };

/** One reason an agent has a seat, before the most urgent one is chosen. */
type Claim = OfficeSeat & { projectId: string | null; running: boolean; at: number };

/** Most urgent status first; a running run before a queued one; then the longest standing. */
function moreUrgent(a: Claim, b: Claim): number {
  return RANK[a.status] - RANK[b.status] || Number(b.running) - Number(a.running) || a.at - b.at;
}

const taskRef = (id: string | null, title: string | null): OfficeTaskRef | null =>
  id && title !== null ? { id, title } : null;

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/** The office from what the loaders read, as of `now`. */
export function buildOfficeState(input: OfficeInput, now: Date): OfficeState {
  const agentById = new Map(input.agents.map((a) => [a.id, a]));
  const agentBySlug = new Map(input.agents.map((a) => [a.slug, a]));
  const listed = input.agents.filter((a) => a.enabled);
  const listedIds = new Set(listed.map((a) => a.id));
  const orchestrator = listed.find((a) => a.kind === "orchestrator") ?? null;
  const name = (id: string) => agentById.get(id)?.name ?? "";
  const officeIds = (ids: Iterable<string>) =>
    [...ids].filter((id) => listedIds.has(id) && id !== orchestrator?.id).sort((a, b) => name(a).localeCompare(name(b)));

  // Rooms and their members: manager first, then the team by name.
  const rooms = [...input.projects].sort(byName);
  const members = new Map<string, string[]>();
  for (const project of rooms) {
    const team = officeIds(input.memberships.filter((m) => m.projectId === project.id).map((m) => m.agentId));
    const manager = project.managerAgentId && officeIds([project.managerAgentId]).length ? project.managerAgentId : null;
    members.set(project.id, manager ? [manager, ...team.filter((id) => id !== manager)] : team);
  }
  const roomIds = new Set(rooms.map((r) => r.id));
  /** The room work happens in: its project's, else the first room the agent is a member of. */
  const roomOf = (agentId: string, projectId: string | null): string | null => {
    if (projectId) return roomIds.has(projectId) ? projectId : null;
    return rooms.find((r) => members.get(r.id)?.includes(agentId))?.id ?? null;
  };

  // Every reason each agent has a seat, keyed by agent and room ("" is the super agent's desk).
  const claims = new Map<string, Claim>();
  const claim = (agentId: string | null, projectId: string | null, c: Omit<Claim, "agentId" | "projectId">) => {
    if (!agentId || !listedIds.has(agentId)) return;
    const own = agentId === orchestrator?.id;
    const room = own ? null : roomOf(agentId, projectId);
    if (!own && !room) return;
    const key = `${agentId}:${room ?? ""}`;
    const next: Claim = { ...c, agentId, projectId: room };
    const current = claims.get(key);
    if (!current || moreUrgent(next, current) < 0) claims.set(key, next);
  };

  const runningTasks = new Set<string>();
  for (const run of input.activeRuns) {
    if (run.taskId) runningTasks.add(run.taskId);
    const since = run.startedAt ?? run.createdAt;
    const waiting = run.status === "waiting_approval";
    claim(run.agentId, run.projectId, {
      status: waiting ? "needs_you" : "working",
      activity: waiting ? null : officeActivity(run.lastStepTools),
      task: taskRef(run.taskId, run.taskTitle),
      since: since.toISOString(),
      running: run.status === "running",
      at: since.getTime(),
    });
  }
  for (const q of input.userQuestions) {
    claim(q.authorAgentId, q.projectId, {
      status: "needs_you",
      activity: null,
      task: { id: q.taskId, title: q.taskTitle },
      since: q.createdAt.toISOString(),
      running: false,
      at: q.createdAt.getTime(),
    });
  }
  for (const task of input.openTasks) {
    // An in-progress task with a run is the run's seat; without one it waits.
    if (task.status === "in_progress" && runningTasks.has(task.id)) continue;
    claim(task.assigneeAgentId, task.projectId, {
      status: task.status === "blocked" ? "blocked" : "waiting",
      activity: null,
      task: { id: task.id, title: task.title },
      since: task.updatedAt.toISOString(),
      running: false,
      at: task.updatedAt.getTime(),
    });
  }

  const seated = new Set<string>();
  const seats = new Map<string, OfficeSeat[]>();
  let superSeat: OfficeSeat | null = null;
  for (const c of claims.values()) {
    const seat: OfficeSeat = { agentId: c.agentId, status: c.status, activity: c.activity, task: c.task, since: c.since };
    const projectId = c.projectId;
    if (!projectId) {
      superSeat = seat;
      continue;
    }
    seated.add(seat.agentId);
    seats.set(projectId, [...(seats.get(projectId) ?? []), seat]);
  }

  const officeRooms: OfficeRoom[] = rooms.map((project) => {
    const roomSeats = (seats.get(project.id) ?? []).sort((a, b) => name(a.agentId).localeCompare(name(b.agentId)));
    const memberIds = members.get(project.id) ?? [];
    // Working somewhere it is not a member (reassigned work): it still gets a desk there.
    const guests = roomSeats.map((s) => s.agentId).filter((id) => !memberIds.includes(id));
    return {
      projectId: project.id,
      name: project.name,
      status: project.status,
      managerAgentId: project.managerAgentId,
      memberIds: [...memberIds, ...guests],
      seats: roomSeats,
    };
  });
  const loungeIds = officeIds(listed.filter((a) => !seated.has(a.id)).map((a) => a.id));

  const interactions = officeInteractions(input, now, {
    // Actors are "agent:<id>" or "agent:<slug>", depending on the writer.
    actor: (actor) => {
      if (!actor.startsWith("agent:")) return null;
      const ref = actor.slice("agent:".length);
      return (agentById.get(ref) ?? agentBySlug.get(ref))?.id ?? null;
    },
    // An agent deleted since is no one the office can draw.
    known: (id) => (id && agentById.has(id) ? id : null),
  });

  const referenced = new Set<string>([
    ...officeRooms.flatMap((r) => r.memberIds),
    ...loungeIds,
    ...(orchestrator ? [orchestrator.id] : []),
    ...interactions.flatMap((i) => [i.fromAgentId, i.toAgentId].filter((id): id is string => id !== null)),
  ]);
  const officeAgents: OfficeAgent[] = input.agents
    .filter((a) => referenced.has(a.id))
    .sort(byName)
    .map((a) => ({ id: a.id, name: a.name, role: a.role, kind: a.kind, avatar: toAgentAvatar(a.avatar) }));

  return {
    agents: officeAgents,
    superAgent: orchestrator ? { agentId: orchestrator.id, seat: superSeat } : null,
    rooms: officeRooms,
    loungeIds,
    interactions,
    generatedAt: now.toISOString(),
  };
}

// Interactions.

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** The interactions of the window, newest first, before agents are checked against the office. */
function officeInteractions(
  input: OfficeInput,
  now: Date,
  agentIds: { actor: (actor: string) => string | null; known: (id: string | null) => string | null },
): OfficeInteraction[] {
  const { known } = agentIds;
  const since = now.getTime() - OFFICE_INTERACTION_WINDOW_MS;
  const comments = new Map(input.comments.map((c) => [c.id, c]));
  const handoffSources = new Map(input.handoffSources.map((t) => [t.id, t.assigneeAgentId]));
  const out: OfficeInteraction[] = [];

  for (const event of input.events) {
    if (event.createdAt.getTime() < since) continue;
    const { task, data } = event;
    const from = agentIds.actor(event.actor);
    const add = (kind: OfficeInteractionKind, fromAgentId: string | null, toAgentId: string | null, text?: unknown) => {
      // Without an agent behind it, only the user's own step is an interaction; the platform's are not.
      if (!known(fromAgentId) && event.actor !== "user") return;
      out.push({
        id: `event:${event.id}`,
        at: event.createdAt.toISOString(),
        kind,
        fromAgentId: known(fromAgentId),
        toAgentId: known(toAgentId),
        projectId: task.projectId,
        task: { id: task.id, title: task.title },
        text: officeExcerpt(text),
      });
    };
    const comment = (key: string) => {
      const id = str(data[key]);
      return id ? comments.get(id) : undefined;
    };

    switch (event.type) {
      case "created":
        if (!task.assigneeAgentId) break;
        if (task.delegatorAgentId) {
          add(task.kind === "help" ? "help" : "delegated", task.delegatorAgentId, task.assigneeAgentId);
        } else if (event.actor === "user") {
          add("delegated", null, task.assigneeAgentId);
        }
        break;
      case "question": {
        const question = comment("questionId");
        // System questions (more time, a loop) are the platform's, not an agent's.
        if (!question?.authorAgentId) break;
        const to = question.addressedToUser ? null : question.addresseeAgentId;
        add("question", question.authorAgentId, to, question.body);
        break;
      }
      case "answered": {
        const answer = comment("answerId");
        const question = comment("questionId");
        if (!answer) break;
        add("answer", answer.authorAgentId, question?.authorAgentId ?? null, answer.body);
        break;
      }
      case "escalated": {
        const question = comment("questionId");
        const to = str(data.to);
        const by = event.actor === "system" ? (question?.authorAgentId ?? null) : from;
        add("escalated", by, to && to !== "user" ? to : null, question?.body);
        break;
      }
      case "instruction-delivered":
        add("instruction", from, task.assigneeAgentId, comment("commentId")?.body);
        break;
      case "progress":
        add("progress", from, task.delegatorAgentId ?? task.managerAgentId, comment("commentId")?.body);
        break;
      case "paused":
        // Paused along with the task above it: the pause of that one is the interaction.
        if (data.pausedWith) break;
        add(data.pausedForTaskId ? "put_aside" : "paused", from, task.assigneeAgentId, data.reason);
        break;
      case "resumed":
        add("resumed", from, task.assigneeAgentId, data.note);
        break;
      case "cancelled":
        // Cancelled with the task it was under: only the one the cancel was for counts.
        if (data.rootTaskId !== task.id) break;
        add("cancelled", from, task.assigneeAgentId, data.reason);
        break;
      case "redirected":
        add("redirected", from, str(data.reassignTo) ?? task.assigneeAgentId, data.instructions ?? data.reason);
        break;
      case "handoff": {
        const source = str(data.fromTaskId);
        add("handoff", (source && handoffSources.get(source)) ?? null, task.assigneeAgentId);
        break;
      }
    }
  }

  for (const report of input.reports) {
    if (report.reportedAt.getTime() < since) continue;
    out.push({
      id: `report:${report.taskId}:${report.reportedAt.getTime()}`,
      at: report.reportedAt.toISOString(),
      kind: "report",
      fromAgentId: known(report.assigneeAgentId),
      toAgentId: known(report.delegatorAgentId),
      projectId: report.projectId,
      task: { id: report.taskId, title: report.title },
      text: null,
    });
  }

  return out
    .filter((i) => (i.fromAgentId || i.toAgentId) && i.fromAgentId !== i.toAgentId)
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
    .slice(0, OFFICE_INTERACTION_LIMIT);
}

// Loaders.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The uuids under `keys` in the events' data, deduplicated; anything else is ignored. */
function idsIn(events: OfficeInput["events"], keys: string[]): string[] {
  const ids = events.flatMap((e) => keys.map((k) => e.data[k])).filter((v): v is string => typeof v === "string");
  return [...new Set(ids.filter((id) => UUID.test(id)))];
}

/** The office now: who sits where and the latest interactions. */
export async function getOfficeState(now: Date = new Date()): Promise<OfficeState> {
  const windowStart = new Date(now.getTime() - OFFICE_INTERACTION_WINDOW_MS);
  const delegatorRuns = aliasedTable(runs, "delegator_runs");

  const [agentRows, projectRows, memberships, activeRuns, openTasks, userQuestions, events, reports] = await Promise.all([
    db
      .select({
        id: agents.id,
        slug: agents.slug,
        name: agents.name,
        role: agents.role,
        kind: agents.kind,
        avatar: agents.avatar,
        enabled: agents.enabled,
      })
      .from(agents)
      .where(eq(agents.isTemplate, false)),
    db
      .select({ id: projects.id, name: projects.name, status: projects.status, managerAgentId: projects.managerAgentId })
      .from(projects)
      .where(ne(projects.status, "archived")),
    db.select({ projectId: projectAgents.projectId, agentId: projectAgents.agentId }).from(projectAgents),
    db
      .select({
        id: runs.id,
        agentId: runs.agentId,
        projectId: sql<string | null>`coalesce(${runs.projectId}, ${tasks.projectId})`,
        status: runs.status,
        taskId: runs.taskId,
        taskTitle: tasks.title,
        startedAt: runs.startedAt,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .leftJoin(tasks, eq(tasks.id, runs.taskId))
      .where(inArray(runs.status, [...ACTIVE_RUN_STATUSES])),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        projectId: tasks.projectId,
        assigneeAgentId: tasks.assigneeAgentId,
        status: tasks.status,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(and(inArray(tasks.status, ["blocked", "in_progress"]), isNotNull(tasks.assigneeAgentId))),
    db
      .select({
        taskId: tasks.id,
        taskTitle: tasks.title,
        projectId: tasks.projectId,
        authorAgentId: taskComments.authorAgentId,
        createdAt: taskComments.createdAt,
      })
      .from(taskComments)
      .innerJoin(tasks, eq(tasks.id, taskComments.taskId))
      .where(
        and(
          eq(taskComments.kind, "question"),
          eq(taskComments.questionStatus, "open"),
          eq(taskComments.addressedToUser, true),
          isNotNull(taskComments.authorAgentId),
        ),
      ),
    db
      .select({
        id: taskEvents.id,
        type: taskEvents.type,
        actor: taskEvents.actor,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
        taskId: tasks.id,
        title: tasks.title,
        projectId: tasks.projectId,
        assigneeAgentId: tasks.assigneeAgentId,
        kind: tasks.kind,
        delegatorAgentId: delegatorRuns.agentId,
        managerAgentId: projects.managerAgentId,
      })
      .from(taskEvents)
      .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
      .leftJoin(delegatorRuns, eq(delegatorRuns.id, tasks.delegatedByRunId))
      .leftJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          gt(taskEvents.createdAt, windowStart),
          inArray(taskEvents.type, INTERACTION_EVENTS),
          // Cascade noise, skipped here so it does not take the places of real interactions.
          sql`not (${taskEvents.type} = 'paused' and ${taskEvents.data} ->> 'pausedWith' is not null)`,
          sql`not (${taskEvents.type} = 'cancelled' and ${taskEvents.data} ->> 'rootTaskId' <> ${taskEvents.taskId}::text)`,
        ),
      )
      .orderBy(desc(taskEvents.createdAt))
      .limit(OFFICE_INTERACTION_LIMIT * 3),
    db
      .select({
        taskId: tasks.id,
        title: tasks.title,
        projectId: tasks.projectId,
        assigneeAgentId: tasks.assigneeAgentId,
        delegatorAgentId: runs.agentId,
        reportedAt: tasks.reportedAt,
      })
      .from(tasks)
      .innerJoin(runs, eq(runs.id, tasks.delegatedByRunId))
      .where(and(gt(tasks.reportedAt, windowStart), isNotNull(runs.agentId)))
      .orderBy(desc(tasks.reportedAt))
      .limit(OFFICE_INTERACTION_LIMIT),
  ]);

  const eventRows: OfficeInput["events"] = events.map((e) => ({
    id: e.id,
    type: e.type,
    actor: e.actor,
    data: e.data,
    createdAt: e.createdAt,
    task: {
      id: e.taskId,
      title: e.title,
      projectId: e.projectId,
      assigneeAgentId: e.assigneeAgentId,
      kind: e.kind,
      delegatorAgentId: e.delegatorAgentId,
      managerAgentId: e.managerAgentId,
    },
  }));
  const runIds = activeRuns.map((r) => r.id);
  const commentIds = idsIn(eventRows, ["questionId", "answerId", "commentId"]);
  const sourceIds = idsIn(
    eventRows.filter((e) => e.type === "handoff"),
    ["fromTaskId"],
  );

  const [steps, comments, handoffSources] = await Promise.all([
    runIds.length
      ? db
          .selectDistinctOn([runEvents.runId], {
            runId: runEvents.runId,
            tools: sql<string[] | null>`jsonb_path_query_array(${runEvents.data}, '$.toolCalls[*].name')`,
          })
          .from(runEvents)
          .where(and(inArray(runEvents.runId, runIds), eq(runEvents.type, "step")))
          .orderBy(runEvents.runId, desc(runEvents.id))
      : [],
    commentIds.length
      ? db
          .select({
            id: taskComments.id,
            authorAgentId: taskComments.authorAgentId,
            addresseeAgentId: taskComments.addresseeAgentId,
            addressedToUser: taskComments.addressedToUser,
            body: taskComments.body,
          })
          .from(taskComments)
          .where(inArray(taskComments.id, commentIds))
      : [],
    sourceIds.length
      ? db.select({ id: tasks.id, assigneeAgentId: tasks.assigneeAgentId }).from(tasks).where(inArray(tasks.id, sourceIds))
      : [],
  ]);
  const toolsByRun = new Map(steps.map((s) => [s.runId, s.tools]));

  return buildOfficeState(
    {
      agents: agentRows,
      projects: projectRows.flatMap((p) => (p.status === "archived" ? [] : [{ ...p, status: p.status }])),
      memberships,
      activeRuns: activeRuns.flatMap((r) =>
        r.status === "queued" || r.status === "running" || r.status === "waiting_approval"
          ? [{ ...r, status: r.status, lastStepTools: toolsByRun.get(r.id) ?? null }]
          : [],
      ),
      openTasks: openTasks.flatMap((t) =>
        t.assigneeAgentId && (t.status === "blocked" || t.status === "in_progress")
          ? [{ ...t, assigneeAgentId: t.assigneeAgentId, status: t.status }]
          : [],
      ),
      userQuestions: userQuestions.flatMap((q) => (q.authorAgentId ? [{ ...q, authorAgentId: q.authorAgentId }] : [])),
      events: eventRows,
      comments,
      handoffSources,
      reports: reports.flatMap((r) =>
        r.reportedAt && r.delegatorAgentId
          ? [{ ...r, reportedAt: r.reportedAt, delegatorAgentId: r.delegatorAgentId }]
          : [],
      ),
    },
    now,
  );
}
