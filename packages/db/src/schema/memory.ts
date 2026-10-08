import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, EMBEDDING_DIMENSIONS, id, tsvector, updatedAt } from "./_shared";
import { agents } from "./agents";
import { knowledgeKind, memoryOrigin, memoryRecallSource, memoryRetention, memoryScope, memoryStatus } from "./enums";
import { projects } from "./projects";
import { runs } from "./runs";

export const memories = pgTable(
  "memories",
  {
    id: id(),
    scope: memoryScope().notNull(),
    /**
     * For project memory (the team's), its project; for agent memory, the project of the agent's notes
     * (null: its craft, read in every project).
     */
    projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
    /** For agent memory, the agent it belongs to; for project memory, the agent that wrote it (null: the user). */
    agentId: uuid().references(() => agents.id, { onDelete: "cascade" }),
    content: text().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }),
    /** Words of `content` for keyword search; the `simple` config has no stemming, so it suits any language. */
    search: tsvector().generatedAlwaysAs(sql`to_tsvector('simple', coalesce(content, ''))`),
    /** manual | agent | consolidation */
    source: text().notNull().default("manual"),
    /** Whose content it is, which decides whether it can be trusted (see memoryOrigin). */
    origin: memoryOrigin().notNull(),
    /** Pending memories wait for human approval before agents can read them. */
    status: memoryStatus().notNull().default("active"),
    /** Why a write was held for approval (a suspicious pattern, a conflict with the user's entry). */
    flagReason: text(),
    /** Injected in every run of its scope, and exempt from recency decay in search. */
    pinned: boolean().notNull().default(false),
    retention: memoryRetention().notNull().default("durable"),
    /** When the fact became true; null: since the entry was created. */
    validFrom: date({ mode: "string" }),
    /** Set when a newer fact replaced this one: agents no longer see it, the memory page keeps it as history. */
    invalidatedAt: timestamp({ withTimezone: true }),
    supersededBy: uuid().references((): AnyPgColumn => memories.id, { onDelete: "set null" }),
    /** Ephemeral entries end here: hidden from agents at once, deleted by the weekly cleanup. */
    expiresAt: timestamp({ withTimezone: true }),
    recallCount: integer().notNull().default(0),
    lastRecalledAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.scope, t.projectId, t.agentId),
    index("memories_pinned_idx")
      .on(t.scope, t.projectId, t.agentId)
      .where(sql`${t.pinned}`),
    index("memories_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("memories_search_idx").using("gin", t.search),
  ],
);

/** Each time a memory reached a run, to rank by use and to promote entries recalled often. */
export const memoryRecalls = pgTable(
  "memory_recalls",
  {
    id: id(),
    memoryId: uuid()
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    runId: uuid().references(() => runs.id, { onDelete: "set null" }),
    source: memoryRecallSource().notNull(),
    /** sha256 of the normalized query, to count distinct queries without storing their text again. */
    queryHash: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.memoryId)],
);

/**
 * One end-of-day summary per agent, per project and day: an agent working on two projects keeps two
 * journals, and a run reads only the one of its project (null for work outside any project).
 */
export const journals = pgTable(
  "journals",
  {
    id: id(),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
    day: date({ mode: "string" }).notNull(),
    summary: text().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }),
    /** Words of `summary` for keyword search (see memories.search). */
    search: tsvector().generatedAlwaysAs(sql`to_tsvector('simple', coalesce(summary, ''))`),
    consolidated: boolean().notNull().default(false),
    /** One of the day's runs read untrusted content, so facts drawn from it are untrusted too. */
    fromUntrusted: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.agentId, t.projectId, t.day).nullsNotDistinct(),
    index("journals_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("journals_search_idx").using("gin", t.search),
  ],
);

export const knowledgeItems = pgTable("knowledge_items", {
  id: id(),
  projectId: uuid()
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  kind: knowledgeKind().notNull(),
  title: text().notNull(),
  sourceUrl: text(),
  content: text().notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: id(),
    itemId: uuid()
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    content: text().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }),
  },
  (t) => [
    index().on(t.projectId),
    index().on(t.itemId),
    index("knowledge_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);
