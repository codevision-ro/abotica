import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id } from "./_shared";
import { agents } from "./agents";
import { conversations } from "./conversations";
import { fileSource } from "./enums";
import { knowledgeItems } from "./memory";
import { runs } from "./runs";
import { tasks } from "./tasks";

/**
 * A stored file. The bytes live in the uploads folder under `files/<id>`; this row says what the file
 * is and who owns it. A file has at most one owner (a conversation, a task or a knowledge item) and
 * goes with it. A file without an owner is an upload no message, task or knowledge item has claimed
 * yet; the maintenance sweep removes those after a day.
 */
export const files = pgTable(
  "files",
  {
    id: id(),
    name: text().notNull(),
    mimeType: text().notNull(),
    size: integer().notNull(),
    source: fileSource().notNull(),
    conversationId: uuid().references(() => conversations.id, { onDelete: "cascade" }),
    taskId: uuid().references(() => tasks.id, { onDelete: "cascade" }),
    knowledgeItemId: uuid().references(() => knowledgeItems.id, { onDelete: "cascade" }),
    /** The run that produced or handed over the file; null for the user's uploads. */
    runId: uuid().references(() => runs.id, { onDelete: "set null" }),
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.conversationId),
    index().on(t.taskId),
    index().on(t.knowledgeItemId),
    index().on(t.runId),
    index().on(t.agentId),
    check("files_one_owner", sql`num_nonnulls(${t.conversationId}, ${t.taskId}, ${t.knowledgeItemId}) <= 1`),
  ],
);
