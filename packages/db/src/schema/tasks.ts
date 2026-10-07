import {
  type AnyPgColumn,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_shared";
import { agents } from "./agents";
import { commentAuthor, taskPriority, taskStatus } from "./enums";
import { projects } from "./projects";
import { runs } from "./runs";

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
    parentId: uuid().references((): AnyPgColumn => tasks.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text().notNull().default(""),
    status: taskStatus().notNull().default("backlog"),
    priority: taskPriority().notNull().default("medium"),
    deadline: timestamp({ withTimezone: true }),
    assigneeAgentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    /** True when the task is for the human, not an agent. */
    assignedToUser: boolean().notNull().default(false),
    /** Ordering within a kanban column. */
    position: doublePrecision().notNull().default(0),
    output: text(),
    /** "user" or "agent:<slug>". */
    createdBy: text().notNull().default("user"),
    /** Run that delegated the task; its conversation gets the result once the task is done. */
    delegatedByRunId: uuid().references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
    /** When the result was reported back to the delegating conversation. */
    reportedAt: timestamp({ withTimezone: true }),
    /** Times the delegating agent sent the task back on its own; capped so review loops end with the user. */
    redelegations: integer().notNull().default(0),
    completedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.projectId, t.status),
    index().on(t.assigneeAgentId),
    index().on(t.delegatedByRunId),
    index().on(t.parentId),
  ],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }), index().on(t.dependsOnTaskId)],
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: id(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorKind: commentAuthor().notNull().default("user"),
    /** Set when an agent wrote it. */
    authorAgentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    body: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.taskId)],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: id(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    type: text().notNull(),
    actor: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.taskId)],
);
