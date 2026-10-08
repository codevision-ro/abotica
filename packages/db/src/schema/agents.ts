import { type AgentAvatar, DEFAULT_AGENT_AVATAR } from "../avatar";
import { boolean, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_shared";
import { reasoningEffort } from "./enums";

export type ModelRef = { provider: string; model: string };

/** allow: runs without asking; ask: waits for the user's approval; deny: the agent does not get the tool. */
export const TOOL_PERMISSIONS = ["allow", "ask", "deny"] as const;
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];

/**
 * Keys:
 * - a built-in tool name, e.g. "task_create" (missing means deny);
 * - "mcp:<server-slug>/<tool>" for one MCP tool;
 * - "mcp:<server-slug>" for every tool of a server without its own entry;
 * - "mcp:*" for every MCP server without its own entry (missing: each tool starts from its hints, see
 *   `annotationPermission` in core).
 */
export type ToolPermissions = Record<string, ToolPermission>;

/** "default" inherits (conversation -> agent -> settings; in settings the model decides); "none" turns reasoning off. */
export const REASONING_EFFORTS = reasoningEffort.enumValues;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type AgentLimits = {
  maxSteps: number;
  timeoutMs: number;
  /** Max spend per run in USD. */
  budgetUsd: number | null;
};

export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxSteps: 20, timeoutMs: 10 * 60_000, budgetUsd: 1 };

export const agents = pgTable("agents", {
  id: id(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  role: text().notNull().default(""),
  avatar: jsonb().$type<AgentAvatar>().notNull().default(DEFAULT_AGENT_AVATAR),
  systemPrompt: text().notNull().default(""),
  /** Null provider and model mean the agent follows the default models from settings. */
  provider: text(),
  model: text(),
  fallbacks: jsonb().$type<ModelRef[]>().notNull().default([]),
  /** How much the model reasons before answering; ignored by models without reasoning. */
  reasoningEffort: reasoningEffort().notNull().default("default"),
  /** Per-tool permissions, see ToolPermissions. */
  permissions: jsonb().$type<ToolPermissions>().notNull().default({}),
  limits: jsonb().$type<AgentLimits>().notNull().default(DEFAULT_AGENT_LIMITS),
  isOrchestrator: boolean().notNull().default(false),
  isTemplate: boolean().notNull().default(false),
  enabled: boolean().notNull().default(true),
  version: integer().notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type AgentSnapshot = Pick<
  typeof agents.$inferSelect,
  | "name"
  | "role"
  | "avatar"
  | "systemPrompt"
  | "provider"
  | "model"
  | "fallbacks"
  | "reasoningEffort"
  | "permissions"
  | "limits"
> & { skillIds: string[]; mcpServerIds: string[] };

export const agentVersions = pgTable(
  "agent_versions",
  {
    id: id(),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    snapshot: jsonb().$type<AgentSnapshot>().notNull(),
    note: text().notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.agentId, t.version)],
);
