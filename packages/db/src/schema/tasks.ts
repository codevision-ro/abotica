import { sql } from "drizzle-orm";
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
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_shared";
import { agents } from "./agents";
import { commentAuthor, taskPriority, taskStatus, taskWakeupKind, taskWakeupPausedReason, taskWakeupStatus } from "./enums";
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
    /**
     * Delegated while its conversation had no free place (the parallelDelegations setting): it starts,
     * oldest first, once one frees up. Null for every task that is not waiting for one.
     */
    waitingForSlotSince: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.projectId, t.status),
    index().on(t.assigneeAgentId),
    index().on(t.delegatedByRunId),
    index().on(t.parentId),
    index()
      .on(t.waitingForSlotSince)
      .where(sql`${t.waitingForSlotSince} is not null`),
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

/**
 * What a task wakeup waits for, by kind; references only, the agent reads the current state with its
 * tools. A timer repeats every `everyMinutes` when set; the pull request kinds name `pullRequestId`
 * (a task_pull_requests row); task_status waits for task `taskId` to reach `status`.
 */
export type TaskWakeupCondition = {
  everyMinutes?: number;
  pullRequestId?: string;
  taskId?: string;
  status?: (typeof taskStatus.enumValues)[number];
};

/**
 * "Wake me when": an agent ends its run with task_wait and its task stays in progress until the
 * condition holds, then its assignee gets a new run (see tasks/wakeups.ts in core). Runaway limits
 * pause a wakeup and block its task for the user.
 */
export const taskWakeups = pgTable(
  "task_wakeups",
  {
    id: id(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** The agent that asked to be woken. */
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    createdByRunId: uuid().references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
    kind: taskWakeupKind().notNull(),
    /** The condition it waits for, one wakeup per task: asking again for the same one re-arms it (wakeupKey). */
    key: text().notNull(),
    condition: jsonb().$type<TaskWakeupCondition>().notNull().default({}),
    /** What the agent means to do once woken, in the comment that wakes it. */
    notes: text().notNull().default(""),
    /** When a timer fires next; null for the other kinds. */
    nextCheckAt: timestamp({ withTimezone: true }),
    /** Reached before the condition holds: the wakeup expires and its task is blocked for the user. */
    expiresAt: timestamp({ withTimezone: true }),
    /** 1 for a one-time wakeup; a repeating one is paused once it fired this many times. */
    maxFires: integer().notNull().default(1),
    fires: integer().notNull().default(0),
    /** The wakeups behind the run that set it, without a person in between; one seen twice is a loop. */
    chain: jsonb().$type<string[]>().notNull().default([]),
    /**
     * The facts the condition last held on (for checks: also the ones already finished when it was set),
     * so it fires again only once they change.
     */
    fingerprint: text(),
    status: taskWakeupStatus().notNull().default("active"),
    pausedReason: taskWakeupPausedReason(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.taskId, t.key), index().on(t.status, t.kind)],
);
