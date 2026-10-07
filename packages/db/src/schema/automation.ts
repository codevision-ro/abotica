import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_shared";
import { agents } from "./agents";
import { scheduleKind } from "./enums";
import { projects } from "./projects";

export const schedules = pgTable("schedules", {
  id: id(),
  agentId: uuid()
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
  name: text().notNull(),
  kind: scheduleKind().notNull(),
  /** Cron pattern for kind=cron. */
  cron: text(),
  /** Fire time for kind=once. */
  runAt: timestamp({ withTimezone: true }),
  timezone: text().notNull().default("Europe/Bucharest"),
  prompt: text().notNull(),
  enabled: boolean().notNull().default(true),
  lastRunAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Event triggers: webhook | task.created | task.done | email.received */
export const triggers = pgTable(
  "triggers",
  {
    id: id(),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
    name: text().notNull(),
    event: text().notNull(),
    /** Public token for webhook URLs. */
    token: text().unique(),
    /** Vault-encrypted secret that webhook requests must be signed with; null accepts unsigned requests. */
    signingSecret: text(),
    /** Prompt template; `{{payload}}` is replaced with the event payload. */
    prompt: text().notNull(),
    enabled: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.event)],
);
