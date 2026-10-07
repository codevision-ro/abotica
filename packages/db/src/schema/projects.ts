import { bigint, index, jsonb, numeric, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_shared";
import { agents } from "./agents";
import { projectStatus } from "./enums";

/**
 * What a sandboxed process may reach on the network. `packages` allows the package registries,
 * `custom` the registries plus `domains`, `full` any public host. Private, loopback, link-local and
 * cloud metadata addresses are refused in every mode.
 */
export type NetworkMode = "off" | "packages" | "custom" | "full";
export type NetworkPolicy = { mode: NetworkMode; domains: string[] };

/** Packages installed into a workspace before the agent's first command (pip and npm specifiers). */
export type SandboxPackages = { python: string[]; node: string[] };

/** Network and packages of a sandbox workspace. */
export type SandboxPolicy = { network: NetworkPolicy; packages: SandboxPackages };

export const projects = pgTable("projects", {
  id: id(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  description: text().notNull().default(""),
  goals: text().notNull().default(""),
  status: projectStatus().notNull().default("active"),
  /** Monthly budget in USD. Null means unlimited. */
  budgetUsd: numeric({ precision: 12, scale: 4, mode: "number" }),
  /** Provider ids allowed in this project. Empty means all providers. */
  allowedProviders: text().array().notNull().default([]),
  /** Telegram forum topic used for this project's notifications. */
  telegramTopicId: bigint({ mode: "number" }),
  /** Sandbox policy of the project's workspace; null follows the default in Settings > Sandbox. */
  sandbox: jsonb().$type<SandboxPolicy>(),
  /**
   * The agent that leads the project: it answers in the project's conversations and Telegram topic
   * and splits work among the team. Always a member of the project; null until one is set.
   */
  managerAgentId: uuid().references(() => agents.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projectAgents = pgTable(
  "project_agents",
  {
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.agentId] }), index().on(t.agentId)],
);
