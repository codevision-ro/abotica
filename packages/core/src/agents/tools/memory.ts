import { db, memories } from "@abotica/db";
import { tool } from "ai";
import { eq } from "@abotica/db/orm";
import { z } from "zod";
import { audit } from "../../platform/audit";
import { addKnowledgeItem, fetchPageText, searchKnowledge } from "../../memory/knowledge";
import { deleteMemory, saveMemory, searchJournals, searchMemories, updateMemory } from "../../memory/memory";
import { EPHEMERAL_DAYS, MEMORY_RETENTIONS } from "../../memory/memory-consolidation";
import { logMemoryRecalls } from "../../memory/memory-recall";
import {
  MemorySecretError,
  namedProject,
  namesProjectRefusal,
  projectsOfAgent,
  SECRET_REFUSED,
} from "../../memory/memory-write-gate";
import { defaultMemoryLayer, layerTarget, MEMORY_LAYERS, memoryEditableBy, memoryLayer } from "../../memory/memory-scope";
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
      isOrchestrator: ctx.agent.kind === "orchestrator",
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
    `permanent: the user's lasting preferences; durable (default): decisions and knowledge valid for months; ephemeral: arrangements that change within weeks, forgotten after ${EPHEMERAL_DAYS} days.`,
  );

/** Asked of every write: memory is read days or months later. */
const ABSOLUTE_DATES = 'Write dates as YYYY-MM-DD, never "today", "yesterday" or "next week": memory is read long after.';

/** Repository tokens of the run, which a write must not store (the vault's are checked by core). */
const runSecrets = (ctx: RunContext) => ({ knownSecrets: ctx.repos.map((r) => r.token) });

/**
 * Why a project run may not write `content` to the agent's craft, null when it may: the agent reads its
 * craft in every project, so naming one of its projects there would carry it into the others.
 */
async function namesAProject(ctx: RunContext, content: string): Promise<string | null> {
  const orchestrator = ctx.agent.kind === "orchestrator";
  // Outside projects only the super agent knows projects to name; another agent's craft written there is its own.
  if (!ctx.projectId && !orchestrator) return null;
  const term = namedProject(content, await projectsOfAgent(ctx.agent.id, ctx.projectId, orchestrator));
  if (!term) return null;
  return orchestrator ? `${namesProjectRefusal(term)} Name the project with projectId.` : namesProjectRefusal(term);
}

/**
 * `schema` with its projectId for the super agent only: the other agents work in the run's project, so
 * the field would only cost every prompt its description. Typed as the full schema, whose projectId is
 * then always undefined.
 */
function superAgentOnlyProject<S extends z.ZodObject<{ projectId: z.ZodType }>>(ctx: RunContext, schema: S): S {
  return ctx.agent.kind === "orchestrator" ? schema : (schema.omit({ projectId: true }) as unknown as S);
}

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
      description: [
        ctx.projectId
          ? "Search memory: global, your craft, this project's team memory and your notes on it."
          : ctx.agent.kind === "orchestrator"
            ? "Search memory: global and your craft; with a projectId, also your notes on that project."
            : "Search memory: global and your craft.",
        "Use it before assuming anything. Results carry the ids memory_update and memory_delete need.",
      ].join(" "),
      inputSchema: superAgentOnlyProject(
        ctx,
        z.object({
          query: z.string().describe("What you are looking for, in natural language"),
          projectId: optionalId().describe("Also search your notes on it"),
        }),
      ),
      execute: async ({ query, projectId }) => {
        // Only the super agent names a project here: the others read the run's.
        const notesProjectId = ctx.agent.kind === "orchestrator" ? (projectId ?? ctx.notesProjectId) : null;
        if (notesProjectId && notesProjectId !== ctx.notesProjectId) {
          if (!(await readableProjectIds(ctx)).includes(notesProjectId))
            return { error: `Project ${projectId} does not exist` };
          if ((await closedProjects(ctx)).has(notesProjectId)) return { error: `Project ${projectId}: ${WITHHELD_NOTE}` };
        }
        const found = await searchMemories(query, {
          agentId: ctx.agent.id,
          projectId: ctx.projectId,
          notesProjectId,
          limit: 10,
        });
        // What search returns is a use: entries found often, by different queries, are promoted.
        await logMemoryRecalls(
          found.map((m) => m.id),
          { runId: ctx.run.id, query, source: "search" },
        );
        // Marked like in the prompt: distilled from web pages or tool results, to use as information only.
        return found.map(({ id, content, updatedAt, origin, ...layer }) => ({
          id,
          scope: memoryLayer(layer),
          content,
          updatedAt,
          ...(origin === "untrusted" && { fromExternalContent: true }),
        }));
      },
    }),

  memory_save: (ctx) =>
    tool({
      description: [
        "Save a durable fact: no intermediate steps, never secrets. To correct an entry, use memory_update.",
        ABSOLUTE_DATES,
        ctx.projectId
          ? "scope: mine (the default) for what you learned working on this project, read only by you and only here; team for decisions, conventions and facts the whole team must share; craft for your methods, tools and lessons that hold in any project, never names of projects, clients or sites."
          : ctx.agent.kind === "orchestrator"
            ? "scope: craft (the default) for what you learned yourself; global for the user's rules and preferences, read by every agent; with a projectId, mine for your own notes on that project or team for what its whole team must share."
            : "scope: craft (the default) for your methods, tools and lessons that hold in any project. global is the super agent's, for the user's rules.",
      ].join(" "),
      inputSchema: superAgentOnlyProject(
        ctx,
        z.object({
          content: z.string().min(3),
          scope: z.enum(MEMORY_LAYERS).optional(),
          projectId: optionalId().describe("The project of scope=mine or scope=team"),
          retention,
        }),
      ),
      execute: async ({ content, scope = defaultMemoryLayer(ctx.projectId), projectId, retention }) => {
        const isOrchestrator = ctx.agent.kind === "orchestrator";
        // A run writes only to its own project; the super agent names the project it writes about.
        // In a project's Telegram topic, notes and team entries are about that project unless it names another.
        const pid = isOrchestrator
          ? (projectId ?? (scope === "mine" || scope === "team" ? (ctx.topicProject?.id ?? null) : null))
          : ctx.projectId;
        if ((scope === "mine" || scope === "team") && !pid) {
          return {
            error: isOrchestrator
              ? `projectId is required for scope=${scope}`
              : `scope=${scope} is for project runs; outside projects save your craft (scope=craft)`,
          };
        }
        if (isOrchestrator && pid && !(await readableProjectIds(ctx)).includes(pid)) {
          return { error: `Project ${pid} does not exist` };
        }
        // Global memory is the user's rules for every agent: a specialist's note there would reach all projects.
        if (scope === "global" && !isOrchestrator) {
          return {
            error:
              "Only the super agent saves global memory (the user's rules). Save it with scope=mine or scope=team, or scope=craft if it holds in any project.",
          };
        }
        const refused = scope === "craft" ? await namesAProject(ctx, content) : null;
        if (refused) return { error: refused };
        const target = layerTarget(scope, pid);
        const result = await unlessSecret(() =>
          saveMemory(
            {
              ...target,
              content,
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
        // Another project's team memory is not the run's to read (the super agent's included, whatever the
        // project's provider restriction), nor its notes on a project closed to its models: the answer
        // names no entry's content, only ids.
        const blind =
          target.projectId !== null &&
          target.projectId !== ctx.projectId &&
          (scope === "team" || (await closedProjects(ctx)).has(target.projectId));
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
        "Replace a wrong or outdated entry (id from memory_search) with its complete new content. It returns the new entry's id; the old one stays as history.",
        ABSOLUTE_DATES,
        ctx.projectId && "The entry keeps its scope; craft never names projects, clients or sites.",
      ]
        .filter(Boolean)
        .join(" "),
      inputSchema: z.object({ memoryId: z.string().uuid(), content: z.string().min(3), retention }),
      execute: async ({ memoryId, content, retention }) => {
        const memory = await editableMemory(ctx, memoryId);
        if ("error" in memory) return memory;
        const refused = memoryLayer(memory) === "craft" ? await namesAProject(ctx, content) : null;
        if (refused) {
          return { error: `${refused} Use memory_save for it, and keep this entry for what holds in any project.` };
        }
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
      description:
        ctx.agent.kind === "orchestrator"
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
        if (ctx.agent.kind !== "orchestrator") {
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
