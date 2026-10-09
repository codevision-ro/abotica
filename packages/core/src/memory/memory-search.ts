import { db, journals, memories, type Tx } from "@abotica/db";
import { type AnyColumn, and, cosineDistance, desc, isNotNull, sql, type SQL } from "@abotica/db/orm";
import { EMBEDDING_PROFILES } from "../models/embedding-profiles";
import { embeddingProvider } from "../models/providers";
import { CANDIDATE_MULTIPLIER, orTsQuery, rankCandidates } from "./memory-ranking";

/**
 * Runs a filtered nearest-neighbour search. An HNSW index hands the WHERE filter only ef_search
 * candidates (40 by default), so the rows of a small project or agent among many could all be missed;
 * pgvector's iterative scan keeps reading the index until the LIMIT is met. Relaxed order may return
 * rows slightly out of distance order, so they are sorted again here.
 */
export async function nearestFirst<T extends { distance: number | null }>(search: (tx: Tx) => Promise<T[]>): Promise<T[]> {
  const found = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    return search(tx);
  });
  return found.sort((a, b) => Number(a.distance) - Number(b.distance));
}

/**
 * `vector` is the query's embedding, null when the embedding provider is not allowed or not reachable:
 * the search is then by keyword only. `where` limits the rows searched (who may read them).
 */
export type SearchOptions = { vector: number[] | null; where?: SQL; limit: number; now?: Date };

/** A row as either branch found it, with both of its scores and what MMR compares. */
type Found<R> = { row: R; distance: number | null; rank: number; embedding: number[] | null; evergreen: boolean };

/**
 * The scores of one table's rows: cosine distance to the query vector (null without one, and for rows
 * without an embedding) and the keyword rank of the query's words (0 when none occur).
 */
function scoring(columns: { embedding: AnyColumn; search: AnyColumn }, query: string, vector: number[] | null) {
  const words = orTsQuery(query);
  const tsQuery = words ? sql`to_tsquery('simple', ${words})` : undefined;
  return {
    distance: vector ? cosineDistance(columns.embedding, vector) : undefined,
    // Unlabelled positions (all of them here) count 1, not the default 0.1: one matched word ranks 1.
    rank: tsQuery ? sql<number>`ts_rank_cd('{1,1,1,1}', ${columns.search}, ${tsQuery})` : sql<number>`0`,
    matches: tsQuery ? sql`${columns.search} @@ ${tsQuery}` : undefined,
  };
}

/**
 * Both branches: the nearest rows by embedding and the best rows by keyword, each `limit *
 * CANDIDATE_MULTIPLIER`, merged by id. Rows without an embedding take part through the keyword branch.
 */
async function candidates<R extends { id: string }>(
  vector: ((tx: Tx) => Promise<Found<R>[]>) | undefined,
  keyword: (() => Promise<Found<R>[]>) | undefined,
): Promise<Found<R>[]> {
  const [near, matched] = await Promise.all([vector ? nearestFirst(vector) : [], keyword ? keyword() : []]);
  // Both branches select both scores, so a row found twice is the same either way.
  return [...new Map([...near, ...matched].map((found) => [found.row.id, found])).values()];
}

async function ranked<R>(found: Found<R>[], opts: SearchOptions, describe: (row: R) => { text: string; at: Date }) {
  // The query's vector is of the provider's model, and so are the stored ones it was compared with.
  const unrelatedSimilarity = opts.vector ? EMBEDDING_PROFILES[await embeddingProvider()].unrelatedSimilarity : 0;
  const ranking = rankCandidates(
    found.map(({ row, distance, rank, embedding, evergreen }) => ({
      row,
      ...describe(row),
      similarity: distance === null ? null : 1 - Number(distance),
      textRank: Number(rank),
      embedding,
      evergreen,
    })),
    { hybrid: opts.vector !== null, limit: opts.limit, now: opts.now ?? new Date(), unrelatedSimilarity },
  );
  return ranking.map(({ row, similarity }) => ({ ...row, similarity }));
}

const memoryFields = {
  id: memories.id,
  scope: memories.scope,
  content: memories.content,
  source: memories.source,
  origin: memories.origin,
  status: memories.status,
  pinned: memories.pinned,
  projectId: memories.projectId,
  agentId: memories.agentId,
  retention: memories.retention,
  validFrom: memories.validFrom,
  invalidatedAt: memories.invalidatedAt,
  supersededBy: memories.supersededBy,
  expiresAt: memories.expiresAt,
  recallCount: memories.recallCount,
  createdAt: memories.createdAt,
  updatedAt: memories.updatedAt,
};

/**
 * Hybrid memory search: vector and keyword candidates, fused, decayed by age (pinned and permanent
 * entries are exempt) and diversified with MMR (see memory-ranking.ts). `similarity` is the cosine
 * similarity to the query, null in keyword mode and for entries without an embedding.
 */
export async function hybridSearchMemories(query: string, opts: SearchOptions) {
  const { distance, rank, matches } = scoring(memories, query, opts.vector);
  const fields = {
    row: memoryFields,
    distance: sql<number | null>`${distance ?? sql`null`}`,
    rank,
    embedding: memories.embedding,
    evergreen: sql<boolean>`${memories.pinned} or ${memories.retention} = 'permanent'`,
  };
  const limit = opts.limit * CANDIDATE_MULTIPLIER;
  const found = await candidates(
    distance &&
      ((tx) =>
        tx
          .select(fields)
          .from(memories)
          .where(and(opts.where, isNotNull(memories.embedding)))
          .orderBy(distance)
          .limit(limit)),
    matches &&
      (() =>
        db
          .select(fields)
          .from(memories)
          .where(and(opts.where, matches))
          .orderBy(desc(rank), desc(memories.updatedAt))
          .limit(limit)),
  );
  return ranked(found, opts, (row) => ({ text: row.content, at: row.updatedAt }));
}

const journalFields = {
  id: journals.id,
  agentId: journals.agentId,
  projectId: journals.projectId,
  day: journals.day,
  summary: journals.summary,
};

/** `hybridSearchMemories` for journals, which decay by their day and are never exempt. */
export async function hybridSearchJournals(query: string, opts: SearchOptions) {
  const { distance, rank, matches } = scoring(journals, query, opts.vector);
  const fields = {
    row: journalFields,
    distance: sql<number | null>`${distance ?? sql`null`}`,
    rank,
    embedding: journals.embedding,
    evergreen: sql<boolean>`false`,
  };
  const limit = opts.limit * CANDIDATE_MULTIPLIER;
  const found = await candidates(
    distance &&
      ((tx) =>
        tx
          .select(fields)
          .from(journals)
          .where(and(opts.where, isNotNull(journals.embedding)))
          .orderBy(distance)
          .limit(limit)),
    matches &&
      (() =>
        db
          .select(fields)
          .from(journals)
          .where(and(opts.where, matches))
          .orderBy(desc(rank), desc(journals.day))
          .limit(limit)),
  );
  return ranked(found, opts, (row) => ({ text: row.summary, at: new Date(row.day) }));
}
