import { appState, db, journals, knowledgeChunks, memories, type Tx } from "@abotica/db";
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, or, sql } from "@abotica/db/orm";
import { publish } from "../infra/events";
import { maintenanceQueue } from "../infra/queues";
import { embeddingAllowed, projectProviderPolicy } from "../models/provider-policy";
import { embeddingProvider } from "../models/providers";
import {
  announceSettings,
  type EmbeddingProvider,
  getSettings,
  storedSettings,
  updateSettings,
} from "../settings/settings";
import {
  advanceReindex,
  type ReindexRow,
  type ReindexState,
  type ReindexTable,
  rowsToEmbed,
  sameBatch,
  startReindex,
} from "./embedding-reindex-plan";
import { embedWith } from "./memory";

export type { ReindexState } from "./embedding-reindex-plan";

/**
 * Vectors of two embedding models cannot be compared, so changing the provider clears every embedding
 * and embeds the rows again in the background, a batch at a time. Meanwhile, rows without an embedding
 * are found by keyword (see memory-search.ts). The state lives in an app_state row: the worker picks it up
 * after a restart, and a batch commits only if the state is still where it read it, so a batch handled
 * twice, or one embedded for a provider that was switched away since, writes nothing.
 */

/** The app_state row of the re-embedding in progress; there is none when nothing is left to do. */
const STATE_KEY = "embeddings_reindex";
/** Rows per embedding request: well within what any provider takes at once. */
const BATCH_SIZE = 64;

const TABLES = {
  memories: { table: memories, id: memories.id, projectId: memories.projectId, text: memories.content },
  journals: { table: journals, id: journals.id, projectId: journals.projectId, text: journals.summary },
  knowledge_chunks: {
    table: knowledgeChunks,
    id: knowledgeChunks.id,
    projectId: knowledgeChunks.projectId,
    text: knowledgeChunks.content,
  },
};

/** The re-embedding in progress; null when the embeddings match the provider in Settings. */
export async function getReindexState(): Promise<ReindexState | null> {
  const [row] = await db.select({ value: appState.value }).from(appState).where(eq(appState.key, STATE_KEY));
  return (row?.value as ReindexState | undefined) ?? null;
}

/** The state, locked until `tx` ends: a provider change and a batch's writes take turns on it. */
async function lockState(tx: Tx): Promise<ReindexState | null> {
  const [row] = await tx.select({ value: appState.value }).from(appState).where(eq(appState.key, STATE_KEY)).for("update");
  return (row?.value as ReindexState | undefined) ?? null;
}

async function rowCount(): Promise<number> {
  const counts = await Promise.all(
    [memories, journals, knowledgeChunks].map((table) => db.select({ n: count() }).from(table)),
  );
  return counts.reduce((sum, [row]) => sum + (row?.n ?? 0), 0);
}

/**
 * Switches the embedding provider: clears the embeddings and starts embedding everything again with
 * `provider` (see reindexSlice). Returns the new re-embedding; null when `provider` is already the one.
 */
export async function changeEmbeddingProvider(provider: EmbeddingProvider, actor = "user"): Promise<ReindexState | null> {
  if ((await getSettings()).memory.embeddingProvider === provider) return null;
  return startEmbeddingReindex(provider, actor);
}

async function startEmbeddingReindex(provider: EmbeddingProvider, actor: string): Promise<ReindexState> {
  const state = startReindex(provider, await rowCount(), new Date());
  await db.transaction(async (tx) => {
    // The state row first: a batch locks it before writing vectors, so the two never wait on each other.
    await saveState(tx, state);
    await updateSettings("memory", { embeddingProvider: provider }, { actor, tx });
    await tx
      .update(memories)
      .set({ embedding: null, updatedAt: sql`${memories.updatedAt}` })
      .where(isNotNull(memories.embedding));
    await tx.update(journals).set({ embedding: null }).where(isNotNull(journals.embedding));
    await tx.update(knowledgeChunks).set({ embedding: null }).where(isNotNull(knowledgeChunks.embedding));
  });
  await announceSettings("memory");
  await requestReindex();
  await publish({ type: "embeddings.reindex" });
  return state;
}

/**
 * The provider of an install from before the built-in model became the default, where a provider never
 * saved in Settings meant OpenAI; run at the worker's start. Vectors already stored are OpenAI's, so it
 * stays on OpenAI. Rows without any vector mean OpenAI never embedded (no API key): they are embedded
 * with the built-in model. Without rows, or with the provider saved, there is nothing to settle.
 */
export async function settleEmbeddingProvider(): Promise<void> {
  if ((await storedSettings()).memory?.embeddingProvider) return;
  const embedded = await Promise.all(
    [memories, journals, knowledgeChunks].map((table) =>
      db.select({ id: table.id }).from(table).where(isNotNull(table.embedding)).limit(1),
    ),
  );
  if (embedded.some((rows) => rows.length)) {
    return void (await updateSettings("memory", { embeddingProvider: "openai" }, { actor: "system" }));
  }
  if (await rowCount()) await startEmbeddingReindex("local", "system");
}

/** Asks the worker for a slice of the re-embedding now, rather than at its next scheduled one. */
export async function requestReindex(): Promise<void> {
  await maintenanceQueue().add(
    "embeddings-reindex",
    { kind: "embeddings-reindex" },
    { attempts: 1, removeOnComplete: true, removeOnFail: true },
  );
}

async function saveState(tx: Tx, state: ReindexState | null): Promise<void> {
  if (!state) return void (await tx.delete(appState).where(eq(appState.key, STATE_KEY)));
  await tx
    .insert(appState)
    .values({ key: STATE_KEY, value: state })
    .onConflictDoUpdate({ target: appState.key, set: { value: state } });
}

async function batchRows(state: ReindexState): Promise<(ReindexRow & { text: string })[]> {
  const t = TABLES[state.table];
  return db
    .select({ id: t.id, projectId: t.projectId, text: t.text, embedded: sql<boolean>`${t.table.embedding} is not null` })
    .from(t.table)
    .where(state.after ? gt(t.id, state.after) : undefined)
    .orderBy(asc(t.id))
    .limit(BATCH_SIZE);
}

/** The projects among `rows` whose provider policy allows `provider`. */
async function allowingProjects(rows: readonly ReindexRow[], provider: EmbeddingProvider): Promise<Set<string>> {
  const ids = [...new Set(rows.flatMap((r) => (r.projectId ? [r.projectId] : [])))];
  const allowed = await Promise.all(ids.map(async (id) => embeddingAllowed(await projectProviderPolicy(id), provider)));
  return new Set(ids.filter((_, i) => allowed[i]));
}

/** Writes one row's vector, unless it got one meanwhile (written since the change, by the new provider). */
async function writeEmbedding(tx: Tx, table: ReindexTable, id: string, embedding: number[]): Promise<void> {
  switch (table) {
    case "memories":
      await tx
        .update(memories)
        .set({ embedding, updatedAt: sql`${memories.updatedAt}` })
        .where(and(eq(memories.id, id), isNull(memories.embedding)));
      return;
    case "journals":
      await tx
        .update(journals)
        .set({ embedding })
        .where(and(eq(journals.id, id), isNull(journals.embedding)));
      return;
    case "knowledge_chunks":
      await tx
        .update(knowledgeChunks)
        .set({ embedding })
        .where(and(eq(knowledgeChunks.id, id), isNull(knowledgeChunks.embedding)));
  }
}

/**
 * Embeds the next batch; returns whether some is left. Throws when the provider cannot embed (no key,
 * server down), leaving the state where it was.
 */
export async function reindexBatch(): Promise<boolean> {
  const state = await getReindexState();
  if (!state) return false;
  const rows = await batchRows(state);
  const allowing = await allowingProjects(rows, state.provider);
  const pending = rowsToEmbed(rows, (projectId) => allowing.has(projectId));
  const vectors = await embedWith(
    state.provider,
    pending.map((r) => r.text),
  );
  return db.transaction(async (tx) => {
    const stored = await lockState(tx);
    // Gone or moved on: the batch was handled, or the provider changed again; nothing here applies.
    if (!stored || !sameBatch(stored, state)) return stored !== null;
    for (const [i, row] of pending.entries()) await writeEmbedding(tx, state.table, row.id, vectors[i]!);
    const next = advanceReindex(
      stored,
      rows.map((r) => r.id),
      BATCH_SIZE,
    );
    await saveState(tx, next);
    return next !== null;
  });
}

/**
 * Keeps why the provider could not embed, for Settings to show; the next slice tries again. Returns
 * whether the error is new, so the page is not refreshed every minute for the same one.
 */
async function recordError(message: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const stored = await lockState(tx);
    if (!stored || stored.error === message) return false;
    await saveState(tx, { ...stored, error: message });
    return true;
  });
}

/**
 * Re-embeds for about `ms`, batch after batch, so the other maintenance jobs get their turn in between.
 * Returns whether some is left to do right away. An error stops the slice and is kept in the state; the
 * worker runs a slice every minute, so the re-embedding resumes once the provider can embed again.
 */
export async function reindexSlice(ms: number): Promise<boolean> {
  if (!(await getReindexState())) return false;
  const deadline = Date.now() + ms;
  let more = true;
  try {
    while (more && Date.now() < deadline) more = await reindexBatch();
  } catch (error) {
    const message = (error as Error).message;
    console.warn("[memory] re-embedding paused, the provider could not embed:", message);
    if (await recordError(message)) await publish({ type: "embeddings.reindex" });
    return false;
  }
  await publish({ type: "embeddings.reindex" });
  return more;
}

/**
 * Embeds rows written without a vector while no re-embedding runs: the provider could not embed at
 * the time (the worker was down, the built-in model still downloading, a key missing). Rows of a
 * project whose policy does not allow the provider stay without one, by design. Returns how many it
 * embedded; a provider that still cannot embed leaves them for the next pass, quietly.
 */
export async function backfillEmbeddings(): Promise<number> {
  if (await getReindexState()) return 0;
  const provider = await embeddingProvider();
  let done = 0;
  for (const [name, t] of Object.entries(TABLES) as [ReindexTable, (typeof TABLES)[ReindexTable]][]) {
    // The projects with rows waiting, checked once each, so rows a policy keeps out never crowd the batch.
    const waiting = await db
      .selectDistinct({ projectId: t.projectId })
      .from(t.table)
      .where(and(isNull(t.table.embedding), isNotNull(t.projectId)));
    const allowing = await allowingProjects(
      waiting.map((w) => ({ id: "", projectId: w.projectId, embedded: false })),
      provider,
    );
    const rows = await db
      .select({ id: t.id, text: t.text })
      .from(t.table)
      .where(
        and(
          isNull(t.table.embedding),
          allowing.size ? or(isNull(t.projectId), inArray(t.projectId, [...allowing])) : isNull(t.projectId),
        ),
      )
      .orderBy(asc(t.id))
      .limit(BATCH_SIZE);
    if (!rows.length) continue;
    let vectors: number[][];
    try {
      vectors = await embedWith(
        provider,
        rows.map((r) => r.text),
      );
    } catch {
      return done;
    }
    await db.transaction(async (tx) => {
      for (const [i, row] of rows.entries()) await writeEmbedding(tx, name, row.id, vectors[i]!);
    });
    done += rows.length;
  }
  return done;
}
