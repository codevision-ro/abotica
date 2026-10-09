import "server-only";
import { getSettings, canJoinTeam, canLeadProject, listProjectRepos as listRepos, startOfMonth } from "@abotica/core";
import {
  agents,
  db,
  files,
  journals,
  knowledgeChunks,
  knowledgeItems,
  memories,
  projectAgents,
  projects,
  runs,
  secrets,
  tasks,
} from "@abotica/db";
import { and, asc, count, countDistinct, desc, eq, gte, inArray, max, ne, sql, sum } from "@abotica/db/orm";
import { query } from "@/server/query";

export type ProjectFilter = "active" | "all" | "archived";

/** Month spend uses the configured timezone, like the costs page. */
const monthStart = async () => startOfMonth((await getSettings()).general.timezone);

export const listProjects = query(async (filter: ProjectFilter) => {
  const where =
    filter === "active"
      ? ne(projects.status, "archived")
      : filter === "archived"
        ? eq(projects.status, "archived")
        : undefined;
  const rows = await db.select().from(projects).where(where).orderBy(desc(projects.updatedAt));
  if (!rows.length) return [];
  const ids = rows.map((p) => p.id);

  const from = await monthStart();
  const [assigned, taskCounts, spend] = await Promise.all([
    db
      .select({ projectId: projectAgents.projectId, id: agents.id, name: agents.name, avatar: agents.avatar })
      .from(projectAgents)
      .innerJoin(agents, eq(agents.id, projectAgents.agentId))
      .innerJoin(projects, eq(projects.id, projectAgents.projectId))
      .where(inArray(projectAgents.projectId, ids))
      // The manager leads the avatar stack.
      .orderBy(desc(sql`${agents.id} = ${projects.managerAgentId}`), asc(agents.name)),
    db
      .select({ projectId: tasks.projectId, done: sql<boolean>`${tasks.status} = 'done'`, n: count() })
      .from(tasks)
      .where(inArray(tasks.projectId, ids))
      .groupBy(tasks.projectId, sql`${tasks.status} = 'done'`),
    db
      .select({ projectId: runs.projectId, total: sum(runs.costUsd) })
      .from(runs)
      .where(and(inArray(runs.projectId, ids), gte(runs.createdAt, from)))
      .groupBy(runs.projectId),
  ]);

  return rows.map((p) => ({
    ...p,
    agents: assigned.filter((a) => a.projectId === p.id),
    openTasks: taskCounts.find((t) => t.projectId === p.id && !t.done)?.n ?? 0,
    doneTasks: taskCounts.find((t) => t.projectId === p.id && t.done)?.n ?? 0,
    monthSpend: Number(spend.find((s) => s.projectId === p.id)?.total ?? 0),
  }));
});

export type ProjectListItem = Awaited<ReturnType<typeof listProjects>>[number];

export const getProject = query(async (id: string) => {
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  return project ?? null;
});

export type ProjectDetail = NonNullable<Awaited<ReturnType<typeof getProject>>>;

const agentSummary = {
  id: agents.id,
  name: agents.name,
  avatar: agents.avatar,
  role: agents.role,
  enabled: agents.enabled,
};

/** Agents that can join a project's team, by core's rule (enabled specialists, see canJoinTeam), by name. */
export const listJoinableAgents = query(async () => {
  const rows = await db
    .select({ ...agentSummary, isTemplate: agents.isTemplate, kind: agents.kind })
    .from(agents)
    .orderBy(asc(agents.name));
  return rows
    .filter(canJoinTeam)
    .map((a) => ({ id: a.id, name: a.name, avatar: a.avatar, role: a.role, enabled: a.enabled }));
});

/** Managers that can lead a project, by core's rule (enabled managers, see canLeadProject), by name. */
export const listLeadableAgents = query(async () => {
  const rows = await db
    .select({ ...agentSummary, isTemplate: agents.isTemplate, kind: agents.kind })
    .from(agents)
    .orderBy(asc(agents.name));
  return rows
    .filter(canLeadProject)
    .map((a) => ({ id: a.id, name: a.name, avatar: a.avatar, role: a.role, enabled: a.enabled }));
});

export type JoinableAgent = Awaited<ReturnType<typeof listJoinableAgents>>[number];
export type LeadableAgent = Awaited<ReturnType<typeof listLeadableAgents>>[number];

/** Specialist templates a project can hire from; the manager has its own path ("Create manager"). */
export const listHireTemplates = query(async () => {
  return db
    .select({ slug: agents.slug, name: agents.name, avatar: agents.avatar, role: agents.role })
    .from(agents)
    .where(and(eq(agents.isTemplate, true), eq(agents.kind, "specialist")))
    .orderBy(asc(agents.name));
});

export type HireTemplate = Awaited<ReturnType<typeof listHireTemplates>>[number];

export type MemberActivity = { memories: number; journalDays: number; openTasks: number; lastActiveAt: Date | null };

const EMPTY_ACTIVITY: MemberActivity = { memories: 0, journalDays: 0, openTasks: 0, lastActiveAt: null };

/**
 * What agents did in projects, per (project, agent) pair: team entries they wrote and their own notes on
 * the project (active ones), journal days, open tasks assigned to them and their latest run there.
 */
export const getMemberActivity = query(
  async (where: {
    projectIds: string[];
    agentIds: string[];
  }): Promise<(projectId: string, agentId: string) => MemberActivity> => {
    const { projectIds, agentIds } = where;
    if (!projectIds.length || !agentIds.length) return () => EMPTY_ACTIVITY;
    const [memoryRows, journalRows, taskRows, runRows] = await Promise.all([
      db
        .select({ projectId: memories.projectId, agentId: memories.agentId, n: count() })
        .from(memories)
        .where(
          and(
            // Team entries the agent wrote and its own notes on the project.
            inArray(memories.scope, ["project", "agent"]),
            eq(memories.status, "active"),
            inArray(memories.projectId, projectIds),
            inArray(memories.agentId, agentIds),
          ),
        )
        .groupBy(memories.projectId, memories.agentId),
      db
        .select({ projectId: journals.projectId, agentId: journals.agentId, n: countDistinct(journals.day) })
        .from(journals)
        .where(and(inArray(journals.projectId, projectIds), inArray(journals.agentId, agentIds)))
        .groupBy(journals.projectId, journals.agentId),
      db
        .select({ projectId: tasks.projectId, agentId: tasks.assigneeAgentId, n: count() })
        .from(tasks)
        .where(
          and(inArray(tasks.projectId, projectIds), inArray(tasks.assigneeAgentId, agentIds), ne(tasks.status, "done")),
        )
        .groupBy(tasks.projectId, tasks.assigneeAgentId),
      db
        .select({ projectId: runs.projectId, agentId: runs.agentId, at: max(runs.createdAt) })
        .from(runs)
        .where(and(inArray(runs.projectId, projectIds), inArray(runs.agentId, agentIds)))
        .groupBy(runs.projectId, runs.agentId),
    ]);
    const key = (projectId: string | null, agentId: string | null) => `${projectId}:${agentId}`;
    const index = <T extends { projectId: string | null; agentId: string | null }>(rows: T[]) =>
      new Map(rows.map((r) => [key(r.projectId, r.agentId), r]));
    const [m, j, t, r] = [index(memoryRows), index(journalRows), index(taskRows), index(runRows)];
    return (projectId: string, agentId: string): MemberActivity => {
      const k = key(projectId, agentId);
      return {
        memories: m.get(k)?.n ?? 0,
        journalDays: j.get(k)?.n ?? 0,
        openTasks: t.get(k)?.n ?? 0,
        lastActiveAt: r.get(k)?.at ?? null,
      };
    };
  },
);

/** The project's team for its Team tab: the manager (null when it has none) and the specialists, with their activity there. */
export const getProjectTeam = query(async (project: Pick<ProjectDetail, "id" | "managerAgentId">) => {
  const members = await db
    .select(agentSummary)
    .from(projectAgents)
    .innerJoin(agents, eq(agents.id, projectAgents.agentId))
    .where(eq(projectAgents.projectId, project.id))
    .orderBy(asc(agents.name));
  const activity = await getMemberActivity({ projectIds: [project.id], agentIds: members.map((a) => a.id) });
  const withActivity = members.map((a) => ({ ...a, activity: activity(project.id, a.id) }));
  return {
    manager: withActivity.find((a) => a.id === project.managerAgentId) ?? null,
    specialists: withActivity.filter((a) => a.id !== project.managerAgentId),
  };
});

export type ProjectTeam = Awaited<ReturnType<typeof getProjectTeam>>;
export type TeamMember = ProjectTeam["specialists"][number];

/** Agents that can still join the project: joinable and not on the team yet. */
export const listTeamCandidates = query(async (projectId: string) => {
  const [joinable, members] = await Promise.all([
    listJoinableAgents(),
    db.select({ id: projectAgents.agentId }).from(projectAgents).where(eq(projectAgents.projectId, projectId)),
  ]);
  const onTeam = new Set(members.map((m) => m.id));
  return joinable.filter((a) => !onTeam.has(a.id));
});

export const getProjectOverview = query(async (id: string) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const from = await monthStart();
  const [byStatus, [spend], [runsWeek], recentRuns] = await Promise.all([
    db.select({ status: tasks.status, n: count() }).from(tasks).where(eq(tasks.projectId, id)).groupBy(tasks.status),
    db
      .select({ total: sum(runs.costUsd) })
      .from(runs)
      .where(and(eq(runs.projectId, id), gte(runs.createdAt, from))),
    db
      .select({ n: count() })
      .from(runs)
      .where(and(eq(runs.projectId, id), gte(runs.createdAt, weekAgo))),
    db
      .select({
        id: runs.id,
        status: runs.status,
        trigger: runs.trigger,
        input: runs.input,
        costUsd: runs.costUsd,
        createdAt: runs.createdAt,
        agentName: agents.name,
        agentAvatar: agents.avatar,
      })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .where(eq(runs.projectId, id))
      .orderBy(desc(runs.createdAt))
      .limit(10),
  ]);
  return {
    tasksByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])) as Record<string, number>,
    monthSpend: Number(spend?.total ?? 0),
    runsLastWeek: runsWeek?.n ?? 0,
    recentRuns,
  };
});

export const listProjectTasks = query(async (id: string) => {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      deadline: tasks.deadline,
      updatedAt: tasks.updatedAt,
      assigneeName: agents.name,
      assigneeAvatar: agents.avatar,
      assignedToUser: tasks.assignedToUser,
    })
    .from(tasks)
    .leftJoin(agents, eq(agents.id, tasks.assigneeAgentId))
    .where(eq(tasks.projectId, id))
    .orderBy(asc(tasks.position), desc(tasks.updatedAt));
});

/** Knowledge items, newest first; a file item carries its stored file (the original, for download). */
export const listKnowledgeItems = query(async (id: string) => {
  return db
    .select({
      id: knowledgeItems.id,
      kind: knowledgeItems.kind,
      title: knowledgeItems.title,
      sourceUrl: knowledgeItems.sourceUrl,
      size: sql<number>`length(${knowledgeItems.content})`.mapWith(Number),
      chunks:
        sql<number>`(select count(*) from ${knowledgeChunks} where ${knowledgeChunks.itemId} = ${knowledgeItems.id})`.mapWith(
          Number,
        ),
      createdAt: knowledgeItems.createdAt,
      file: { id: files.id, name: files.name, mimeType: files.mimeType, size: files.size },
    })
    .from(knowledgeItems)
    .leftJoin(files, eq(files.knowledgeItemId, knowledgeItems.id))
    .where(eq(knowledgeItems.projectId, id))
    .orderBy(desc(knowledgeItems.createdAt));
});

export type KnowledgeItemRow = Awaited<ReturnType<typeof listKnowledgeItems>>[number];

/** Never selects the encrypted value. */
export const listProjectSecrets = query(async (id: string) => {
  return db
    .select({ id: secrets.id, name: secrets.name, description: secrets.description, updatedAt: secrets.updatedAt })
    .from(secrets)
    .where(eq(secrets.projectId, id))
    .orderBy(asc(secrets.name));
});

export type ProjectSecret = Awaited<ReturnType<typeof listProjectSecrets>>[number];

/** The project's repositories as the Repos tab shows them (no tokens). */
export const listProjectRepos = query((projectId: string) => listRepos(projectId));
