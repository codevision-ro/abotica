import { db, memories } from "@abotica/db";
import { tool } from "ai";
import { eq } from "@abotica/db/orm";
import { z } from "zod";
import { audit } from "../../platform/audit";
import { addKnowledgeItem, fetchPageText, searchKnowledge } from "../../memory/knowledge";
import { deleteMemory, remember, searchJournals, searchMemories, updateMemory } from "../../memory/memory";
import { defaultMemoryScope, memoryEditableBy } from "../../memory/memory-scope";
import type { RunContext } from "../context";
import { modelChain } from "../model-chain";
import { WITHHELD_NOTE } from "./withheld";
import {
  actorOf,
  agentBySlug,
  closedProjects,
  errorResult,
  optionalId,
  optionalText,
  readableProjectIds,
  type ToolFactory,
} from "./shared";

type Memory = typeof memories.$inferSelect;

/** An entry the run may change (see memoryEditableBy), or an error for the model. */
async function editableMemory(ctx: RunContext, id: string): Promise<Memory | { error: string }> {
  const [memory] = await db.select().from(memories).where(eq(memories.id, id));
  const allowed =
    memory &&
    memoryEditableBy(memory, {
      agentId: ctx.agent.id,
      projectId: ctx.projectId,
      isOrchestrator: ctx.agent.isOrchestrator,
    });
  if (!allowed) return { error: `Memory ${id} does not exist or you cannot change it. Use memory_search to find ids.` };
  return memory;
}

export const memoryTools: Record<string, ToolFactory> = {
  memory_search: (ctx) =>
    tool({
      description: ctx.projectId
        ? "Search memory for relevant information: preferences, decisions, facts. It covers global memory, this project's memory and your own. Use it before assuming anything. Results carry the ids memory_update and memory_delete need."
        : "Search memory (global and your own) for relevant information: preferences, decisions, facts. Use it before assuming anything. Results carry the ids memory_update and memory_delete need.",
      inputSchema: z.object({ query: z.string().describe("What you are looking for, in natural language") }),
      execute: async ({ query }) => searchMemories(query, { agentId: ctx.agent.id, projectId: ctx.projectId, limit: 10 }),
    }),

  memory_save: (ctx) =>
    tool({
      description: [
        "Save a durable fact to memory. Do not save temporary things. To correct an existing entry use memory_update instead of saving a second one.",
        ctx.projectId
          ? "scope=project (the default here) for what the team should know about this project: its decisions, conventions, facts, what you learned working on it. scope=agent only for knowledge about your profession that holds in any project (methods, tools, lessons of your craft). scope=global for facts that apply everywhere (e.g. the user's preferences)."
          : "scope=agent (the default) for what you learned yourself, global for facts that apply everywhere (e.g. the user's preferences), project for a project's context and decisions (with its projectId).",
      ].join(" "),
      inputSchema: z.object({
        content: z.string().min(3),
        scope: z.enum(["agent", "project", "global"]).optional(),
        projectId: optionalId().describe(
          ctx.agent.isOrchestrator
            ? "Required for scope=project"
            : "Leave empty: project memory goes to this run's project",
        ),
      }),
      execute: async ({ content, scope = defaultMemoryScope(ctx.projectId), projectId }) => {
        const pid = projectId ?? ctx.projectId;
        if (scope === "project" && !pid) return { error: "projectId is required for project memory" };
        // A run writes only to its own project's memory; the super agent may note facts for any project.
        if (scope === "project" && pid !== ctx.projectId && !ctx.agent.isOrchestrator) {
          return { error: "You can save project memory only for the project of this run" };
        }
        const memory = await remember({
          scope,
          content,
          projectId: pid,
          agentId: ctx.agent.id,
          source: "agent",
          status: ctx.settings.memoryRequiresApproval ? "pending" : "active",
        });
        return { saved: true, id: memory.id, scope, pendingApproval: memory.status === "pending" };
      },
    }),

  memory_update: (ctx) =>
    tool({
      description:
        "Replace the content of a memory entry that is wrong or outdated. Get the id from memory_search. Write the complete new content, not a diff.",
      inputSchema: z.object({ memoryId: z.string().uuid(), content: z.string().min(3) }),
      execute: async ({ memoryId, content }) => {
        const memory = await editableMemory(ctx, memoryId);
        if ("error" in memory) return memory;
        const pending = ctx.settings.memoryRequiresApproval;
        await updateMemory(memory.id, content, { actor: actorOf(ctx), ...(pending && { status: "pending" }) });
        return { updated: true, id: memory.id, pendingApproval: pending };
      },
    }),

  memory_delete: (ctx) =>
    tool({
      description: "Delete a memory entry that is wrong, duplicated or no longer true. Get the id from memory_search.",
      inputSchema: z.object({ memoryId: z.string().uuid(), reason: z.string().min(3).describe("Why it should go") }),
      execute: async ({ memoryId, reason }) => {
        const memory = await editableMemory(ctx, memoryId);
        if ("error" in memory) return memory;
        await deleteMemory(memory.id, { actor: actorOf(ctx), data: { content: memory.content, reason } });
        return { deleted: true, id: memory.id };
      },
    }),

  journal_search: (ctx) =>
    tool({
      description: ctx.agent.isOrchestrator
        ? "Search the agents' daily journals (what they did in past days)."
        : ctx.projectId
          ? "Search your daily journals of this project (what you did in past days)."
          : "Search your daily journals of work outside projects (what you did in past days).",
      inputSchema: z.object({
        query: z.string(),
        agentSlug: z.string().optional().describe("Orchestrator only: another agent's journal"),
        projectId: optionalId().describe("Orchestrator only: one project's journals"),
      }),
      execute: async ({ query, agentSlug, projectId }) => {
        // Journals of a project that does not allow every model of this run never reach it.
        const readableBy = await modelChain(ctx);
        if (!ctx.agent.isOrchestrator) {
          return searchJournals(query, { agentId: ctx.agent.id, projectId: ctx.projectId, limit: 7, readableBy });
        }
        const agentId = agentSlug ? (await agentBySlug(agentSlug))?.id : undefined;
        return searchJournals(query, { agentId, projectId, limit: 7, readableBy });
      },
    }),

  knowledge_search: (ctx) =>
    tool({
      description: "Search the projects' knowledge base (documents, files, saved links).",
      inputSchema: z.object({ query: z.string(), projectId: optionalId() }),
      execute: async ({ query, projectId }) => {
        const [readable, closed] = await Promise.all([readableProjectIds(ctx), closedProjects(ctx)]);
        if (projectId && !readable.includes(projectId)) return { error: `Project ${projectId} is not one of yours` };
        if (projectId && closed.has(projectId)) return { error: `Project ${projectId}: ${WITHHELD_NOTE}` };
        return searchKnowledge(query, projectId ? [projectId] : readable.filter((id) => !closed.has(id)));
      },
    }),

  knowledge_add: (ctx) =>
    tool({
      description:
        "Save reference material in a project's knowledge base, where every agent of the project can search it: either a web page (url) or a document you write (title and content). Use it for sources and findings worth keeping, not for short facts (those go to memory).",
      inputSchema: z.object({
        projectId: optionalId().describe("Defaults to the current project"),
        url: optionalText().describe("A web page to download and store"),
        title: optionalText().describe("Required with content; overrides the page title for a url"),
        content: optionalText().describe("The document text, when not saving a url"),
      }),
      execute: async ({ projectId, url, title, content }) => {
        const pid = projectId ?? ctx.projectId;
        if (!pid) return { error: "projectId is required: there is no current project" };
        if (!(await readableProjectIds(ctx)).includes(pid)) return { error: `Project ${pid} is not one of yours` };
        if (!url && !(title && content)) return { error: "Send a url, or a title with content" };
        try {
          const item = url
            ? await fetchPageText(url).then((page) => ({
                kind: "link" as const,
                title: title ?? page.title,
                sourceUrl: page.url,
                content: page.content,
              }))
            : { kind: "document" as const, title: title!, content: content! };
          const saved = await addKnowledgeItem({ projectId: pid, ...item });
          await audit({
            actor: actorOf(ctx),
            action: "knowledge.created",
            entityType: "knowledge_item",
            entityId: saved.id,
            data: { projectId: pid, kind: item.kind },
          });
          return { saved: true, id: saved.id, title: item.title, chunks: saved.chunks };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
};
