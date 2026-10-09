import { createHash } from "node:crypto";
import { db, memories, memoryRecalls, messages, runs, type Tx } from "@abotica/db";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "@abotica/db/orm";
import { CHARS_PER_TOKEN } from "../agents/compaction";
import { EMBEDDING_PROFILES } from "../models/embedding-profiles";
import { projectProviderPolicy } from "../models/provider-policy";
import { embeddingProvider } from "../models/providers";
import type { AppSettings } from "../settings/settings";
import type { ConversationHistory } from "../runs/run-messages";
import { currentMemories, embedQuery, memoriesVisibleTo, type MemoryOwner } from "./memory";
import { fitBudget, memoryTokens, type MessageRecall, recallQuery, recallTarget, recallText } from "./memory-budget";
import { orTsQuery } from "./memory-ranking";
import { type MemoryLayer, memoryLayer, type MemoryReader, notesProject } from "./memory-scope";
import { hybridSearchMemories } from "./memory-search";

/**
 * The memory a run gets (memory-budget.ts has the pure rules): pinned entries in the system prompt, and
 * the entries relevant to the newest user message recalled into it.
 */

/** An entry's tokens as Postgres counts them: the estimate of memoryTokens (characters, not UTF-16 units). */
const entryTokens = sql<number>`ceil(char_length(${memories.content})::numeric / ${CHARS_PER_TOKEN})`.mapWith(Number);

const promptColumns = {
  id: memories.id,
  scope: memories.scope,
  projectId: memories.projectId,
  content: memories.content,
  origin: memories.origin,
  updatedAt: memories.updatedAt,
};

/** Whether all the memory a run may read fits the pinned budget: small installs then get all of it. */
async function allFit(reader: MemoryReader, budgetTokens: number): Promise<boolean> {
  const [row] = await db
    .select({ tokens: sql<number>`coalesce(sum(${entryTokens}), 0)`.mapWith(Number) })
    .from(memories)
    .where(memoriesVisibleTo(reader));
  return (row?.tokens ?? 0) <= budgetTokens;
}

/**
 * The memory in a run's system prompt: pinned entries of the scopes it may read, newest first, cut to
 * `budgetTokens`; `omitted` counts the pinned ones left out. While every entry it may read fits the budget,
 * all of them are in (`all`), pinned or not, and there is nothing to recall. The result only changes when
 * those entries change, so the prompt stays the same across the agent's conversations (prompt cache).
 */
export async function pinnedMemories(reader: MemoryReader, budgetTokens: number) {
  const all = await allFit(reader, budgetTokens);
  const rows = await db
    .select({ ...promptColumns, tokens: entryTokens })
    .from(memories)
    .where(and(memoriesVisibleTo(reader), all ? undefined : eq(memories.pinned, true)))
    .orderBy(desc(memories.updatedAt), memories.id);
  const { kept, omitted } = all ? { kept: rows, omitted: 0 } : fitBudget(rows, budgetTokens, (m) => m.tokens);
  const ofLayer = (layer: MemoryLayer) =>
    kept
      .filter((m) => memoryLayer(m) === layer)
      .map(({ id, content, origin, updatedAt }) => ({ id, content, origin, updatedAt }));
  return {
    all,
    omitted,
    global: ofLayer("global"),
    craft: ofLayer("craft"),
    team: ofLayer("team"),
    notes: ofLayer("mine"),
  };
}

/** Entries a conversation's prompt lists as written in it, newest first. */
const WRITTEN_IN_CONVERSATION_LIMIT = 20;

/**
 * The entries the run may read whose current version an agent run of this conversation wrote (saved, or
 * changed with memory_update). The prompt lists them apart, so the agent does not take what it saved a
 * minute ago for a rule that was there before.
 */
export async function writtenInConversation(conversationId: string, reader: MemoryReader) {
  return db
    .select({ id: memories.id, content: memories.content, origin: memories.origin })
    .from(memories)
    .innerJoin(runs, eq(runs.id, memories.runId))
    .where(and(eq(runs.conversationId, conversationId), memoriesVisibleTo(reader)))
    .orderBy(desc(memories.createdAt), memories.id)
    .limit(WRITTEN_IN_CONVERSATION_LIMIT);
}

/** Search results a recall picks from before its budget cut. */
const RECALL_CANDIDATES = 20;

/**
 * The unpinned entries a run may read that match `query`, best first, cut to `budgetTokens`. Nothing for a
 * query without a topic word (a greeting, a thank-you): the nearest entries to "ok, thanks" are noise; and
 * nothing the embedding model finds unlikely to answer it (its recallSimilarity).
 */
export async function recallMemories(query: string, opts: MemoryReader & { budgetTokens: number }) {
  if (opts.budgetTokens <= 0 || !orTsQuery(query)) return [];
  // A message in a project (or in the super agent's topic of one) may carry its data.
  const vector = await embedQuery(query, await projectProviderPolicy(notesProject(opts)));
  const found = await hybridSearchMemories(query, {
    vector,
    where: and(memoriesVisibleTo(opts), eq(memories.pinned, false)),
    limit: RECALL_CANDIDATES,
  });
  // Nobody asked for these entries: one whose vector is far from the message stays out, even when it shares
  // a word with it. Entries without a vector were found by their words.
  const { recallSimilarity } = EMBEDDING_PROFILES[await embeddingProvider()];
  const relevant = found.filter((m) => m.similarity === null || m.similarity >= recallSimilarity);
  return fitBudget(relevant, opts.budgetTokens, (m) => memoryTokens(m.content)).kept;
}

/** The same question asked twice hashes the same: case, Unicode form and spacing do not count. */
const queryHash = (query: string) =>
  createHash("sha256").update(query.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim()).digest("hex");

/**
 * Records that entries reached a run, for ranking by use and promotion: one `memory_recalls` row each, and
 * their counters. A use, not an edit: `updatedAt` (recency in search, order in the prompt) stays.
 */
export async function logMemoryRecalls(
  ids: string[],
  opts: { runId: string | null; query: string; source: "context" | "search"; tx?: Tx },
): Promise<void> {
  if (!ids.length) return;
  const run = opts.tx ?? db;
  const hash = queryHash(opts.query);
  await run
    .insert(memoryRecalls)
    .values(ids.map((memoryId) => ({ memoryId, runId: opts.runId, source: opts.source, queryHash: hash })));
  await run
    .update(memories)
    .set({
      recallCount: sql`${memories.recallCount} + 1`,
      lastRecalledAt: sql`now()`,
      updatedAt: sql`${memories.updatedAt}`,
    })
    .where(inArray(memories.id, ids));
}

/**
 * Records that the entries in a run's instructions were used while all memory fits there (see
 * pinnedMemories): nothing is recalled or searched then, and every entry would look never used. At most
 * once a day an entry, and without `memory_recalls` rows, which promotion counts. A use, not an edit:
 * `updatedAt` stays. In the background: a failed write is logged and the run goes on.
 */
export function notePromptMemoryUse(ids: string[]): void {
  if (!ids.length) return;
  db.update(memories)
    .set({
      recallCount: sql`${memories.recallCount} + 1`,
      lastRecalledAt: sql`now()`,
      updatedAt: sql`${memories.updatedAt}`,
    })
    .where(
      and(
        inArray(memories.id, ids),
        or(isNull(memories.lastRecalledAt), lt(memories.lastRecalledAt, sql`now() - interval '1 day'`)),
      ),
    )
    .catch((error: unknown) => console.error("[memory] recording the use of the memory in a prompt failed:", error));
}

/**
 * Recalls memory for the newest user message of a run's history and saves it on that message
 * (`metadata.recall`), so later runs replay the same text instead of searching again; the history comes
 * back with it. Nothing to do when the message already has its recall (a continuation). When recall is
 * off, or while all memory fits in the instructions, the recall saved is empty. A message without text
 * searches with the run input.
 */
export async function recallForRun(
  history: ConversationHistory,
  run: MemoryReader & {
    id: string;
    input: string;
    settings: { memory: Pick<AppSettings["memory"], "pinnedTokens" | "recallTokens"> };
  },
): Promise<ConversationHistory> {
  const index = recallTarget(history.messages);
  if (index === null) return history;

  const target = history.messages[index]!;
  const query = recallQuery(target.message, run.input);
  const reader: MemoryReader = { agentId: run.agentId, projectId: run.projectId, notesProjectId: run.notesProjectId };
  const searches = run.settings.memory.recallTokens > 0 && !(await allFit(reader, run.settings.memory.pinnedTokens));
  const found = searches ? await recallMemories(query, { ...reader, budgetTokens: run.settings.memory.recallTokens }) : [];
  // Saved even when empty: a continuation must not search again and change a turn the model has seen,
  // also after recall was turned on or memory outgrew the instructions.
  const recall: MessageRecall = { memoryIds: found.map((m) => m.id), text: recallText(found) };
  await db.transaction(async (tx) => {
    await tx
      .update(messages)
      .set({ metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify({ recall })}::jsonb` })
      .where(eq(messages.id, target.message.id));
    await logMemoryRecalls(recall.memoryIds, { runId: run.id, query, source: "context", tx });
  });

  const metadata = { ...(target.message.metadata as Record<string, unknown> | undefined), recall };
  return {
    ...history,
    messages: history.messages.map((m, i) => (i === index ? { ...m, message: { ...m.message, metadata } } : m)),
  };
}

/**
 * How much of the pinned budget the pinned entries take that every run of `owner` gets: the global ones,
 * plus the owner's: an agent's craft, a project's team memory (null: global only). For the memory pages;
 * a project run also gets its agent's craft and notes on the project.
 */
export async function pinnedUsage(owner: MemoryOwner | null, budgetTokens: number) {
  const ownerScope = !owner
    ? undefined
    : "agentId" in owner
      ? and(eq(memories.scope, "agent"), eq(memories.agentId, owner.agentId), isNull(memories.projectId))
      : and(eq(memories.scope, "project"), eq(memories.projectId, owner.projectId));
  const rows = await db
    .select({ tokens: entryTokens })
    .from(memories)
    .where(and(currentMemories(), eq(memories.pinned, true), or(eq(memories.scope, "global"), ownerScope)))
    .orderBy(desc(memories.updatedAt), memories.id);
  const { usedTokens, omitted } = fitBudget(rows, budgetTokens, (m) => m.tokens);
  return { count: rows.length, usedTokens, omitted, budgetTokens };
}
