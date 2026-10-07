import {
  type AnyPgColumn,
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, id } from "./_shared";
import { agents } from "./agents";
import { conversations } from "./conversations";
import { approvalStatus, runFailureKind, runStatus, runTrigger } from "./enums";
import { projects } from "./projects";
import { tasks } from "./tasks";

export const runs = pgTable(
  "runs",
  {
    id: id(),
    /** Null once the agent is deleted: the run (and its cost) stays in the history and the budgets. */
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    projectId: uuid().references(() => projects.id, { onDelete: "set null" }),
    taskId: uuid().references(() => tasks.id, { onDelete: "set null" }),
    conversationId: uuid().references(() => conversations.id, { onDelete: "set null" }),
    parentRunId: uuid().references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
    trigger: runTrigger().notNull(),
    status: runStatus().notNull().default("queued"),
    input: text().notNull().default(""),
    output: text(),
    error: text(),
    /** Set on every run that ended failed or cancelled; `error` keeps the text for the user. */
    failureKind: runFailureKind(),
    provider: text(),
    model: text(),
    steps: integer().notNull().default(0),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    costUsd: numeric({ precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // One active run per conversation: messages sent meanwhile wait for a follow-up run.
    uniqueIndex("runs_one_active_per_conversation")
      .on(t.conversationId)
      .where(sql`${t.status} in ('queued', 'running')`),
    // One active run per task: parallel delegations or starts of the same task cannot both run it.
    uniqueIndex("runs_one_active_per_task")
      .on(t.taskId)
      .where(sql`${t.status} in ('queued', 'running')`),
    index().on(t.agentId, t.createdAt),
    index().on(t.status),
    index().on(t.projectId, t.createdAt),
    index().on(t.createdAt),
    index().on(t.taskId),
    index().on(t.conversationId),
    index().on(t.parentRunId),
  ],
);

/** Raw history: every step, tool call and result of a run. Never read by agents. */
export const runEvents = pgTable(
  "run_events",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    runId: uuid()
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    type: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.runId, t.id)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    runId: uuid()
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** AI SDK approval id, needed to resume the run. */
    approvalId: text().notNull(),
    toolName: text().notNull(),
    toolCallId: text().notNull(),
    input: jsonb().$type<unknown>(),
    status: approvalStatus().notNull().default("pending"),
    reason: text(),
    telegramMessageId: integer(),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.status), index().on(t.runId), index().on(t.approvalId)],
);
