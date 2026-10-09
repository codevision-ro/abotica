/**
 * Tool permissions of the seeded agents. The tool names mirror TOOL_CATALOG in @abotica/core, which
 * db cannot import; a core test (seed-permissions.test.ts) fails when the two drift apart.
 */
import type { ToolPermissions } from "./schema";

/** Every tool any agent can have, except the orchestrator's and those for some kinds only. */
export const AGENT_TOOLS = [
  "memory_search",
  "memory_save",
  "memory_update",
  "memory_delete",
  "journal_search",
  "knowledge_search",
  "knowledge_add",
  "task_list",
  "task_get",
  "task_create",
  "task_update",
  "task_delete",
  "task_comment",
  "ask",
  "answer",
  "task_wait",
  "web_fetch",
  "shell_run",
  "shell_run_root",
  "file_read",
  "file_write",
  "file_edit",
  "file_share",
  "preview_publish",
  "preview_open",
  "repo_open_pr",
];

export const ORCHESTRATOR_ONLY_TOOLS = [
  "project_list",
  "project_create",
  "project_update",
  "agent_list",
  "template_list",
  "agent_create",
  "agent_update",
  "registry_list",
  "registry_assign",
  "delegate_task",
  "task_control",
  "team_status",
  "work_in_project",
  "run_list",
  "run_get",
  "run_cancel",
  "schedule_manage",
  "trigger_manage",
];

/** Orchestrator tools that project managers get too (catalog flag managers). */
export const MANAGER_TOOLS = ["agent_list", "delegate_task", "task_control", "team_status", "run_list", "run_get"];

/** Tools only some kinds get (catalog field kinds): those who work on a task given to them report progress. */
export const KIND_TOOLS = {
  orchestrator: [],
  manager: ["report_progress", "team_add"],
  specialist: ["report_progress", "ask_colleague"],
} satisfies Record<"orchestrator" | "manager" | "specialist", string[]>;

const allow = (names: string[]): ToolPermissions => Object.fromEntries(names.map((name) => [name, "allow"]));

/** Every agent tool: engineering work, root for system packages and pull requests included. */
export const AGENT_PERMISSIONS = allow([...AGENT_TOOLS, ...KIND_TOOLS.specialist]);
export const MANAGER_PERMISSIONS = allow([...AGENT_TOOLS, ...KIND_TOOLS.manager, ...MANAGER_TOOLS]);
export const ORCHESTRATOR_PERMISSIONS = allow([...AGENT_TOOLS, ...KIND_TOOLS.orchestrator, ...ORCHESTRATOR_ONLY_TOOLS]);
