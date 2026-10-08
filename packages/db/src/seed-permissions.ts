/**
 * Tool permissions of the seeded agents. The tool names mirror TOOL_CATALOG in @abotica/core, which
 * db cannot import; a core test (seed-permissions.test.ts) fails when the two drift apart.
 */
import type { ToolPermissions } from "./schema";

/** Every tool an agent can have, except the orchestrator's. */
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
  "run_list",
  "run_get",
  "run_cancel",
  "schedule_manage",
  "trigger_manage",
];

/** Orchestrator tools that project managers get too (catalog flag managers). */
export const MANAGER_TOOLS = ["delegate_task"];

/** Tools with the catalog flag alwaysAsk or defaultPermission "ask". */
export const ASK_TOOLS = new Set([
  "agent_create",
  "agent_update",
  "registry_assign",
  "memory_delete",
  "task_delete",
  "schedule_manage",
  "trigger_manage",
]);

const allow = (names: string[]): ToolPermissions =>
  Object.fromEntries(names.map((name) => [name, ASK_TOOLS.has(name) ? "ask" : "allow"]));

const SHELL_TOOLS = new Set(["shell_run", "shell_run_root"]);

export const AGENT_PERMISSIONS = allow(AGENT_TOOLS);
export const MANAGER_PERMISSIONS = allow([...AGENT_TOOLS, ...MANAGER_TOOLS]);
/** Research and writing work: no shell, files only to read, write and hand over. */
export const NO_SHELL_PERMISSIONS = allow(AGENT_TOOLS.filter((name) => !SHELL_TOOLS.has(name)));
export const ORCHESTRATOR_PERMISSIONS = allow([...AGENT_TOOLS, ...ORCHESTRATOR_ONLY_TOOLS]);
