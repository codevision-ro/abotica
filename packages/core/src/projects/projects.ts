import { agents, db, knowledgeItems, projectAgents, projects, tasks, type Tx } from "@abotica/db";
import { and, eq, inArray } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { insertAgentFromTemplate } from "../agents/agent-config";
import { audit } from "../platform/audit";
import { projectWorkspaceKey, requestWorkspaceRemoval } from "../sandbox/sandbox";
import { parseSandboxPolicy } from "../sandbox/sandbox-policy";
import { slugify } from "../platform/slug";
import { fileIdsOwnedBy, removeFileBytes } from "../files/files";
import { canJoinTeam, canLeadProject, MANAGER_TEMPLATE_SLUG } from "../tasks/team-rules";

export type Project = typeof projects.$inferSelect;
type Agent = typeof agents.$inferSelect;
export type ProjectStatus = Project["status"];

export const PROJECT_STATUSES: ProjectStatus[] = ["active", "paused", "archived"];

type ProjectFields = Pick<
  Project,
  "name" | "description" | "goals" | "status" | "budgetUsd" | "allowedProviders" | "telegramTopicId" | "sandbox"
>;

/** Null follows the default sandbox policy (Settings > System); anything else must be a valid policy. */
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

/** Loads the agents and throws unless every one exists and may join a project's team (see canJoinTeam). */
async function teamMembers(ids: string[]): Promise<Agent[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db.select().from(agents).where(inArray(agents.id, unique));
  if (rows.length !== unique.length) throw new UserError("team.errors.agentNotFound");
  const refused = rows.find((a) => !canJoinTeam(a));
  if (refused) {
    const key = refused.kind === "manager" ? "team.errors.managerNotMember" : "team.errors.notAssignable";
    throw new UserError(key, { name: refused.name });
  }
  return rows;
}

/** Loads the agent and throws unless it exists and may lead a project (see canLeadProject). */
async function projectLead(id: string): Promise<Agent> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) throw new UserError("team.errors.agentNotFound");
  if (!canLeadProject(agent)) {
    throw new UserError(agent.kind === "manager" ? "team.errors.notAssignable" : "team.errors.notManager", {
      name: agent.name,
    });
  }
  return agent;
}

async function projectById(id: string): Promise<Project> {
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) throw new UserError("projects.errors.notFound");
  return project;
}

const teamChanged = (projectId: string, actor: string | undefined, data: Record<string, unknown>) =>
  audit({ actor: actor ?? "user", action: "project.agents-changed", entityType: "project", entityId: projectId, data });

const managerName = (projectName: string) => `${projectName} Manager`;

const managerCreated = (agentId: string, projectId: string, actor: string | undefined) =>
  audit({
    actor: actor ?? "user",
    action: "agent.created",
    entityType: "agent",
    entityId: agentId,
    data: { templateSlug: MANAGER_TEMPLATE_SLUG, projectId },
  });

/** The project's manager leaves its team: a manager is on the team only of the projects it leads. */
async function removeManagerFromTeam(tx: Tx, project: Project): Promise<void> {
  if (!project.managerAgentId) return;
  await tx
    .delete(projectAgents)
    .where(and(eq(projectAgents.projectId, project.id), eq(projectAgents.agentId, project.managerAgentId)));
}

/**
 * Creates a project with its team of specialists. Without `managerAgentId` its manager is created
 * from the project manager template; with one, that manager (which may lead other projects too)
 * leads it; null leaves the project without one. The manager is always a member.
 */
export async function createProject(
  input: Pick<ProjectFields, "name"> &
    Partial<Omit<ProjectFields, "name">> & { memberIds?: string[]; managerAgentId?: string | null },
  opts: TeamOptions = {},
): Promise<Project> {
  const { memberIds = [], managerAgentId, ...rest } = input;
  const fields = validSandbox(rest);
  const slug = await uniqueProjectSlug(fields.name);
  await teamMembers(memberIds);
  if (managerAgentId) await projectLead(managerAgentId);
  const { project, created } = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(projects)
      .values({ ...fields, slug })
      .returning();
    const created =
      managerAgentId === undefined
        ? await insertAgentFromTemplate(tx, MANAGER_TEMPLATE_SLUG, { name: managerName(fields.name) })
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
  if (created) await managerCreated(created.id, project.id, opts.actor);
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

/**
 * Makes a manager the project's manager; it joins the team, and the previous manager, which is on the
 * team only of the projects it leads, leaves it.
 */
export async function setProjectManager(projectId: string, agentId: string, opts: TeamOptions = {}): Promise<Project> {
  const before = await projectById(projectId);
  await projectLead(agentId);
  if (before.managerAgentId === agentId) return before;
  const project = await db.transaction(async (tx) => {
    await removeManagerFromTeam(tx, before);
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
  return newManager(before, opts);
}

/**
 * Gives the project a new manager created from the project manager template, replacing the one it
 * has (which leaves the team, as in setProjectManager). For an explicit request (a button).
 */
export async function createProjectManager(projectId: string, opts: TeamOptions = {}): Promise<Project> {
  return newManager(await projectById(projectId), opts);
}

async function newManager(before: Project, opts: TeamOptions): Promise<Project> {
  const projectId = before.id;
  const { project, created } = await db.transaction(async (tx) => {
    const created = await insertAgentFromTemplate(tx, MANAGER_TEMPLATE_SLUG, { name: managerName(before.name) });
    await removeManagerFromTeam(tx, before);
    await tx.insert(projectAgents).values({ projectId, agentId: created.id });
    const [row] = await tx
      .update(projects)
      .set({ managerAgentId: created.id })
      .where(eq(projects.id, projectId))
      .returning();
    return { project: row!, created };
  });
  await managerCreated(created.id, projectId, opts.actor);
  await teamChanged(projectId, opts.actor, { manager: created.id, previousManager: before.managerAgentId });
  return project;
}

/** Adds specialists to the team; agents already on it are skipped. Returns the ids of the ones that joined. */
export async function addProjectMembers(projectId: string, agentIds: string[], opts: TeamOptions = {}): Promise<string[]> {
  await projectById(projectId);
  const members = await teamMembers(agentIds);
  if (!members.length) return [];
  const added = await db
    .insert(projectAgents)
    .values(members.map((a) => ({ projectId, agentId: a.id })))
    .onConflictDoNothing()
    .returning({ id: projectAgents.agentId });
  if (added.length) await teamChanged(projectId, opts.actor, { added: added.map((a) => a.id) });
  return added.map((a) => a.id);
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
