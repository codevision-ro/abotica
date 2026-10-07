import { agents, db, knowledgeItems, projectAgents, projects, tasks, type Tx } from "@abotica/db";
import { and, eq, inArray } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { insertAgentFromTemplate } from "../agents/agent-config";
import { audit } from "../platform/audit";
import { projectWorkspaceKey, requestWorkspaceRemoval } from "../sandbox/sandbox";
import { parseSandboxPolicy } from "../sandbox/sandbox-policy";
import { slugify } from "../platform/slug";
import { fileIdsOwnedBy, removeFileBytes } from "../files/files";
import { isAssignable, MANAGER_TEMPLATE_SLUG } from "../tasks/team-rules";

export type Project = typeof projects.$inferSelect;
type Agent = typeof agents.$inferSelect;
export type ProjectStatus = Project["status"];

export const PROJECT_STATUSES: ProjectStatus[] = ["active", "paused", "archived"];

type ProjectFields = Pick<
  Project,
  "name" | "description" | "goals" | "status" | "budgetUsd" | "allowedProviders" | "telegramTopicId" | "sandbox"
>;

/** Null follows the default policy from Settings > Sandbox; anything else must be a valid policy. */
const validSandbox = <T extends { sandbox?: unknown }>(fields: T): T =>
  fields.sandbox == null ? fields : { ...fields, sandbox: parseSandboxPolicy(fields.sandbox) };

async function uniqueProjectSlug(name: string): Promise<string> {
  const base = slugify(name, 60) || "project";
  let slug = base;
  for (let i = 0; i < 5; i++) {
    const [taken] = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug));
    if (!taken) return slug;
    slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

type TeamOptions = { actor?: string };

/** Loads the agents and throws unless every one exists and may join a project (see isAssignable). */
async function assignableAgents(ids: string[]): Promise<Agent[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db.select().from(agents).where(inArray(agents.id, unique));
  if (rows.length !== unique.length) throw new UserError("team.errors.agentNotFound");
  const refused = rows.find((a) => !isAssignable(a));
  if (refused) throw new UserError("team.errors.notAssignable", { name: refused.name });
  return rows;
}

async function projectById(id: string, tx: Tx | typeof db = db): Promise<Project> {
  const [project] = await tx.select().from(projects).where(eq(projects.id, id));
  if (!project) throw new UserError("projects.errors.notFound");
  return project;
}

const teamChanged = (projectId: string, actor: string | undefined, data: Record<string, unknown>) =>
  audit({ actor: actor ?? "user", action: "project.agents-changed", entityType: "project", entityId: projectId, data });

const managerName = (projectName: string) => `${projectName} Manager`;

/**
 * Creates a project with its team. Without `managerAgentId` its manager is created from the
 * project manager template; null leaves the project without one. The manager is always a member.
 */
export async function createProject(
  input: Pick<ProjectFields, "name"> &
    Partial<Omit<ProjectFields, "name">> & { memberIds?: string[]; managerAgentId?: string | null },
  opts: TeamOptions = {},
): Promise<Project> {
  const { memberIds = [], managerAgentId, ...rest } = input;
  const fields = validSandbox(rest);
  const slug = await uniqueProjectSlug(fields.name);
  await assignableAgents(managerAgentId ? [...memberIds, managerAgentId] : memberIds);
  const { project, created } = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(projects)
      .values({ ...fields, slug })
      .returning();
    const created =
      managerAgentId === undefined
        ? await insertAgentFromTemplate(tx, MANAGER_TEMPLATE_SLUG, {
            name: managerName(fields.name),
            projectId: row!.id,
          })
        : null;
    const managerId = created?.id ?? managerAgentId ?? null;
    const team = [...new Set(managerId ? [...memberIds, managerId] : memberIds)];
    if (team.length) {
      await tx
        .insert(projectAgents)
        .values(team.map((agentId) => ({ projectId: row!.id, agentId })))
        .onConflictDoNothing();
    }
    const [project] = managerId
      ? await tx.update(projects).set({ managerAgentId: managerId }).where(eq(projects.id, row!.id)).returning()
      : [row];
    return { project: project!, created };
  });
  if (created) {
    await audit({
      actor: opts.actor ?? "user",
      action: "agent.created",
      entityType: "agent",
      entityId: created.id,
      data: { templateSlug: MANAGER_TEMPLATE_SLUG, projectId: project.id },
    });
  }
  if (project.managerAgentId || memberIds.length) {
    await teamChanged(project.id, opts.actor, { manager: project.managerAgentId, added: memberIds });
  }
  return project;
}

/** Fields left out keep their value. The team changes through the functions below. */
export async function updateProject(id: string, patch: Partial<ProjectFields>): Promise<Project> {
  const fields = validSandbox(patch);
  if (!Object.keys(fields).length) return projectById(id);
  const [project] = await db.update(projects).set(fields).where(eq(projects.id, id)).returning();
  if (!project) throw new UserError("projects.errors.notFound");
  return project;
}

/** Makes an agent the project's manager; it joins the team if it was not on it. */
export async function setProjectManager(projectId: string, agentId: string, opts: TeamOptions = {}): Promise<Project> {
  const before = await projectById(projectId);
  await assignableAgents([agentId]);
  if (before.managerAgentId === agentId) return before;
  const project = await db.transaction(async (tx) => {
    await tx.insert(projectAgents).values({ projectId, agentId }).onConflictDoNothing();
    const [row] = await tx.update(projects).set({ managerAgentId: agentId }).where(eq(projects.id, projectId)).returning();
    return row!;
  });
  await teamChanged(projectId, opts.actor, { manager: agentId, previousManager: before.managerAgentId });
  return project;
}

/**
 * Gives a project without a manager one, created from the project manager template. For an explicit
 * request (a button), never implicitly: it creates an agent. A project that has a manager is returned as is.
 */
export async function ensureProjectManager(projectId: string, opts: TeamOptions = {}): Promise<Project> {
  const before = await projectById(projectId);
  if (before.managerAgentId) return before;
  const { project, created } = await db.transaction(async (tx) => {
    const created = await insertAgentFromTemplate(tx, MANAGER_TEMPLATE_SLUG, {
      name: managerName(before.name),
      projectId,
    });
    const [row] = await tx
      .update(projects)
      .set({ managerAgentId: created.id })
      .where(eq(projects.id, projectId))
      .returning();
    return { project: row!, created };
  });
  await audit({
    actor: opts.actor ?? "user",
    action: "agent.created",
    entityType: "agent",
    entityId: created.id,
    data: { templateSlug: MANAGER_TEMPLATE_SLUG, projectId },
  });
  await teamChanged(projectId, opts.actor, { manager: created.id, previousManager: null });
  return project;
}

/** Adds agents to the team; agents already on it are skipped. */
export async function addProjectMembers(projectId: string, agentIds: string[], opts: TeamOptions = {}): Promise<void> {
  await projectById(projectId);
  const members = await assignableAgents(agentIds);
  if (!members.length) return;
  const added = await db
    .insert(projectAgents)
    .values(members.map((a) => ({ projectId, agentId: a.id })))
    .onConflictDoNothing()
    .returning({ id: projectAgents.agentId });
  if (added.length) await teamChanged(projectId, opts.actor, { added: added.map((a) => a.id) });
}

/** Takes an agent off the team. The manager stays until another one is chosen. */
export async function removeProjectMember(projectId: string, agentId: string, opts: TeamOptions = {}): Promise<void> {
  const project = await projectById(projectId);
  if (project.managerAgentId === agentId) {
    const [agent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId));
    throw new UserError("team.errors.managerCannotLeave", { name: agent?.name ?? agentId });
  }
  const removed = await db
    .delete(projectAgents)
    .where(and(eq(projectAgents.projectId, projectId), eq(projectAgents.agentId, agentId)))
    .returning({ id: projectAgents.agentId });
  if (removed.length) await teamChanged(projectId, opts.actor, { removed: [agentId] });
}

export async function deleteProject(id: string, opts: { actor?: string } = {}): Promise<void> {
  // Tasks and knowledge cascade in the database; their files on disk have to go too.
  const [projectTasks, knowledge] = await Promise.all([
    db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, id)),
    db.select({ id: knowledgeItems.id }).from(knowledgeItems).where(eq(knowledgeItems.projectId, id)),
  ]);
  const fileIds = await fileIdsOwnedBy({
    taskIds: projectTasks.map((t) => t.id),
    knowledgeItemIds: knowledge.map((k) => k.id),
  });
  const [row] = await db.delete(projects).where(eq(projects.id, id)).returning({ name: projects.name });
  if (!row) throw new UserError("projects.errors.notFound");
  await removeFileBytes(fileIds);
  await requestWorkspaceRemoval(projectWorkspaceKey(id));
  await audit({
    actor: opts.actor ?? "user",
    action: "project.deleted",
    entityType: "project",
    entityId: id,
    data: { name: row.name },
  });
}

export async function projectAgentIds(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: projectAgents.agentId })
    .from(projectAgents)
    .where(eq(projectAgents.projectId, projectId));
  return rows.map((r) => r.id);
}
