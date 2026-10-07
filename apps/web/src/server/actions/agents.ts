"use server";

import {
  TOOL_PERMISSIONS,
  addProjectMembers,
  audit,
  createAgentConfig,
  createAgentFromTemplate,
  deleteAgent as removeAgent,
  currentSnapshot,
  ensureCurrentVersionRow,
  existingIds,
  isProviderId,
  lockAgent,
  removeProjectMember,
  replaceJoins,
  sanitizePermissions,
  snapshotOf,
  uniqueAgentSlug,
  updateAgentConfig,
} from "@abotica/core";
import { REASONING_EFFORTS } from "@abotica/core/models/reasoning";
import { agents, agentVersions, db, toAgentAvatar } from "@abotica/db";
import { and, eq } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { action } from "../action";
import { getAgentRelations } from "../queries/agents";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const modelRef = z.object({
  provider: z.string().refine(isProviderId, "agents.validation.unknownProvider"),
  model: z.string().trim().min(1, "agents.validation.pickModel").max(200),
});

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((v) => v.toLowerCase());

const agentAvatar = z.object({
  icon: z.string().regex(/^[a-z0-9-]{1,64}$/),
  color: hexColor,
  background: hexColor,
});

const agentFields = z.object({
  name: z.string().trim().min(1, "agents.validation.nameRequired").max(80),
  role: z.string().trim().max(200),
  avatar: agentAvatar,
  systemPrompt: z.string().max(100_000),
  // Null provider and model: the agent follows the default models from settings.
  provider: z.string().refine(isProviderId, "agents.validation.unknownProvider").nullable(),
  model: z.string().trim().min(1, "agents.validation.pickModel").max(200).nullable(),
  fallbacks: z.array(modelRef).max(10),
  reasoningEffort: z.enum(REASONING_EFFORTS),
  permissions: z.record(z.string(), z.enum(TOOL_PERMISSIONS)),
  limits: z.object({
    maxSteps: z.number().int().min(1).max(100),
    timeoutMs: z.number().int().min(60_000, "agents.validation.timeoutMin"),
    budgetUsd: z.number().positive("agents.validation.budgetPositive").nullable(),
  }),
  skillIds: z.array(z.uuid()),
  mcpServerIds: z.array(z.uuid()),
  projectIds: z.array(z.uuid()),
});

function revalidateAgent(id?: string) {
  revalidatePath("/agents");
  if (id) revalidatePath(`/agents/${id}`);
}

/**
 * Moves the agent onto exactly `projectIds` through core's team rules: joining as a specialist, leaving
 * refused for a project it manages.
 */
async function syncProjects(agentId: string, projectIds: string[]): Promise<void> {
  const current = new Set((await getAgentRelations(agentId)).projectIds);
  const wanted = new Set(projectIds);
  const joined = [...wanted].filter((id) => !current.has(id));
  const left = [...current].filter((id) => !wanted.has(id));
  for (const projectId of joined) await addProjectMembers(projectId, [agentId]);
  for (const projectId of left) await removeProjectMember(projectId, agentId);
  for (const projectId of [...joined, ...left]) revalidatePath(`/projects/${projectId}`, "layout");
}

/**
 * From a template, core creates the agent (its configuration, skills and MCP servers, a first version
 * naming the template) and the form's edits are saved on top as the next version; otherwise the form's
 * configuration is the first version.
 */
export const createAgent = action(
  agentFields.extend({ templateSlug: z.string().regex(SLUG_RE).optional() }),
  async ({ templateSlug, projectIds, skillIds, mcpServerIds, ...config }) => {
    let id: string;
    if (templateSlug) {
      // Core writes the "agent.created" audit entry here.
      const agent = await createAgentFromTemplate(templateSlug, { name: config.name });
      await updateAgentConfig(agent.id, { ...config, skillIds, mcpServerIds });
      id = agent.id;
    } else {
      const t = await getTranslations("agents.versionNotes");
      const agent = await createAgentConfig(config, { skillIds, mcpServerIds }, { note: t("initial") });
      await audit({ actor: "user", action: "agent.created", entityType: "agent", entityId: agent.id });
      id = agent.id;
    }
    await syncProjects(id, projectIds);
    revalidateAgent();
    return { id };
  },
);

export const updateAgent = action(
  agentFields.extend({ id: z.uuid(), note: z.string().trim().max(300).optional() }),
  async ({ id, note, projectIds, ...patch }) => {
    // Team changes first: core may refuse one (leaving a project the agent manages), and then nothing is saved.
    await syncProjects(id, projectIds);
    const result = await updateAgentConfig(id, patch, { note });
    await audit({
      actor: "user",
      action: "agent.updated",
      entityType: "agent",
      entityId: id,
      data: { version: result.version, changed: result.changed },
    });
    revalidateAgent(id);
    return { version: result.version, newVersion: result.changed.length > 0 };
  },
);

export const setAgentEnabled = action(z.object({ id: z.uuid(), enabled: z.boolean() }), async ({ id, enabled }) => {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) throw new UserError("agents.errors.notFound");
  if (agent.isOrchestrator && !enabled) throw new UserError("agents.errors.orchestratorDisable");
  await db.update(agents).set({ enabled }).where(eq(agents.id, id));
  await audit({ actor: "user", action: enabled ? "agent.enabled" : "agent.disabled", entityType: "agent", entityId: id });
  revalidateAgent(id);
});

export const duplicateAgent = action(z.object({ id: z.uuid() }), async ({ id }) => {
  const t = await getTranslations("agents");
  const newId = await db.transaction(async (tx) => {
    const source = await lockAgent(tx, id);
    // The copy is a new hire: it joins no projects until it is added to a team.
    const { skillIds, mcpServerIds } = await getAgentRelations(id);
    const rel = { skillIds, mcpServerIds };
    // Copies are never orchestrators, so orchestrator-only tools are dropped; manager tools stay.
    const permissions = sanitizePermissions(source.permissions, { isOrchestrator: false, isManager: false });
    const name = t("copyName", { name: source.name });
    const [copy] = await tx
      .insert(agents)
      .values({
        slug: await uniqueAgentSlug(tx, name),
        name,
        role: source.role,
        avatar: source.avatar,
        systemPrompt: source.systemPrompt,
        provider: source.provider,
        model: source.model,
        fallbacks: source.fallbacks,
        reasoningEffort: source.reasoningEffort,
        permissions,
        limits: source.limits,
        isTemplate: source.isTemplate,
        enabled: source.enabled,
        version: 1,
      })
      .returning();
    await replaceJoins(tx, copy!.id, rel);
    await tx.insert(agentVersions).values({
      agentId: copy!.id,
      version: 1,
      snapshot: snapshotOf(copy!, rel.skillIds, rel.mcpServerIds),
      note: t("versionNotes.duplicated", { name: source.name, version: source.version }),
    });
    return copy!.id;
  });
  await audit({ actor: "user", action: "agent.duplicated", entityType: "agent", entityId: newId, data: { from: id } });
  revalidateAgent();
  return { id: newId };
});

export const deleteAgent = action(z.object({ id: z.uuid() }), async ({ id }) => {
  await removeAgent(id);
  revalidateAgent();
});

export const restoreAgentVersion = action(
  z.object({ id: z.uuid(), version: z.number().int().min(1) }),
  async ({ id, version }) => {
    const t = await getTranslations("agents.versionNotes");
    const newVersion = await db.transaction(async (tx) => {
      const agent = await lockAgent(tx, id);
      const [row] = await tx
        .select()
        .from(agentVersions)
        .where(and(eq(agentVersions.agentId, id), eq(agentVersions.version, version)));
      if (!row) throw new UserError("agents.errors.versionNotFound", { version });
      const before = await currentSnapshot(tx, agent);
      const snap = row.snapshot;
      // Snapshots are stored as jsonb; sanitize them like user input, the catalog may have changed since.
      // Manager tools are kept for every agent but the super agent, so managing a project does not matter here.
      const permissions = sanitizePermissions(snap.permissions ?? {}, {
        isOrchestrator: agent.isOrchestrator,
        isManager: false,
      });
      const ids = await existingIds(tx, { skillIds: snap.skillIds ?? [], mcpServerIds: snap.mcpServerIds ?? [] });
      const values = {
        name: snap.name,
        role: snap.role,
        avatar: toAgentAvatar(snap.avatar),
        systemPrompt: snap.systemPrompt,
        provider: snap.provider,
        model: snap.model,
        fallbacks: snap.fallbacks,
        reasoningEffort: snap.reasoningEffort ?? "default",
        permissions,
        limits: snap.limits,
        version: agent.version + 1,
      };
      await ensureCurrentVersionRow(tx, agent, before, t("initial"));
      await tx.update(agents).set(values).where(eq(agents.id, id));
      await replaceJoins(tx, id, ids);
      await tx.insert(agentVersions).values({
        agentId: id,
        version: values.version,
        snapshot: snapshotOf({ ...agent, ...values }, ids.skillIds, ids.mcpServerIds),
        note: t("restored", { version }),
      });
      return values.version;
    });
    await audit({
      actor: "user",
      action: "agent.restored",
      entityType: "agent",
      entityId: id,
      data: { from: version, version: newVersion },
    });
    revalidateAgent(id);
    return { version: newVersion };
  },
);
