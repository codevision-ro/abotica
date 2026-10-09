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
import { schedules, triggers } from "./automation";
import {
  commentAuthor,
  questionStatus,
  taskKind,
  taskMessageKind,
  taskPriority,
  taskStatus,
  taskWakeupKind,
  taskWakeupPausedReason,
  taskWakeupStatus,
} from "./enums";
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
    /**
     * Work a schedule or trigger fired for a manager or a specialist: no run delegated it, so its result
     * goes up the hierarchy on its own, to the project's manager or the super agent (core
     * tasks/automation-rules.ts). Kept when the schedule or trigger is deleted, unlike the links below.
     */
    reportsUp: boolean().notNull().default(false),
    /** The schedule that fired the task, if any. */
    scheduleId: uuid().references(() => schedules.id, { onDelete: "set null" }),
    /** The trigger that fired the task, if any. */
    triggerId: uuid().references(() => triggers.id, { onDelete: "set null" }),
    /** Times the delegating agent sent the task back on its own; capped so review loops end with the user. */
    redelegations: integer().notNull().default(0),
    /**
     * Delegated while its conversation had no free place (the parallelDelegations setting): it starts,
     * oldest first, once one frees up. Null for every task that is not waiting for one.
     */
    waitingForSlotSince: timestamp({ withTimezone: true }),
    /** Work, or a colleague's help (ask_colleague): a help task's answer goes straight back to the asker. */
    kind: taskKind().notNull().default("work"),
    /**
     * Tasks delegated from one conversation with the same key are reported together, once none of them is
     * still open; null reports the task as soon as it settles.
     */
    reportGroup: text(),
    /** Put aside for this (urgent) task: it resumes on its own once that one settles. */
    pausedForTaskId: uuid().references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    pauseReason: text(),
    /** Runs that went on by themselves after stopping at the step or time limit; reset on settle and by people. */
    continuations: integer().notNull().default(0),
    /** Wakes agents started on the task (instructions, redirects) since the user last stepped in; capped. */
    agentRounds: integer().notNull().default(0),
    /** Last sign of life (a comment, a change, a run starting or ending): quiet tasks are followed up from it. */
    activityAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastProgressAt: timestamp({ withTimezone: true }),
    /** Follow-ups sent about the task while it stayed quiet; any activity resets them. */
    followUps: integer().notNull().default(0),
    followedUpAt: timestamp({ withTimezone: true }),
    /** The deadline reminder, miss and escalation, each sent once; a new deadline clears them. */
    deadlineRemindedAt: timestamp({ withTimezone: true }),
    deadlineMissedAt: timestamp({ withTimezone: true }),
    deadlineEscalatedAt: timestamp({ withTimezone: true }),
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
      .on(t.scheduleId)
      .where(sql`${t.scheduleId} is not null`),
    index()
      .on(t.waitingForSlotSince)
      .where(sql`${t.waitingForSlotSince} is not null`),
    index()
      .on(t.deadline)
      .where(sql`${t.deadline} is not null and ${t.completedAt} is null`),
    index()
      .on(t.pausedForTaskId)
      .where(sql`${t.pausedForTaskId} is not null`),
    index().on(t.status, t.activityAt),
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

/**
 * The choices a question offers. `system` marks a question the platform asked (a task that needs more
 * time, or a loop) rather than an agent.
 */
export type QuestionOptions = {
  options: string[];
  recommendation?: string;
  system?: "needs-more-time" | "loop";
};

/**
 * A task's message stream: notes, instructions, questions with their answers, progress and notices
 * (`kind`). A question is addressed to an agent or to the user, and is escalated up the chain of
 * command while it stays open.
 */
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
    kind: taskMessageKind().notNull().default("note"),
    /** The run that wrote it, when an agent did. */
    authorRunId: uuid().references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
    /** Who a question is for now: an agent, or the user (addressedToUser). */
    addresseeAgentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    addressedToUser: boolean().notNull().default(false),
    /** The question an answer answers. */
    replyToId: uuid().references((): AnyPgColumn => taskComments.id, { onDelete: "set null" }),
    /** Set on questions only. */
    questionStatus: questionStatus(),
    options: jsonb().$type<QuestionOptions>(),
    /** Levels a question went up the chain of command. */
    escalationLevel: integer().notNull().default(0),
    /** When an open question goes one level up; null once it reached the user. */
    escalateAt: timestamp({ withTimezone: true }),
    /** When the user was last reminded of it. */
    remindedAt: timestamp({ withTimezone: true }),
    /** The message (messages.id) that carried it into a conversation, so a brief does not repeat it. */
    deliveredMessageId: text(),
    /** The run it was delivered into, when it reached one. */
    deliveredRunId: uuid().references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.taskId),
    index()
      .on(t.escalateAt)
      .where(sql`${t.questionStatus} = 'open'`),
    index()
      .on(t.addressedToUser)
      .where(sql`${t.questionStatus} = 'open'`),
  ],
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
