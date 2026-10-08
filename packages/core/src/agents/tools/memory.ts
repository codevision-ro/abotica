import { db, memories } from "@abotica/db";
import { tool } from "ai";
import { eq } from "@abotica/db/orm";
import { z } from "zod";
import { audit } from "../../platform/audit";
import { addKnowledgeItem, fetchPageText, searchKnowledge } from "../../memory/knowledge";
import { deleteMemory, saveMemory, searchJournals, searchMemories, updateMemory } from "../../memory/memory";
import { EPHEMERAL_DAYS, MEMORY_RETENTIONS } from "../../memory/memory-consolidation";
import { logMemoryRecalls } from "../../memory/memory-recall";
import { MemorySecretError, SECRET_REFUSED } from "../../memory/memory-write-gate";
import { defaultMemoryScope, memoryEditableBy } from "../../memory/memory-scope";
import type { RunContext } from "../context";
import { modelChain } from "../model-chain";
import { neutralizeMarkers, wrapUntrusted } from "../untrusted";
import { markerId } from "../untrusted-id";
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
  // History stays as it was; the current version is the one to change.
  if (memory.invalidatedAt) {
    return {
      error: `Memory ${id} was replaced by a newer entry${memory.supersededBy ? ` (${memory.supersededBy})` : ""}. Use memory_search to find the current one.`,
    };
  }
  return memory;
}

/**
 * Whose content an agent writes: untrusted once the run has read untrusted data (see
 * RunContext.untrustedSeen). Read at write time, since a tool result can set it mid-run.
 */
const writeOrigin = (ctx: RunContext): Memory["origin"] => (ctx.untrustedSeen ? "untrusted" : "agent");

const retention = z
  .enum(MEMORY_RETENTIONS)
  .optional()
  .describe(
    `How long the fact holds: permanent (the user's preferences and habits, true indefinitely), durable (the default: decisions, project knowledge, configuration, valid for months) or ephemeral (temporary arrangements that change within weeks; forgotten after ${EPHEMERAL_DAYS} days).`,
  );

/** Asked of every write: memory is read days or months later. */
const ABSOLUTE_DATES = 'Write dates as YYYY-MM-DD, never "today", "yesterday" or "next week": memory is read long after.';

/** Repository tokens of the run, which a write must not store (the vault's are checked by core). */
const runSecrets = (ctx: RunContext) => ({ knownSecrets: ctx.repos.map((r) => r.token) });

/** The write's result, or the refusal the model gets for a secret. */
async function unlessSecret<T>(write: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof MemorySecretError) return { error: SECRET_REFUSED };
    throw error;
  }
}

export const memoryTools: Record<string, ToolFactory> = {
  memory_search: (ctx) =>
    tool({
      description: ctx.projectId
        ? "Search memory for relevant information: preferences, decisions, facts. It covers global memory, this project's memory and your own. Use it before assuming anything. Results carry the ids memory_update and memory_delete need."
        : "Search memory (global and your own) for relevant information: preferences, decisions, facts. Use it before assuming anything. Results carry the ids memory_update and memory_delete need.",
      inputSchema: z.object({ query: z.string().describe("What you are looking for, in natural language") }),
      execute: async ({ query }) => {
        const found = await searchMemories(query, { agentId: ctx.agent.id, projectId: ctx.projectId, limit: 10 });
        // What search returns is a use: entries found often, by different queries, are promoted.
        await logMemoryRecalls(
          found.map((m) => m.id),
          { runId: ctx.run.id, query, source: "search" },
        );
        return found;
      },
    }),

  memory_save: (ctx) =>
    tool({
      description: [
        "Save a fact to memory. Do not save intermediate steps, and never secrets (keys, tokens, passwords). To correct an existing entry use memory_update instead of saving a second one.",
        ABSOLUTE_DATES,
        "Say how long it holds with retention.",
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
        retention,
      }),
      execute: async ({ content, scope = defaultMemoryScope(ctx.projectId), projectId, retention }) => {
        const pid = projectId ?? ctx.projectId;
        if (scope === "project" && !pid) return { error: "projectId is required for project memory" };
        // A run writes only to its own project's memory; the super agent may note facts for any project.
        if (scope === "project" && pid !== ctx.projectId && !ctx.agent.isOrchestrator) {
          return { error: "You can save project memory only for the project of this run" };
        }
        const result = await unlessSecret(() =>
          saveMemory(
            {
              scope,
              content,
              projectId: pid,
              agentId: ctx.agent.id,
              source: "agent",
              origin: writeOrigin(ctx),
              status: ctx.settings.memoryRequiresApproval ? "pending" : "active",
              retention,
            },
            { actor: actorOf(ctx), ...runSecrets(ctx) },
          ),
        );
        if ("error" in result) return result;
        // Another project's memory is not the run's to read (the super agent's included, whatever the
        // project's provider restriction): the answer names no entry's content, only ids.
        const blind = scope === "project" && pid !== ctx.projectId;
        if ("duplicateOf" in result) {
          return {
            saved: false,
            duplicateOf: result.duplicateOf.id,
            ...(!blind && { content: result.duplicateOf.content }),
            note: "Memory already holds this fact. If you meant to correct it, use memory_update with this id.",
          };
        }
        const { memory, related, heldBecause } = result;
        return {
          saved: true,
          id: memory.id,
          scope,
          pendingApproval: memory.status === "pending",
          ...(heldBecause && { pendingReason: heldBecause }),
          ...(!blind &&
            related.length > 0 && {
              related: related.map(({ id, content }) => ({ id, content })),
              note: "These entries are close to the new fact. If it replaces one of them, update or delete that one.",
            }),
        };
      },
    }),

  memory_update: (ctx) =>
    tool({
      description: [
        "Replace the content of a memory entry that is wrong or outdated. Get the id from memory_search. Write the complete new content, not a diff.",
        ABSOLUTE_DATES,
        "Set retention when how long it holds changed; left out, it keeps the entry's. An entry agents wrote keeps its old version as history: the update returns the id of the new entry.",
      ].join(" "),
      inputSchema: z.object({ memoryId: z.string().uuid(), content: z.string().min(3), retention }),
      execute: async ({ memoryId, content, retention }) => {
        const memory = await editableMemory(ctx, memoryId);
        if ("error" in memory) return memory;
        const result = await unlessSecret(() =>
          updateMemory(memory.id, content, {
            actor: actorOf(ctx),
            // Rewording an untrusted entry does not make it trusted.
            origin: memory.origin === "untrusted" ? "untrusted" : writeOrigin(ctx),
            ...(ctx.settings.memoryRequiresApproval && { status: "pending" }),
            retention,
            agentId: ctx.agent.id,
            ...runSecrets(ctx),
          }),
        );
        if ("error" in result) return result;
        return {
          updated: true,
          id: result.id,
          ...(result.id !== memory.id && { replaces: memory.id }),
          pendingApproval: result.heldBecause !== null,
          ...(result.heldBecause && { pendingReason: result.heldBecause }),
        };
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
      // Text saved from a web page goes to the model as untrusted data; documents agents wrote stay as they are.
      toModelOutput: ({ toolCallId, output }) => {
        if (!Array.isArray(output) || !output.some((item) => item.sourceUrl)) return { type: "json", value: output };
        ctx.untrustedSeen = true;
        const id = markerId(toolCallId);
        return {
          type: "json",
          value: output.map((item) =>
            item.sourceUrl
              ? {
                  ...item,
                  title: neutralizeMarkers(item.title),
                  content: wrapUntrusted(item.content, { source: "knowledge", id }),
                }
              : item,
          ),
        };
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
