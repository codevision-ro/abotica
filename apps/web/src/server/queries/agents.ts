import "server-only";
import {
  PROVIDER_IDS,
  PROVIDERS,
  type CatalogModel,
  consumptionOf,
  getCatalog,
  getSettings,
  isProviderConfigured,
  type ModelConsumption,
  searchJournals,
} from "@abotica/core";
import type { ReasoningSupport } from "@abotica/core/models/reasoning";
import type { ModelSettings } from "@abotica/core/settings";
import {
  type AgentLimits,
  type McpToolInfo,
  agentMcpServers,
  agents,
  agentSkills,
  agentVersions,
  db,
  journals,
  mcpServers,
  memories,
  projectAgents,
  projects,
  runs,
  schedules,
  skills,
  toAgentAvatar,
} from "@abotica/db";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "@abotica/db/orm";
import { getMemberActivity } from "./projects";
import { query } from "@/server/query";

export type Agent = typeof agents.$inferSelect;

type ProviderOption = { id: string; label: string; configured: boolean };

export type ModelOption = {
  id: string;
  name: string;
  provider: string;
  contextWindow: number | null;
  /** Reasoning efforts it accepts, per the catalog; null when it does not reason. */
  reasoning: ReasoningSupport | null;
  cost: { input: number; output: number } | null;
  /** From the list price, so a plan model shows what it takes of the plan's limit; null without a price. */
  consumption: ModelConsumption | null;
};

export type AgentFormOptions = {
  providers: ProviderOption[];
  /** Default chain per role from settings, used by agents with no model of their own (see roleDefaultModels). */
  chains: ModelSettings["chains"];
  /** Effort per role from settings, used by agents whose effort is "default" (see roleDefaultEffort). */
  reasoningEffort: ModelSettings["reasoningEffort"];
  /** Limits a new agent starts with (Settings > Agents). */
  defaultLimits: AgentLimits;
  models: ModelOption[];
  skills: { id: string; name: string; description: string }[];
  mcpServers: {
    id: string;
    slug: string;
    name: string;
    /** For its icon. */
    transport: "http" | "stdio";
    enabled: boolean;
    /** Offered to every agent: listed under its tools, never stored as an assignment. */
    global: boolean;
    /** Key of a bundled server, null for one the user added. */
    builtin: string | null;
    /** Tools seen on the last successful connection; null until the server was reached once. */
    tools: McpToolInfo[] | null;
    toolsSyncedAt: Date | null;
  }[];
  /** Projects the agent can join; `managerAgentId` locks the membership of the agent that manages one. */
  projects: { id: string; name: string; managerAgentId: string | null }[];
};

/** The agents (templates are offered on /agents/new), with their recent activity and projects. */
export const getAgentList = query(async () => {
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.isTemplate, false))
    .orderBy(asc(agents.kind), asc(agents.name));
  const ids = rows.map((a) => a.id);
  if (!ids.length) return [];

  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const since30 = new Date(Date.now() - 30 * 86_400_000);
  const [stats, assigned, led] = await Promise.all([
    db
      .select({
        agentId: runs.agentId,
        runs7d: sql<number>`count(*) filter (where ${runs.createdAt} >= ${since7}::timestamptz)`.mapWith(Number),
        cost30d: sql<number>`coalesce(sum(${runs.costUsd}), 0)`.mapWith(Number),
      })
      .from(runs)
      .where(and(inArray(runs.agentId, ids), gte(runs.createdAt, since30)))
      .groupBy(runs.agentId),
    db
      .select({ agentId: projectAgents.agentId, id: projects.id, name: projects.name })
      .from(projectAgents)
      .innerJoin(projects, eq(projects.id, projectAgents.projectId))
      .where(inArray(projectAgents.agentId, ids))
      .orderBy(asc(projects.name)),
    db
      .select({ agentId: projects.managerAgentId, id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.managerAgentId, ids))
      .orderBy(asc(projects.name)),
  ]);
  const running = await db
    .selectDistinct({ agentId: runs.agentId })
    .from(runs)
    .where(and(inArray(runs.agentId, ids), eq(runs.status, "running")));
  const runningSet = new Set(running.map((r) => r.agentId));
  const statsBy = new Map(stats.map((s) => [s.agentId, s]));

  const enriched = rows.map((a) => ({
    ...a,
    runs7d: statsBy.get(a.id)?.runs7d ?? 0,
    cost30d: statsBy.get(a.id)?.cost30d ?? 0,
    running: runningSet.has(a.id),
    // A manager's projects are the ones it leads; a specialist's, the teams it is on.
    projects: (a.kind === "manager" ? led : assigned)
      .filter((p) => p.agentId === a.id)
      .map((p) => ({ id: p.id, name: p.name })),
  }));
  return enriched;
});

export const getAgentRelations = query(async (agentId: string) => {
  const [s, m, p] = await Promise.all([
    db.select({ id: agentSkills.skillId }).from(agentSkills).where(eq(agentSkills.agentId, agentId)),
    db.select({ id: agentMcpServers.mcpServerId }).from(agentMcpServers).where(eq(agentMcpServers.agentId, agentId)),
    db.select({ id: projectAgents.projectId }).from(projectAgents).where(eq(projectAgents.agentId, agentId)),
  ]);
  return { skillIds: s.map((r) => r.id), mcpServerIds: m.map((r) => r.id), projectIds: p.map((r) => r.id) };
});

export const getAgent = query(async (id: string) => {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) return null;
  return { agent, ...(await getAgentRelations(id)) };
});

export const getTemplateBySlug = query(async (slug: string) => {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.slug, slug), eq(agents.isTemplate, true)));
  if (!agent) return null;
  return { agent, ...(await getAgentRelations(agent.id)) };
});

export const listTemplates = query(async () => {
  return db.select().from(agents).where(eq(agents.isTemplate, true)).orderBy(asc(agents.name));
});

async function safeCatalog(): Promise<CatalogModel[]> {
  try {
    return await getCatalog();
  } catch {
    return [];
  }
}

export const getAgentFormOptions = query(async (): Promise<AgentFormOptions> => {
  const [catalog, configured, skillRows, mcpRows, projectRows] = await Promise.all([
    safeCatalog(),
    Promise.all(PROVIDER_IDS.map((p) => isProviderConfigured(p).catch(() => false))),
    db
      .select({ id: skills.id, name: skills.name, description: skills.description })
      .from(skills)
      .where(eq(skills.enabled, true))
      .orderBy(asc(skills.name)),
    db
      .select({
        id: mcpServers.id,
        slug: mcpServers.slug,
        name: mcpServers.name,
        transport: mcpServers.transport,
        enabled: mcpServers.enabled,
        global: mcpServers.global,
        builtin: mcpServers.builtin,
        tools: mcpServers.tools,
        toolsSyncedAt: mcpServers.toolsSyncedAt,
      })
      .from(mcpServers)
      .orderBy(asc(mcpServers.name)),
    db
      .select({ id: projects.id, name: projects.name, managerAgentId: projects.managerAgentId })
      .from(projects)
      .where(sql`${projects.status} <> 'archived'`)
      .orderBy(asc(projects.name)),
  ]);
  const settings = await getSettings();
  return {
    chains: settings.models.chains,
    reasoningEffort: settings.models.reasoningEffort,
    defaultLimits: settings.agents.defaultLimits,
    providers: PROVIDER_IDS.map((id, i) => ({ id, label: PROVIDERS[id].label, configured: configured[i] ?? false })),
    models: catalog
      .filter((m) => m.toolCall)
      .map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        contextWindow: m.contextWindow,
        reasoning: m.reasoning,
        cost: m.cost ? { input: m.cost.input, output: m.cost.output } : null,
        consumption: consumptionOf(m.listPrice),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    skills: skillRows,
    mcpServers: mcpRows,
    projects: projectRows,
  };
});

/** The versions list, without snapshots: a snapshot holds the full prompt, loaded only for a compared version. */
export const listAgentVersions = query(async (agentId: string) => {
  return db
    .select({
      id: agentVersions.id,
      version: agentVersions.version,
      note: agentVersions.note,
      createdAt: agentVersions.createdAt,
    })
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(agentVersions.version));
});

/** One version's snapshot, or null when the agent has no such version. */
export const getAgentVersionSnapshot = query(async (agentId: string, version: number) => {
  const [row] = await db
    .select({ snapshot: agentVersions.snapshot })
    .from(agentVersions)
    .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, version)));
  // Older snapshots may still hold an emoji string.
  return row ? { ...row.snapshot, avatar: toAgentAvatar(row.snapshot.avatar) } : null;
});

/**
 * The projects an agent is on, for its Projects tab: whether it manages each one and what it did there
 * (team entries it wrote and its own notes on the project, journal days, open tasks, latest run). Projects
 * it manages come first.
 */
export const listAgentProjects = query(async (agentId: string) => {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      isManager: sql<boolean>`${projects.managerAgentId} is not distinct from ${agentId}`,
    })
    .from(projects)
    // The projects it leads (a manager's) and the teams it is on (a specialist's).
    .where(
      or(
        eq(projects.managerAgentId, agentId),
        inArray(
          projects.id,
          db.select({ id: projectAgents.projectId }).from(projectAgents).where(eq(projectAgents.agentId, agentId)),
        ),
      ),
    )
    .orderBy(desc(sql`${projects.managerAgentId} is not distinct from ${agentId}`), asc(projects.name));
  const ids = rows.map((p) => p.id);
  const [activity, learned] = await Promise.all([
    getMemberActivity({ projectIds: ids, agentIds: [agentId] }),
    ids.length
      ? db
          .select({
            id: memories.id,
            projectId: memories.projectId,
            content: memories.content,
            updatedAt: memories.updatedAt,
          })
          .from(memories)
          .where(
            and(
              // Team entries it wrote and its own notes on the project.
              inArray(memories.scope, ["project", "agent"]),
              eq(memories.status, "active"),
              eq(memories.agentId, agentId),
              inArray(memories.projectId, ids),
            ),
          )
          .orderBy(desc(memories.updatedAt))
      : [],
  ]);
  return rows.map((p) => ({
    ...p,
    activity: activity(p.id, agentId),
    memories: learned.filter((m) => m.projectId === p.id),
  }));
});

export type AgentProject = Awaited<ReturnType<typeof listAgentProjects>>[number];

/**
 * The agent's journal days, newest first, or the best matches for `query` (hybrid search, keyword
 * only without embeddings), each with its project. `projectId` narrows them: a project id, null for work outside
 * projects, undefined for all.
 */
export const listAgentJournals = query(
  async (agentId: string, opts: { query?: string; projectId?: string | null } = {}) => {
    const rows = opts.query
      ? (await searchJournals(opts.query, { agentId, projectId: opts.projectId, limit: 20 })).map((j) => ({
          key: `${j.projectId}:${j.day}`,
          ...j,
        }))
      : (
          await db
            .select({ id: journals.id, day: journals.day, summary: journals.summary, projectId: journals.projectId })
            .from(journals)
            .where(
              and(
                eq(journals.agentId, agentId),
                opts.projectId === undefined
                  ? undefined
                  : opts.projectId
                    ? eq(journals.projectId, opts.projectId)
                    : isNull(journals.projectId),
              ),
            )
            .orderBy(desc(journals.day))
            .limit(60)
        ).map((j) => ({ key: j.id, ...j }));
    const names = await projectNames(rows.flatMap((j) => (j.projectId ? [j.projectId] : [])));
    return rows.map((j) => ({
      key: j.key,
      day: j.day,
      summary: j.summary,
      project: j.projectId ? { id: j.projectId, name: names.get(j.projectId) ?? "" } : null,
    }));
  },
);

async function projectNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, [...new Set(ids)]));
  return new Map(rows.map((p) => [p.id, p.name]));
}

/** Projects the agent kept a journal in, by name: the choices of the Journal tab's project filter. */
export const listAgentJournalProjects = query(async (agentId: string) => {
  return db
    .selectDistinct({ id: projects.id, name: projects.name })
    .from(journals)
    .innerJoin(projects, eq(projects.id, journals.projectId))
    .where(eq(journals.agentId, agentId))
    .orderBy(asc(projects.name));
});

export const listAgentRuns = query(async (agentId: string, limit: number = 50) => {
  return db
    .select({
      id: runs.id,
      status: runs.status,
      trigger: runs.trigger,
      input: runs.input,
      model: runs.model,
      costUsd: runs.costUsd,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(eq(runs.agentId, agentId))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
});

/** How many schedules run the agent: the Activity tab links to them in Automations. */
export const countAgentSchedules = query(async (agentId: string) => {
  const [row] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(schedules)
    .where(eq(schedules.agentId, agentId));
  return row?.count ?? 0;
});

/** Names for skill/MCP ids referenced by snapshots (ids may point to deleted rows). */
export const getRegistryNames = query(async () => {
  const [s, m] = await Promise.all([
    db.select({ id: skills.id, name: skills.name }).from(skills),
    db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers),
  ]);
  return Object.fromEntries([...s, ...m].map((r) => [r.id, r.name])) as Record<string, string>;
});
