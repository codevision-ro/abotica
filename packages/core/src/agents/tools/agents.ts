import {
  agentMcpServers,
  agents,
  agentSkills,
  db,
  DEFAULT_AGENT_AVATAR,
  type ModelRef,
  mcpOAuth,
  mcpServers,
  projectMcpServers,
  projects,
  projectSkills,
  skills,
} from "@abotica/db";
import { tool } from "ai";
import { and, eq, inArray, isNotNull } from "@abotica/db/orm";
import { z } from "zod";
import { createAgentConfig, createAgentFromTemplate, updateAgentConfig, versionNotes } from "../agent-config";
import { audit } from "../../platform/audit";
import { addProjectMembers } from "../../projects/projects";
import { assertProviderUsable, usesDefaultModel } from "../../models/chain";
import { type ModelRole, modelRole, roleDefaultModels } from "../../models/model-role";
import type { RunContext } from "../context";
import { REASONING_EFFORTS } from "../../models/reasoning";
import { defaultPermissions } from "../permissions";
import { actorOf, agentBySlug, blankToUndefined, clip, errorResult, optionalText, type ToolFactory } from "./shared";

/** An explicit model keeps its role's default chain behind it, so the agent survives provider outages. */
const fallbacksFor = (ctx: RunContext, primary: ModelRef, role: ModelRole): ModelRef[] =>
  roleDefaultModels(ctx.settings.models, role).filter((m) => m.provider !== primary.provider || m.model !== primary.model);

const modelLabel = (m: ModelRef | undefined) => (m ? `${m.provider}/${m.model}` : "not set");

/** Validates a provider/model pair from a tool call; null means the default models. */
async function pickModel(
  providerInput: string | undefined,
  modelInput: string | undefined,
): Promise<{ ref: ModelRef | null } | { error: string }> {
  const provider = blankToUndefined(providerInput) as string | undefined;
  const model = blankToUndefined(modelInput) as string | undefined;
  if (!provider) return model ? { error: "You picked a model without a provider" } : { ref: null };
  if (!model) return { error: "You picked a provider without a model. Pick a model or leave both empty." };
  try {
    await assertProviderUsable(provider);
  } catch (error) {
    return errorResult(error);
  }
  return { ref: { provider, model } };
}

/** Agents the orchestrator manages: real agents, not templates. */
async function managedAgent(slug: string) {
  const agent = await agentBySlug(slug);
  return agent && !agent.isTemplate ? agent : undefined;
}

export const agentTools: Record<string, ToolFactory> = {
  agent_list: (ctx) =>
    tool({
      description:
        "List the available agents with their kind (orchestrator, manager, specialist), roles, models, projects (manager: true where they lead it), skills and MCP servers. Use it before delegating.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await db.query.agents.findMany({
          where: (a, { eq, and }) => and(eq(a.enabled, true), eq(a.isTemplate, false)),
          with: {
            projects: { with: { project: { columns: { name: true, id: true } } } },
            skills: { with: { skill: { columns: { slug: true } } } },
            mcpServers: { with: { mcpServer: { columns: { slug: true } } } },
          },
        });
        const led = await db
          .select({ id: projects.id, managerAgentId: projects.managerAgentId })
          .from(projects)
          .where(isNotNull(projects.managerAgentId));
        return rows.map((a) => ({
          slug: a.slug,
          name: a.name,
          role: a.role,
          // "default" with the model it resolves to, since each role has its own default.
          model: usesDefaultModel(a)
            ? `default (${modelLabel(roleDefaultModels(ctx.settings.models, modelRole(a))[0])})`
            : `${a.provider}/${a.model}`,
          kind: a.kind,
          projects: a.projects.map((p) => ({
            id: p.project.id,
            name: p.project.name,
            ...(led.some((l) => l.id === p.project.id && l.managerAgentId === a.id) && { manager: true }),
          })),
          skills: a.skills.map((s) => s.skill.slug),
          mcpServers: a.mcpServers.map((m) => m.mcpServer.slug),
        }));
      },
    }),

  template_list: () =>
    tool({
      description:
        "List the agent templates agent_create can start from: each holds a profession (its prompt), a role, tools, skills and MCP servers.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await db.query.agents.findMany({
          where: (a, { eq }) => eq(a.isTemplate, true),
          with: {
            skills: { with: { skill: { columns: { slug: true } } } },
            mcpServers: { with: { mcpServer: { columns: { slug: true } } } },
          },
          orderBy: (a, { asc }) => asc(a.name),
        });
        return rows.map((t) => ({
          slug: t.slug,
          name: t.name,
          role: t.role,
          kind: t.kind,
          profession: clip(t.systemPrompt, 400),
          skills: t.skills.map((s) => s.skill.slug),
          mcpServers: t.mcpServers.map((m) => m.mcpServer.slug),
        }));
      },
    }),

  agent_create: (ctx) =>
    tool({
      description:
        "Create a new agent (requires the user's approval). Prefer a template that fits (template_list): the agent gets its profession, role, tools, skills and MCP servers. Otherwise write its profession: who it is professionally and how it does its work, the same in every project (niche, language and audience come from the project). Never write hierarchy or team rules into it: the platform adds those for the agent's kind. Without a template the agent is a specialist; a manager comes from the project manager template, when the user asks for one. The agent uses its role's default model unless you pick a provider and a model, only from the available models. With projectIds a specialist joins those projects' teams.",
      inputSchema: z.object({
        templateSlug: optionalText().describe("A template from template_list"),
        name: optionalText().describe("Required without a template; with one, defaults to the template's name"),
        role: optionalText().describe("Required without a template; with one, replaces the template's role"),
        profession: optionalText().describe("Required without a template; with one, replaces the template's profession"),
        provider: z
          .string()
          .optional()
          .describe("Leave empty so the agent uses the default model. Only providers from the available models list."),
        model: z.string().optional().describe("Required only if you pick a provider"),
        projectIds: z.array(z.string().uuid()).default([]).describe("Projects whose team the specialist joins"),
      }),
      execute: async (input) => {
        const name = input.name?.trim();
        const role = input.role?.trim();
        const profession = input.profession?.trim();
        if (name !== undefined && name.length < 2) return { error: "The name needs at least 2 characters" };
        if (profession !== undefined && profession.length < 20) {
          return { error: "The profession needs at least 20 characters" };
        }
        const template = input.templateSlug ? await agentBySlug(input.templateSlug) : undefined;
        if (input.templateSlug && !template?.isTemplate) {
          return { error: `Template ${input.templateSlug} does not exist. Use template_list.` };
        }
        if (!template && (!name || !role || role.length < 3 || !profession)) {
          return { error: "Without a template, send name, role (at least 3 characters) and profession" };
        }
        const kind = template?.kind ?? "specialist";
        const projectIds = [...new Set(input.projectIds)];
        if (kind !== "specialist" && projectIds.length) {
          return { error: "A manager joins only the projects it leads: make it a project's manager with project_update." };
        }
        const picked = await pickModel(input.provider, input.model);
        if ("error" in picked) return picked;
        const found = projectIds.length
          ? await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, projectIds))
          : [];
        const missing = projectIds.filter((id) => !found.some((p) => p.id === id));
        if (missing.length) return { error: `Unknown projects: ${missing.join(", ")}. Use project_list.` };
        const modelRef = picked.ref && {
          provider: picked.ref.provider,
          model: picked.ref.model,
          fallbacks: fallbacksFor(ctx, picked.ref, modelRole({ kind })),
        };
        let agent;
        try {
          if (template) {
            // Core writes the "agent.created" audit entry here.
            agent = await createAgentFromTemplate(template.slug, { name, actor: actorOf(ctx) });
            const changes = {
              ...(role && { role }),
              ...(profession && { systemPrompt: profession }),
              ...modelRef,
            };
            if (Object.keys(changes).length) agent = (await updateAgentConfig(agent.id, changes)).agent;
          } else {
            agent = await createAgentConfig(
              {
                name: name!,
                role: role!,
                avatar: DEFAULT_AGENT_AVATAR,
                systemPrompt: profession!,
                provider: modelRef?.provider ?? null,
                model: modelRef?.model ?? null,
                fallbacks: modelRef?.fallbacks ?? [],
                reasoningEffort: "default",
                permissions: defaultPermissions({ kind }),
                limits: ctx.settings.agents.defaultLimits,
              },
              {},
              { note: (await versionNotes()).initial },
            );
            await audit({ actor: actorOf(ctx), action: "agent.created", entityType: "agent", entityId: agent.id });
          }
          // Joining through the team rules audits each project's team change.
          for (const projectId of projectIds) await addProjectMembers(projectId, [agent.id], { actor: actorOf(ctx) });
        } catch (error) {
          return errorResult(error);
        }
        return {
          slug: agent.slug,
          id: agent.id,
          kind: agent.kind,
          model: usesDefaultModel(agent) ? "default" : `${agent.provider}/${agent.model}`,
        };
      },
    }),

  agent_update: (ctx) =>
    tool({
      description:
        "Change an agent (requires the user's approval): name, role, profession, model or reasoning effort. Only the fields you send change; the profession is replaced as a whole, so send the complete new text, without hierarchy or team rules (the platform adds those for the agent's kind). Every change is a new version the user can roll back. Permissions, limits and budget stay with the user.",
      inputSchema: z.object({
        agentSlug: z.string(),
        name: optionalText(),
        role: optionalText(),
        profession: optionalText().describe(
          "A specialist's profession; for a manager or the super agent, additional instructions (normally none)",
        ),
        useDefaultModel: z.boolean().default(false).describe("Switch the agent to the default models"),
        provider: z
          .string()
          .optional()
          .describe("With model: switch to this model. Only providers from the available models list."),
        model: z.string().optional(),
        reasoningEffort: z
          .enum(REASONING_EFFORTS)
          .optional()
          .describe('"default" follows the platform default; a model gets the nearest level it supports'),
        note: optionalText().describe("Why it changes; shown in the agent's version history"),
      }),
      execute: async (input) => {
        const agent = await managedAgent(input.agentSlug);
        if (!agent) return { error: `Agent ${input.agentSlug} does not exist. Use agent_list.` };
        if (input.name !== undefined && input.name.trim().length < 2)
          return { error: "The name needs at least 2 characters" };
        if (input.profession !== undefined && input.profession.trim().length < 20) {
          return { error: "The profession needs at least 20 characters" };
        }
        const picked = input.useDefaultModel ? { ref: null } : await pickModel(input.provider, input.model);
        if ("error" in picked) return picked;
        const modelChange = input.useDefaultModel
          ? { provider: null, model: null, fallbacks: [] }
          : picked.ref && {
              provider: picked.ref.provider,
              model: picked.ref.model,
              fallbacks: fallbacksFor(ctx, picked.ref, modelRole(agent)),
            };
        const result = await updateAgentConfig(
          agent.id,
          {
            ...(input.name !== undefined && { name: input.name.trim() }),
            ...(input.role !== undefined && { role: input.role.trim() }),
            ...(input.profession !== undefined && { systemPrompt: input.profession }),
            ...(input.reasoningEffort && { reasoningEffort: input.reasoningEffort }),
            ...modelChange,
          },
          { note: input.note },
        );
        if (!result.changed.length)
          return { slug: agent.slug, version: result.version, changed: [], note: "Nothing changed" };
        await audit({
          actor: actorOf(ctx),
          action: "agent.updated",
          entityType: "agent",
          entityId: agent.id,
          data: { version: result.version, changed: result.changed },
        });
        return { slug: agent.slug, version: result.version, changed: result.changed };
      },
    }),

  registry_list: () =>
    tool({
      description:
        "List the skills and MCP servers configured in the platform, with the agents and projects each one is assigned to.",
      inputSchema: z.object({}),
      execute: async () => {
        const [skillRows, serverRows, agentSkillRows, agentServerRows, projectSkillRows, projectServerRows, oauthRows] =
          await Promise.all([
            db.select().from(skills),
            db.select().from(mcpServers),
            db
              .select({ id: agentSkills.skillId, slug: agents.slug })
              .from(agentSkills)
              .innerJoin(agents, eq(agents.id, agentSkills.agentId)),
            db
              .select({ id: agentMcpServers.mcpServerId, slug: agents.slug })
              .from(agentMcpServers)
              .innerJoin(agents, eq(agents.id, agentMcpServers.agentId)),
            db
              .select({ id: projectSkills.skillId, name: projects.name })
              .from(projectSkills)
              .innerJoin(projects, eq(projects.id, projectSkills.projectId)),
            db
              .select({ id: projectMcpServers.mcpServerId, name: projects.name })
              .from(projectMcpServers)
              .innerJoin(projects, eq(projects.id, projectMcpServers.projectId)),
            db.select({ serverId: mcpOAuth.serverId, tokens: mcpOAuth.tokens }).from(mcpOAuth),
          ]);
        const agentsOf = (rows: { id: string; slug: string }[], id: string) =>
          rows.filter((r) => r.id === id).map((r) => r.slug);
        const projectsOf = (rows: { id: string; name: string }[], id: string) =>
          rows.filter((r) => r.id === id).map((r) => r.name);
        return {
          skills: skillRows.map((s) => ({
            slug: s.slug,
            name: s.name,
            description: s.description,
            enabled: s.enabled,
            agents: agentsOf(agentSkillRows, s.id),
            projects: projectsOf(projectSkillRows, s.id),
          })),
          mcpServers: serverRows.map((m) => ({
            slug: m.slug,
            name: m.name,
            enabled: m.enabled,
            transport: m.transport,
            // OAuth servers work only after the user connected them in the web UI.
            connected: m.auth === "oauth" ? Boolean(oauthRows.find((o) => o.serverId === m.id)?.tokens) : true,
            tools: m.tools?.map((t) => t.name) ?? null,
            // Global servers reach every agent without assignments; bundled ones ship with Abotica.
            global: m.global,
            builtin: m.builtin !== null,
            agents: agentsOf(agentServerRows, m.id),
            projects: projectsOf(projectServerRows, m.id),
          })),
        };
      },
    }),

  registry_assign: (ctx) =>
    tool({
      description:
        "Give a skill or an MCP server to an agent or a project, or take it away (requires the user's approval). A project's skills and MCP servers reach every agent working in that project. Use registry_list for the slugs, and read a skill with skill_read before you give it.",
      inputSchema: z.object({
        action: z.enum(["add", "remove"]),
        kind: z.enum(["skill", "mcp"]),
        slug: z.string().describe("Skill or MCP server slug"),
        agentSlug: optionalText().describe("Target agent; send this or projectId"),
        projectId: z.preprocess(blankToUndefined, z.string().uuid().optional()).describe("Target project"),
      }),
      execute: async ({ action, kind, slug, agentSlug, projectId }) => {
        if (Boolean(agentSlug) === Boolean(projectId)) return { error: "Send exactly one target: agentSlug or projectId" };
        const table = kind === "skill" ? skills : mcpServers;
        const [item] = await db.select({ id: table.id, slug: table.slug }).from(table).where(eq(table.slug, slug));
        if (!item)
          return { error: `${kind === "skill" ? "Skill" : "MCP server"} ${slug} does not exist. Use registry_list.` };

        if (agentSlug) {
          const agent = await managedAgent(agentSlug);
          if (!agent) return { error: `Agent ${agentSlug} does not exist. Use agent_list.` };
          const join = kind === "skill" ? agentSkills : agentMcpServers;
          const column = kind === "skill" ? agentSkills.skillId : agentMcpServers.mcpServerId;
          const current = (await db.select({ id: column }).from(join).where(eq(join.agentId, agent.id))).map((r) => r.id);
          const next = action === "add" ? [...new Set([...current, item.id])] : current.filter((id) => id !== item.id);
          const result = await updateAgentConfig(agent.id, kind === "skill" ? { skillIds: next } : { mcpServerIds: next });
          if (result.changed.length) {
            await audit({
              actor: actorOf(ctx),
              action: "agent.updated",
              entityType: "agent",
              entityId: agent.id,
              data: { version: result.version, changed: result.changed, [action]: `${kind}:${slug}` },
            });
          }
          return {
            agent: agent.slug,
            [kind === "skill" ? "skills" : "mcpServers"]: action,
            slug,
            changed: result.changed.length > 0,
          };
        }

        const [project] = await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(eq(projects.id, projectId!));
        if (!project) return { error: `Project ${projectId} does not exist. Use project_list.` };
        if (kind === "skill") {
          if (action === "add")
            await db.insert(projectSkills).values({ projectId: project.id, skillId: item.id }).onConflictDoNothing();
          else
            await db
              .delete(projectSkills)
              .where(and(eq(projectSkills.projectId, project.id), eq(projectSkills.skillId, item.id)));
        } else if (action === "add") {
          await db.insert(projectMcpServers).values({ projectId: project.id, mcpServerId: item.id }).onConflictDoNothing();
        } else {
          await db
            .delete(projectMcpServers)
            .where(and(eq(projectMcpServers.projectId, project.id), eq(projectMcpServers.mcpServerId, item.id)));
        }
        await audit({
          actor: actorOf(ctx),
          action: action === "add" ? "project.assigned" : "project.unassigned",
          entityType: "project",
          entityId: project.id,
          data: { kind, slug },
        });
        return { project: project.name, action, kind, slug };
      },
    }),
};
