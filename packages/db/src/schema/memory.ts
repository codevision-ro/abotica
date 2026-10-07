import { boolean, date, index, integer, pgTable, text, unique, uuid, vector } from "drizzle-orm/pg-core";
import { createdAt, EMBEDDING_DIMENSIONS, id, updatedAt } from "./_shared";
import { agents } from "./agents";
import { knowledgeKind, memoryScope, memoryStatus } from "./enums";
import { projects } from "./projects";

export const memories = pgTable(
  "memories",
  {
    id: id(),
    scope: memoryScope().notNull(),
    projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
    /** For agent memory, the agent it belongs to; for project memory, the agent that wrote it (null: the user). */
    agentId: uuid().references(() => agents.id, { onDelete: "cascade" }),
    content: text().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }),
    /** manual | agent | consolidation */
    source: text().notNull().default("manual"),
    /** Pending memories wait for human approval before agents can read them. */
    status: memoryStatus().notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.scope, t.projectId, t.agentId),
    index("memories_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
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
    consolidated: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.agentId, t.projectId, t.day).nullsNotDistinct(),
    index("journals_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
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
