import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_shared";
import { agents, type ModelRef } from "./agents";
import { channel, reasoningEffort } from "./enums";
import { projects } from "./projects";
import { skills } from "./registry";

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channel: channel().notNull(),
    /** The project the conversation works in: its workspace, memory and knowledge. Null for a global one. */
    projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
    /** Telegram chat id (plus topic) for telegram conversations. */
    externalId: text(),
    title: text().notNull().default("New conversation"),
    /** Model chosen in the chat for this conversation only; null means the agent's models. */
    modelOverride: jsonb().$type<ModelRef>(),
    /** Reasoning effort chosen in the chat for this conversation only; null means the agent's effort. */
    reasoningEffort: reasoningEffort(),
    /** Set for a skill test: the agent gets this skill even when it is not assigned or is disabled. */
    testSkillId: uuid().references(() => skills.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.agentId, t.updatedAt), index().on(t.projectId, t.updatedAt), index().on(t.channel, t.externalId)],
);

/** Messages in AI SDK UIMessage shape, so the web chat can restore them as-is. */
export const messages = pgTable(
  "messages",
  {
    id: text().primaryKey(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text().$type<"system" | "user" | "assistant">().notNull(),
    parts: jsonb().$type<unknown[]>().notNull(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.conversationId, t.createdAt)],
);
