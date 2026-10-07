import {
  type AgentSnapshot,
  type ToolPermissions,
  type Tx,
  agentMcpServers,
  agents,
  agentSkills,
  agentVersions,
  db,
  mcpServers,
  projectAgents,
  projects,
  runs,
  skills,
  toAgentAvatar,
} from "@abotica/db";
import { and, eq, inArray, like } from "@abotica/db/orm";
import { getTranslator, UserError } from "@abotica/i18n";
import { sanitizePermissions } from "./permissions";
import { audit } from "../platform/audit";
import { cancelRun } from "../runs/runs";
import { getSettings, settingsLocale } from "../platform/settings";
import { slugify } from "../platform/slug";

/** Agent configuration with versioning: every change to a snapshot field creates a new version. */

type Agent = typeof agents.$inferSelect;

type AgentRelations = { skillIds: string[]; mcpServerIds: string[]; projectIds: string[] };

/** Versioned agent fields; skills, MCP servers and projects travel separately as id lists. */
type AgentConfig = Pick<
  Agent,
  | "name"
  | "role"
  | "avatar"
  | "systemPrompt"
  | "provider"
  | "model"
  | "fallbacks"
  | "reasoningEffort"
  | "permissions"
  | "limits"
>;

export function snapshotOf(agent: AgentConfig, skillIds: string[], mcpServerIds: string[]): AgentSnapshot {
  return {
    name: agent.name,
    role: agent.role,
    avatar: agent.avatar,
    systemPrompt: agent.systemPrompt,
    provider: agent.provider,
    model: agent.model,
    fallbacks: agent.fallbacks,
    reasoningEffort: agent.reasoningEffort,
    permissions: agent.permissions,
    limits: agent.limits,
    skillIds,
    mcpServerIds,
  };
}

const sortedKeys = (p: ToolPermissions): ToolPermissions =>
  Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)));

/** Order-insensitive for id sets and permission keys, so re-saving the same selection is not a new version. */
function normalizeSnapshot(s: AgentSnapshot): AgentSnapshot {
  return {
    ...s,
    // jsonb reorders object keys, so rebuild objects before comparing them as JSON.
    avatar: toAgentAvatar(s.avatar),
    fallbacks: s.fallbacks.map((f) => ({ provider: f.provider, model: f.model })),
    reasoningEffort: s.reasoningEffort ?? "default",
    permissions: sortedKeys(s.permissions ?? {}),
    skillIds: [...s.skillIds].sort(),
    mcpServerIds: [...s.mcpServerIds].sort(),
    limits: { maxSteps: s.limits.maxSteps, timeoutMs: s.limits.timeoutMs, budgetUsd: s.limits.budgetUsd ?? null },
  };
}

/** Compared fields, in display order; labels live in the agents.versions.fields messages. */
const SNAPSHOT_FIELDS = [
  "name",
  "role",
  "avatar",
  "systemPrompt",
  "provider",
  "model",
  "fallbacks",
  "reasoningEffort",
  "permissions",
  "limits",
  "skillIds",
  "mcpServerIds",
] as const satisfies readonly (keyof AgentSnapshot)[];

export function changedFields(a: AgentSnapshot, b: AgentSnapshot): (keyof AgentSnapshot)[] {
  const na = normalizeSnapshot(a);
  const nb = normalizeSnapshot(b);
  return SNAPSHOT_FIELDS.filter((k) => JSON.stringify(na[k]) !== JSON.stringify(nb[k]));
}

export async function uniqueAgentSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name, 48) || "agent";
  const taken = new Set(
    (
      await tx
        .select({ slug: agents.slug })
        .from(agents)
        .where(like(agents.slug, `${base}%`))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Keeps only ids that still exist, so restoring an old snapshot never trips a foreign key. */
export async function existingIds(
  tx: Tx,
  input: { skillIds: string[]; mcpServerIds: string[]; projectIds?: string[] },
): Promise<{ skillIds: string[]; mcpServerIds: string[]; projectIds?: string[] }> {
  const uniq = (ids: string[]) => [...new Set(ids)];
  const [s, m, p] = await Promise.all([
    input.skillIds.length
      ? tx
          .select({ id: skills.id })
          .from(skills)
          .where(inArray(skills.id, uniq(input.skillIds)))
      : [],
    input.mcpServerIds.length
      ? tx
          .select({ id: mcpServers.id })
          .from(mcpServers)
          .where(inArray(mcpServers.id, uniq(input.mcpServerIds)))
      : [],
    input.projectIds?.length
      ? tx
          .select({ id: projects.id })
          .from(projects)
          .where(inArray(projects.id, uniq(input.projectIds)))
      : [],
  ]);
  return {
    skillIds: s.map((r) => r.id),
    mcpServerIds: m.map((r) => r.id),
    projectIds: input.projectIds && p.map((r) => r.id),
  };
}

/**
 * Replaces the agent's skills and MCP servers, and its projects when `projectIds` is given. A manager
 * stays on the projects it manages: another manager has to be chosen before it can leave.
 */
export async function replaceJoins(
  tx: Tx,
  agentId: string,
  ids: { skillIds: string[]; mcpServerIds: string[]; projectIds?: string[] },
): Promise<void> {
  await tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
  await tx.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId));
  if (ids.skillIds.length) await tx.insert(agentSkills).values(ids.skillIds.map((skillId) => ({ agentId, skillId })));
  if (ids.mcpServerIds.length) {
    await tx.insert(agentMcpServers).values(ids.mcpServerIds.map((mcpServerId) => ({ agentId, mcpServerId })));
  }
  if (ids.projectIds) {
    const managed = await tx.select({ id: projects.id }).from(projects).where(eq(projects.managerAgentId, agentId));
    const projectIds = [...new Set([...ids.projectIds, ...managed.map((p) => p.id)])];
    await tx.delete(projectAgents).where(eq(projectAgents.agentId, agentId));
    if (projectIds.length) {
      await tx.insert(projectAgents).values(projectIds.map((projectId) => ({ agentId, projectId })));
    }
  }
}

/** Agents seeded before versioning have no row for their current version; store it before moving on. */
export async function ensureCurrentVersionRow(tx: Tx, agent: Agent, snapshot: AgentSnapshot, note: string) {
  await tx
    .insert(agentVersions)
    .values({ agentId: agent.id, version: agent.version, snapshot, note })
    .onConflictDoNothing();
}

/** Locks the agent row for the rest of the transaction. */
export async function lockAgent(tx: Tx, id: string): Promise<Agent> {
  const [agent] = await tx.select().from(agents).where(eq(agents.id, id)).for("update");
  if (!agent) throw new UserError("agents.errors.notFound");
  return agent;
}

/**
 * Deletes an agent; the super agent stays. Its unfinished runs are cancelled first: runs outlive their
 * agent (agent_id is set null) for history and costs, but must not keep executing. The agent row stays
 * locked until the delete commits, and a new run's row references it, so a run started meanwhile (by a
 * schedule or trigger) waits for the lock and then fails on the missing agent instead of slipping in.
 */
export async function deleteAgent(id: string, opts: { actor?: string } = {}): Promise<void> {
  // Stored in each cancelled run's error, so written in the configured language.
  const reason = getTranslator(settingsLocale(await getSettings()))("runs.errors.agentDeleted");
  const agent = await db.transaction(async (tx) => {
    const agent = await lockAgent(tx, id);
    if (agent.isOrchestrator) throw new UserError("agents.errors.orchestratorDelete");
    const unfinished = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.agentId, id), inArray(runs.status, ["queued", "running", "waiting_approval"])));
    // cancelRun works outside this transaction and writes nothing that references the agent, so it never
    // waits on the lock held here.
    for (const run of unfinished) await cancelRun(run.id, reason, "other");
    await tx.delete(agents).where(eq(agents.id, id));
    return agent;
  });
  await audit({
    actor: opts.actor ?? "user",
    action: "agent.deleted",
    entityType: "agent",
    entityId: id,
    data: { slug: agent.slug },
  });
}

export async function currentSnapshot(tx: Tx, agent: Agent): Promise<AgentSnapshot> {
  const [s, m] = await Promise.all([
    tx.select({ id: agentSkills.skillId }).from(agentSkills).where(eq(agentSkills.agentId, agent.id)),
    tx.select({ id: agentMcpServers.mcpServerId }).from(agentMcpServers).where(eq(agentMcpServers.agentId, agent.id)),
  ]);
  return snapshotOf(
    agent,
    s.map((r) => r.id),
    m.map((r) => r.id),
  );
}

/** Version notes are stored text, written in the configured language. */
export async function versionNotes() {
  const t = getTranslator(settingsLocale(await getSettings()));
  return {
    initial: t("agents.versionNotes.initial"),
    fromTemplate: (slug: string) => t("agents.versionNotes.fromTemplate", { slug }),
  };
}

/** Provider, model and fallbacks stay consistent: all inherited, or an explicit primary model. */
function normalizeModel<T extends { provider: string | null; model: string | null; fallbacks: unknown[] }>(input: T): T {
  if (!input.provider || !input.model) return { ...input, provider: null, model: null, fallbacks: [] };
  return input;
}

/** Inserts an agent with its first version; non-orchestrator permissions are enforced. */
async function insertAgent(
  tx: Tx,
  config: AgentConfig,
  relations: Partial<AgentRelations>,
  opts: { note: string },
): Promise<Agent> {
  const values = normalizeModel(config);
  const permissions = sanitizePermissions(values.permissions, { isOrchestrator: false, isManager: false });
  const ids = await existingIds(tx, {
    skillIds: relations.skillIds ?? [],
    mcpServerIds: relations.mcpServerIds ?? [],
    projectIds: relations.projectIds ?? [],
  });
  const [agent] = await tx
    .insert(agents)
    .values({ ...values, permissions, slug: await uniqueAgentSlug(tx, values.name), version: 1 })
    .returning();
  await replaceJoins(tx, agent!.id, ids);
  await tx.insert(agentVersions).values({
    agentId: agent!.id,
    version: 1,
    snapshot: snapshotOf(agent!, ids.skillIds, ids.mcpServerIds),
    note: opts.note,
  });
  return agent!;
}

/** Creates an agent with its first version; non-orchestrator permissions are enforced. */
export async function createAgentConfig(
  config: AgentConfig,
  relations: Partial<AgentRelations>,
  opts: { note: string },
): Promise<Agent> {
  return db.transaction((tx) => insertAgent(tx, config, relations, opts));
}

/**
 * `createAgentFromTemplate` inside a running transaction, for callers that create more around it
 * (a project and its manager). Writes no audit entry; the caller does once the transaction commits.
 */
export async function insertAgentFromTemplate(
  tx: Tx,
  templateSlug: string,
  opts: { name?: string; projectId?: string | null },
): Promise<Agent> {
  const [template] = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.slug, templateSlug), eq(agents.isTemplate, true)));
  if (!template) throw new UserError("team.errors.templateNotFound");
  if (opts.projectId) {
    const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, opts.projectId));
    if (!project) throw new UserError("projects.errors.notFound");
  }
  const [skillIds, mcpServerIds] = await templateJoins(tx, template.id);
  return insertAgent(
    tx,
    {
      name: opts.name?.trim() || template.name,
      role: template.role,
      avatar: template.avatar,
      systemPrompt: template.systemPrompt,
      provider: template.provider,
      model: template.model,
      fallbacks: template.fallbacks,
      reasoningEffort: template.reasoningEffort,
      permissions: template.permissions,
      limits: template.limits,
    },
    { skillIds, mcpServerIds, projectIds: opts.projectId ? [opts.projectId] : [] },
    { note: (await versionNotes()).fromTemplate(templateSlug) },
  );
}

async function templateJoins(tx: Tx, templateId: string): Promise<[string[], string[]]> {
  const [s, m] = await Promise.all([
    tx.select({ id: agentSkills.skillId }).from(agentSkills).where(eq(agentSkills.agentId, templateId)),
    tx.select({ id: agentMcpServers.mcpServerId }).from(agentMcpServers).where(eq(agentMcpServers.agentId, templateId)),
  ]);
  return [s.map((r) => r.id), m.map((r) => r.id)];
}

/**
 * A new agent from a template: its configuration, skills and MCP servers, with a first version noting
 * the template. With `projectId` it joins that project's team.
 */
export async function createAgentFromTemplate(
  templateSlug: string,
  opts: { name?: string; projectId?: string | null; actor?: string },
): Promise<Agent> {
  const agent = await db.transaction((tx) => insertAgentFromTemplate(tx, templateSlug, opts));
  await audit({
    actor: opts.actor ?? "user",
    action: "agent.created",
    entityType: "agent",
    entityId: agent.id,
    data: { templateSlug, ...(opts.projectId && { projectId: opts.projectId }) },
  });
  return agent;
}

/**
 * Applies a partial change. Fields left out keep their value; a change to any snapshot field
 * bumps the version and stores the new snapshot, so it can be compared and rolled back.
 */
export async function updateAgentConfig(
  id: string,
  patch: Partial<AgentConfig> & Partial<AgentRelations>,
  opts: { note?: string } = {},
): Promise<{ agent: Agent; version: number; changed: (keyof AgentSnapshot)[] }> {
  const { skillIds, mcpServerIds, ...fields } = patch;
  const notes = await versionNotes();
  return db.transaction(async (tx) => {
    const agent = await lockAgent(tx, id);
    // The super agent is never a project member.
    const projectIds = agent.isOrchestrator ? undefined : patch.projectIds;
    const before = await currentSnapshot(tx, agent);
    const merged = normalizeModel({ ...agent, ...fields });
    const values: AgentConfig = {
      name: merged.name,
      role: merged.role,
      avatar: merged.avatar,
      systemPrompt: merged.systemPrompt,
      provider: merged.provider,
      model: merged.model,
      fallbacks: merged.fallbacks,
      reasoningEffort: merged.reasoningEffort,
      // Manager tools are kept for every non-orchestrator, so whether it manages a project does not matter here.
      permissions: sanitizePermissions(merged.permissions, { isOrchestrator: agent.isOrchestrator, isManager: false }),
      limits: merged.limits,
    };
    const ids = await existingIds(tx, {
      skillIds: skillIds ?? before.skillIds,
      mcpServerIds: mcpServerIds ?? before.mcpServerIds,
      projectIds,
    });
    const after = snapshotOf(values, ids.skillIds, ids.mcpServerIds);
    const changed = changedFields(before, after);
    const version = changed.length ? agent.version + 1 : agent.version;

    const [updated] = await tx
      .update(agents)
      .set({ ...values, version })
      .where(eq(agents.id, id))
      .returning();
    await replaceJoins(tx, id, ids);
    if (changed.length) {
      await ensureCurrentVersionRow(tx, agent, before, notes.initial);
      await tx.insert(agentVersions).values({ agentId: id, version, snapshot: after, note: opts.note ?? "" });
    }
    return { agent: updated!, version, changed };
  });
}
