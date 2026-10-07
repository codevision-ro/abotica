"use server";

import {
  addKnowledgeFile,
  addKnowledgeItem,
  addProjectMembers as addMembers,
  audit,
  createAgentFromTemplate,
  createProject as createProjectRow,
  deleteKnowledgeItem as removeKnowledgeItem,
  deleteProject as deleteProjectRow,
  ensureProjectManager as ensureManager,
  fetchPageText,
  indexKnowledgeItem,
  parseSandboxPolicy,
  PROJECT_STATUSES,
  type ProjectStatus,
  PROVIDER_IDS,
  removeProjectMember as removeMember,
  resetProjectWorkspace as resetWorkspace,
  searchKnowledge,
  setProjectManager as setManager,
  updateProject as updateProjectRow,
  upsertSecret,
} from "@abotica/core";
import { db, secrets } from "@abotica/db";
import { and, eq } from "@abotica/db/orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

const uuid = z.string().uuid();

const projectInput = z.object({
  name: z.string().trim().min(2, "projects.validation.nameMin").max(120),
  description: z.string().max(10_000).default(""),
  goals: z.string().max(10_000).default(""),
  budgetUsd: z.number().nonnegative().nullable().default(null),
  allowedProviders: z.array(z.enum(PROVIDER_IDS as [string, ...string[]])).default([]),
  telegramTopicId: z.number().int().nullable().default(null),
});

function revalidateProject(id?: string) {
  revalidatePath("/projects");
  if (id) revalidatePath(`/projects/${id}`, "layout");
}

/** Team changes show on the project, on the agents involved and in the chat's team pickers. */
function revalidateTeam(projectId: string) {
  revalidateProject(projectId);
  revalidatePath("/agents", "layout");
  revalidatePath("/chat", "layout");
}

/** Core creates the manager from its template; `memberIds` are the specialists the project starts with. */
export const createProject = action(projectInput.extend({ memberIds: z.array(uuid).default([]) }), async (input) => {
  const project = await createProjectRow(input);
  await audit({
    actor: "user",
    action: "project.created",
    entityType: "project",
    entityId: project.id,
    data: { name: input.name },
  });
  // The manager is a new agent: the agent list changes too.
  revalidateTeam(project.id);
  return { id: project.id };
});

export const updateProject = action(
  // The sandbox policy is validated by core's parser, which names the bad domain or package.
  projectInput.extend({ id: uuid, sandbox: z.unknown().optional() }),
  async ({ id, sandbox, ...input }) => {
    await updateProjectRow(id, {
      ...input,
      ...(sandbox !== undefined && { sandbox: sandbox === null ? null : parseSandboxPolicy(sandbox) }),
    });
    await audit({ actor: "user", action: "project.updated", entityType: "project", entityId: id });
    revalidateProject(id);
    return { id };
  },
);

export const setProjectStatus = action(
  z.object({ id: uuid, status: z.enum(PROJECT_STATUSES as [ProjectStatus, ...ProjectStatus[]]) }),
  async ({ id, status }) => {
    await updateProjectRow(id, { status });
    await audit({ actor: "user", action: "project.status-changed", entityType: "project", entityId: id, data: { status } });
    revalidateProject(id);
  },
);

/* Team: core keeps the manager a member and refuses agents that cannot join (templates, the super agent). */

const member = z.object({ projectId: uuid, agentId: uuid });

export const setProjectManager = action(member, async ({ projectId, agentId }) => {
  await setManager(projectId, agentId);
  revalidateTeam(projectId);
});

/** Creates a manager from the project manager template, for a project that has none. */
export const ensureProjectManager = action(z.object({ projectId: uuid }), async ({ projectId }) => {
  await ensureManager(projectId);
  revalidateTeam(projectId);
});

export const addProjectMembers = action(
  z.object({ projectId: uuid, agentIds: z.array(uuid).min(1) }),
  async ({ projectId, agentIds }) => {
    await addMembers(projectId, agentIds);
    revalidateTeam(projectId);
  },
);

export const removeProjectMember = action(member, async ({ projectId, agentId }) => {
  await removeMember(projectId, agentId);
  revalidateTeam(projectId);
});

/** A new agent from a template, straight into the project's team. */
export const hireProjectMember = action(
  z.object({
    projectId: uuid,
    templateSlug: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(80).optional(),
  }),
  async ({ projectId, templateSlug, name }) => {
    const agent = await createAgentFromTemplate(templateSlug, { name, projectId });
    revalidateTeam(projectId);
    return { id: agent.id, name: agent.name };
  },
);

/** Empties the project's sandbox workspace; core writes the audit entry. */
export const resetProjectWorkspace = action(z.object({ id: uuid }), async ({ id }) => {
  await resetWorkspace(id, "user");
});

export const deleteProject = action(z.object({ id: uuid }), async ({ id }) => {
  await deleteProjectRow(id);
  revalidateProject();
});

/* Knowledge base */

async function insertKnowledge(item: Parameters<typeof addKnowledgeItem>[0]) {
  const result = await addKnowledgeItem(item);
  await audit({
    actor: "user",
    action: "knowledge.created",
    entityType: "knowledge_item",
    entityId: result.id,
    data: { projectId: item.projectId, kind: item.kind },
  });
  revalidateProject(item.projectId);
  return result;
}

export const createKnowledgeDocument = action(
  z.object({
    projectId: uuid,
    title: z.string().trim().min(1, "projects.validation.titleRequired").max(200),
    content: z.string().trim().min(1, "projects.validation.contentEmpty"),
  }),
  async ({ projectId, title, content }) => insertKnowledge({ projectId, kind: "document", title, content }),
);

export const createKnowledgeLink = action(
  z.object({ projectId: uuid, url: z.string().trim().url("projects.validation.invalidUrl") }),
  async ({ projectId, url }) => {
    const page = await fetchPageText(url);
    return insertKnowledge({ projectId, kind: "link", title: page.title, sourceUrl: page.url, content: page.content });
  },
);

/** A file uploaded through POST /api/files: text files are indexed, other types stored for download. */
export const createKnowledgeFile = action(z.object({ projectId: uuid, fileId: uuid }), async ({ projectId, fileId }) => {
  const result = await addKnowledgeFile({ projectId, fileId });
  await audit({
    actor: "user",
    action: "knowledge.created",
    entityType: "knowledge_item",
    entityId: result.id,
    data: { projectId, kind: "file" },
  });
  revalidateProject(projectId);
  return result;
});

/** Core removes the item with its chunks and its stored file. */
export const deleteKnowledgeItem = action(z.object({ id: uuid, projectId: uuid }), async ({ id, projectId }) => {
  if (await removeKnowledgeItem({ projectId, id })) {
    await audit({ actor: "user", action: "knowledge.deleted", entityType: "knowledge_item", entityId: id });
  }
  revalidateProject(projectId);
});

export const reindexKnowledgeItem = action(z.object({ id: uuid, projectId: uuid }), async ({ id, projectId }) => {
  const chunks = await indexKnowledgeItem(id);
  revalidateProject(projectId);
  return { chunks };
});

export const searchProjectKnowledge = action(
  z.object({ projectId: uuid, query: z.string().trim().min(1, "projects.validation.searchRequired") }),
  async ({ projectId, query }) => searchKnowledge(query, [projectId], 8),
);

/* Project credentials */

const secretName = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[A-Z0-9_]+$/, "projects.validation.secretNameFormat");

export const setProjectSecret = action(
  z.object({
    projectId: uuid,
    name: secretName,
    value: z.string().default(""),
    description: z.string().max(500).default(""),
  }),
  async ({ projectId, name, value, description }) => {
    await upsertSecret({ name, value, description, projectId });
    revalidateProject(projectId);
  },
);

export const deleteProjectSecret = action(z.object({ id: uuid, projectId: uuid }), async ({ id, projectId }) => {
  const [row] = await db
    .delete(secrets)
    .where(and(eq(secrets.id, id), eq(secrets.projectId, projectId)))
    .returning({ name: secrets.name });
  if (row)
    await audit({ actor: "user", action: "secret.deleted", entityType: "secret", entityId: row.name, data: { projectId } });
  revalidateProject(projectId);
});
