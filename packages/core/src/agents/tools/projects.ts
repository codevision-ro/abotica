import { agents, db } from "@abotica/db";
import { tool } from "ai";
import { inArray } from "@abotica/db/orm";
import { z } from "zod";
import { audit } from "../../platform/audit";
import {
  addProjectMembers,
  createProject,
  PROJECT_STATUSES,
  removeProjectMember,
  setProjectManager,
  updateProject,
} from "../../projects/projects";
import { actorOf, closedProjects, errorResult, optionalText, type ToolFactory } from "./shared";
import { withholdClosed } from "./withheld";

/** Resolves agent slugs; unknown ones are reported back instead of being dropped silently. */
async function agentIdsBySlug(slugs: string[]): Promise<{ ids: string[]; unknown: string[] }> {
  if (!slugs.length) return { ids: [], unknown: [] };
  const rows = await db
    .select({ id: agents.id, slug: agents.slug, isTemplate: agents.isTemplate })
    .from(agents)
    .where(inArray(agents.slug, slugs));
  const found = rows.filter((r) => !r.isTemplate);
  return { ids: found.map((r) => r.id), unknown: slugs.filter((s) => !found.some((r) => r.slug === s)) };
}

export const projectTools: Record<string, ToolFactory> = {
  project_list: (ctx) =>
    tool({
      description: "List projects with their status, manager and team.",
      inputSchema: z.object({ includeArchived: z.boolean().default(false) }),
      execute: async ({ includeArchived }) => {
        const closed = await closedProjects(ctx);
        const rows = await db.query.projects.findMany({
          where: includeArchived ? undefined : (p, { ne }) => ne(p.status, "archived"),
          with: { agents: { with: { agent: { columns: { id: true, slug: true, name: true } } } } },
          orderBy: (p, { desc }) => desc(p.updatedAt),
        });
        return rows.map((p) =>
          withholdClosed(
            {
              id: p.id,
              name: p.name,
              slug: p.slug,
              status: p.status,
              description: p.description,
              goals: p.goals,
              manager: p.agents.find((a) => a.agent.id === p.managerAgentId)?.agent.slug ?? null,
              team: p.agents.map((a) => a.agent.slug),
            },
            p.id,
            closed,
            ["description", "goals"],
          ),
        );
      },
    }),

  project_create: (ctx) =>
    tool({
      description:
        "Create a new project. It gets its own manager, created from the project manager template, unless you name an existing manager (one may lead several projects). Add specialists to the team with agentSlugs; you never join a project yourself.",
      inputSchema: z.object({
        name: z.string().min(2),
        description: z.string().default(""),
        goals: z.string().default(""),
        agentSlugs: z.array(z.string()).default([]).describe("Specialists on the team"),
        managerSlug: optionalText().describe("An existing manager to lead the project; leave empty to create one"),
      }),
      execute: async ({ name, description, goals, agentSlugs, managerSlug }) => {
        const [members, manager] = await Promise.all([
          agentIdsBySlug(agentSlugs),
          agentIdsBySlug(managerSlug ? [managerSlug] : []),
        ]);
        const unknown = [...members.unknown, ...manager.unknown];
        if (unknown.length) return { error: `Unknown agents: ${unknown.join(", ")}. Use agent_list.` };
        try {
          const project = await createProject(
            { name, description, goals, memberIds: members.ids, ...(manager.ids[0] && { managerAgentId: manager.ids[0] }) },
            { actor: actorOf(ctx) },
          );
          await audit({ actor: actorOf(ctx), action: "project.created", entityType: "project", entityId: project.id });
          const [lead] = await db
            .select({ slug: agents.slug })
            .from(agents)
            .where(inArray(agents.id, project.managerAgentId ? [project.managerAgentId] : []));
          return { id: project.id, slug: project.slug, manager: lead?.slug ?? null };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),

  project_update: (ctx) =>
    tool({
      description:
        "Change a project: name, description, goals, status (active, paused, archived), its manager and its team of specialists. Only the fields you send change. The manager cannot be removed from the team: choose another manager first. You never join a project yourself. Budget, allowed providers and credentials stay with the user.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        name: optionalText(),
        description: optionalText(),
        goals: optionalText(),
        status: z.enum(PROJECT_STATUSES as [string, ...string[]]).optional(),
        managerSlug: optionalText().describe("Make this manager lead the project; the previous one leaves its team"),
        addAgentSlugs: z.array(z.string()).default([]),
        removeAgentSlugs: z.array(z.string()).default([]),
      }),
      execute: async ({ projectId, name, description, goals, status, managerSlug, addAgentSlugs, removeAgentSlugs }) => {
        if (name !== undefined && name.trim().length < 2) return { error: "The name needs at least 2 characters" };
        const [added, removed, manager] = await Promise.all([
          agentIdsBySlug(addAgentSlugs),
          agentIdsBySlug(removeAgentSlugs),
          agentIdsBySlug(managerSlug ? [managerSlug] : []),
        ]);
        const unknown = [...added.unknown, ...removed.unknown, ...manager.unknown];
        if (unknown.length) return { error: `Unknown agents: ${unknown.join(", ")}. Use agent_list.` };
        const fields = {
          ...(name !== undefined && { name: name.trim() }),
          ...(description !== undefined && { description }),
          ...(goals !== undefined && { goals }),
          ...(status && { status: status as (typeof PROJECT_STATUSES)[number] }),
        };
        const teamChanges = added.ids.length + removed.ids.length + manager.ids.length;
        if (!Object.keys(fields).length && !teamChanges) return { error: "Nothing to change" };
        try {
          // Core audits the team changes itself; the field changes are audited here.
          const actor = { actor: actorOf(ctx) };
          if (manager.ids[0]) await setProjectManager(projectId, manager.ids[0], actor);
          if (added.ids.length) await addProjectMembers(projectId, added.ids, actor);
          for (const agentId of removed.ids) await removeProjectMember(projectId, agentId, actor);
          const project = await updateProject(projectId, fields);
          if (Object.keys(fields).length) {
            await audit({
              actor: actorOf(ctx),
              action: "project.updated",
              entityType: "project",
              entityId: project.id,
              data: { changed: Object.keys(fields) },
            });
          }
          return { id: project.id, name: project.name, status: project.status };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
};
