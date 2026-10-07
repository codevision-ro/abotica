import { pgEnum } from "drizzle-orm/pg-core";

export const projectStatus = pgEnum("project_status", ["active", "paused", "archived"]);

export const taskStatus = pgEnum("task_status", ["backlog", "in_progress", "blocked", "review", "done"]);

export const taskPriority = pgEnum("task_priority", ["low", "medium", "high", "urgent"]);

/** Who wrote a task comment: the user, an agent (authorAgentId), or the platform (e.g. a failed run). */
export const commentAuthor = pgEnum("comment_author", ["user", "agent", "system"]);

export const memoryScope = pgEnum("memory_scope", ["global", "project", "agent"]);

export const memoryStatus = pgEnum("memory_status", ["active", "pending"]);

export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
]);

export const runTrigger = pgEnum("run_trigger", [
  "chat",
  "telegram",
  "task",
  "schedule",
  "webhook",
  "event",
  "delegation",
  "system",
]);

export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected", "expired"]);

/** internal = task and scheduled runs, which have no human chat. */
export const channel = pgEnum("channel", ["web", "telegram", "internal"]);

export const reasoningEffort = pgEnum("reasoning_effort", [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const mcpTransport = pgEnum("mcp_transport", ["http", "stdio"]);

/** How an HTTP MCP server authenticates: static headers (or nothing) or OAuth. */
export const mcpAuth = pgEnum("mcp_auth", ["headers", "oauth"]);

/** Where a stdio MCP server runs: its own sandbox workspace, or the workspace of the run using it. */
export const mcpWorkspace = pgEnum("mcp_workspace", ["server", "run"]);

export const scheduleKind = pgEnum("schedule_kind", ["cron", "once"]);

export const knowledgeKind = pgEnum("knowledge_kind", ["file", "document", "link"]);

/** Who made a stored file: the user uploaded it, or an agent produced it. */
export const fileSource = pgEnum("file_source", ["user", "agent"]);

/** Where a project's git repository is hosted; decides the API used to check it and open pull requests. */
export const repoProvider = pgEnum("repo_provider", ["github", "gitlab"]);

/** A preview serves a copy of workspace files (static) or a port of the workspace's container (live). */
export const previewKind = pgEnum("preview_kind", ["static", "live"]);
