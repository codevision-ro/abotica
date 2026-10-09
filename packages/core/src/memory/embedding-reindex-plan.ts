/**
 * Pure steps of the re-embedding after the embedding provider or its model changes (see embedding-reindex.ts): the
 * tables in order, the cursor through them and which rows of a batch to embed. No server imports.
 */

import type { EmbeddingProvider } from "../settings/settings-schema";

/** The tables with an embedding column, in the order they are re-embedded. */
const REINDEX_TABLES = ["memories", "journals", "knowledge_chunks"] as const;
export type ReindexTable = (typeof REINDEX_TABLES)[number];

/** Where a re-embedding stands. Stored in the app_state table, so it goes on after a restart. */
export type ReindexState = {
  provider: EmbeddingProvider;
  /** The model and prompts the vectors are embedded with (embeddingFingerprint). */
  model: string;
  /** When the provider changed: tells this re-embedding from a later one that replaced it. */
  startedAt: string;
  table: ReindexTable;
  /** The last id handled in `table`, in id order; null before its first row. */
  after: string | null;
  /** Rows handled so far, embedded or skipped, out of the `total` there were at the start. */
  done: number;
  total: number;
  /** Why the last batch could not be embedded (no key, server down, model loading); null while it goes well. */
  error: string | null;
};

export function startReindex(provider: ReindexState["provider"], model: string, total: number, now: Date): ReindexState {
  return {
    provider,
    model,
    startedAt: now.toISOString(),
    table: REINDEX_TABLES[0],
    after: null,
    done: 0,
    total,
    error: null,
  };
}

/**
 * The state after a batch: `handled` ids in id order, out of at most `batchSize`. A full batch may have
 * rows after it; a shorter one ends its table, and null means the last table is done.
 */
export function advanceReindex(state: ReindexState, handled: readonly string[], batchSize: number): ReindexState | null {
  const done = state.done + handled.length;
  if (handled.length >= batchSize) return { ...state, after: handled.at(-1)!, done, error: null };
  const next = REINDEX_TABLES[REINDEX_TABLES.indexOf(state.table) + 1];
  return next ? { ...state, table: next, after: null, done, error: null } : null;
}

/**
 * Whether `stored` is still at the batch `taken` was read for. When it is not, the provider or model changed again
 * or another worker handled the batch first, and what was embedded for it is dropped.
 */
export const sameBatch = (stored: ReindexState, taken: ReindexState): boolean =>
  stored.startedAt === taken.startedAt &&
  stored.provider === taken.provider &&
  stored.model === taken.model &&
  stored.table === taken.table &&
  stored.after === taken.after;

/** A row of a batch: `projectId` is the project whose provider policy its content follows (null: none). */
export type ReindexRow = { id: string; projectId: string | null; embedded: boolean };

/**
 * The rows to embed: those still without an embedding (one written since the change already has the new
 * provider's), outside projects or in one whose policy allows the provider. The others stay without one,
 * searched by keyword, as they would have been written.
 */
export const rowsToEmbed = <R extends ReindexRow>(rows: readonly R[], allows: (projectId: string) => boolean): R[] =>
  rows.filter((row) => !row.embedded && (row.projectId === null || allows(row.projectId)));
