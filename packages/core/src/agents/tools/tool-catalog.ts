/** Tool metadata, safe to import from client components. */
export type ToolInfo = {
  name: string;
  label: string;
  description: string;
  group: "memory" | "tasks" | "web" | "workspace" | "orchestration";
  orchestratorOnly?: boolean;
  /** With orchestratorOnly: managers (kind "manager") get it too. */
  managers?: boolean;
  /** Never runs without approval: the agent can be set to ask or deny, not allow. */
  alwaysAsk?: boolean;
  /** Permission a new agent starts with; allow when not set. */
  defaultPermission?: "ask";
  /** Offered only in runs of a project with a git repository. */
  needsRepos?: boolean;
  /** Rarely used: left out of the request until the agent loads it with tool_search. */
  deferred?: boolean;
};

export const TOOL_CATALOG: ToolInfo[] = [
  {
    name: "memory_search",
    label: "Search memory",
    description: "Semantic search across global, team and own memory",
    group: "memory",
  },
  { name: "memory_save", label: "Save to memory", description: "Write durable facts to memory", group: "memory" },
  { name: "memory_update", label: "Edit memory", description: "Correct a memory entry it can read", group: "memory" },
  {
    name: "memory_delete",
    label: "Delete memory",
    description: "Remove a wrong or outdated memory entry",
    group: "memory",
    defaultPermission: "ask",
    deferred: true,
  },
  { name: "journal_search", label: "Search journals", description: "Search the daily journals", group: "memory" },
  { name: "knowledge_search", label: "Knowledge base", description: "Search project documents", group: "memory" },
  {
    name: "knowledge_add",
    label: "Add to knowledge base",
    description: "Save a document or a web page in a project's knowledge base",
    group: "memory",
    deferred: true,
  },
  { name: "task_list", label: "List tasks", description: "See tasks in its projects", group: "tasks" },
  {
    name: "task_get",
    label: "Read tasks",
    description: "Full task: description, output, comments, subtasks, runs",
    group: "tasks",
  },
  // Work is handed on with delegate_task, so creating a task directly is rare: loaded on demand.
  {
    name: "task_create",
    label: "Create tasks",
    description: "Create tasks and subtasks",
    group: "tasks",
    deferred: true,
  },
  { name: "task_update", label: "Update tasks", description: "Change status, output, priority, deadline", group: "tasks" },
  {
    name: "task_delete",
    label: "Delete tasks",
    description: "Delete a task with its subtasks (requires approval)",
    group: "tasks",
    alwaysAsk: true,
    deferred: true,
  },
  { name: "task_comment", label: "Comment", description: "Add comments to tasks", group: "tasks" },
  {
    name: "task_wait",
    label: "Wait for events",
    description:
      "End its run and be woken at a time, when a pull request's checks finish or it merges, when subtasks are done or another task reaches a status",
    group: "tasks",
    // The largest definition, and delegated work reports back by itself: loaded on demand.
    deferred: true,
  },
  { name: "web_fetch", label: "Read web pages", description: "Fetch and read the content of a URL", group: "web" },
  {
    name: "shell_run",
    label: "Run commands",
    description: "Run shell commands in its sandboxed workspace",
    group: "workspace",
  },
  {
    name: "shell_run_root",
    label: "Run commands as root",
    description: "Install system packages as root in its sandboxed workspace",
    group: "workspace",
  },
  { name: "file_read", label: "Read files", description: "Read text files from its workspace", group: "workspace" },
  {
    name: "file_write",
    label: "Write files",
    description: "Create or overwrite files in its workspace",
    group: "workspace",
  },
  { name: "file_edit", label: "Edit files", description: "Replace text in a file in its workspace", group: "workspace" },
  {
    name: "file_share",
    label: "Share files",
    description: "Send a file from its workspace to the user as a download",
    group: "workspace",
  },
  {
    name: "preview_publish",
    label: "Publish previews",
    description: "Publish files of its workspace (mockups, documents) as a preview link",
    group: "workspace",
  },
  {
    name: "preview_open",
    label: "Open live previews",
    description: "Give a link to an app it started in its workspace",
    group: "workspace",
  },
  {
    name: "repo_open_pr",
    label: "Open pull requests",
    description: "Open a pull request (GitHub) or merge request (GitLab) for a branch it pushed",
    group: "workspace",
    needsRepos: true,
  },
  {
    name: "project_list",
    label: "List projects",
    description: "See all projects",
    group: "orchestration",
    orchestratorOnly: true,
  },
  {
    name: "project_create",
    label: "Create projects",
    description: "Create new projects",
    group: "orchestration",
    orchestratorOnly: true,
    deferred: true,
  },
  {
    name: "project_update",
    label: "Edit projects",
    description: "Change a project's details, status and agents",
    group: "orchestration",
    orchestratorOnly: true,
    deferred: true,
  },
  {
    name: "agent_list",
    label: "List agents",
    description: "See agents and their roles",
    group: "orchestration",
    orchestratorOnly: true,
  },
  {
    name: "template_list",
    label: "List templates",
    description: "See the agent templates new agents start from",
    group: "orchestration",
    orchestratorOnly: true,
    deferred: true,
  },
  {
    name: "agent_create",
    label: "Create agents",
    description: "Create new agents (requires approval)",
    group: "orchestration",
    orchestratorOnly: true,
    alwaysAsk: true,
    deferred: true,
  },
  {
    name: "agent_update",
    label: "Edit agents",
    description: "Change an agent's profession, role or model (requires approval)",
    group: "orchestration",
    orchestratorOnly: true,
    alwaysAsk: true,
    deferred: true,
  },
  {
    name: "registry_list",
    label: "List skills and MCP",
    description: "See the skills and MCP servers and where they are assigned",
    group: "orchestration",
    orchestratorOnly: true,
    deferred: true,
  },
  {
    name: "registry_assign",
    label: "Assign skills and MCP",
    description: "Give or take skills and MCP servers from agents and projects (requires approval)",
    group: "orchestration",
    orchestratorOnly: true,
    alwaysAsk: true,
    deferred: true,
  },
  {
    name: "delegate_task",
    label: "Delegate",
    description: "Create a task for an agent and start it (the super agent and project managers)",
    group: "orchestration",
    orchestratorOnly: true,
    managers: true,
  },
  {
    name: "run_list",
    label: "View runs",
    description: "Status and cost of recent runs",
    group: "orchestration",
    orchestratorOnly: true,
  },
  {
    name: "run_get",
    label: "Read runs",
    description: "A run's result, error and last steps",
    group: "orchestration",
    orchestratorOnly: true,
  },
  {
    name: "run_cancel",
    label: "Stop runs",
    description: "Stop a queued, running or waiting run",
    group: "orchestration",
    orchestratorOnly: true,
    deferred: true,
  },
  {
    name: "schedule_manage",
    label: "Schedules",
    description: "Create, list, change and delete schedules",
    group: "orchestration",
    orchestratorOnly: true,
    deferred: true,
    defaultPermission: "ask",
  },
  {
    name: "trigger_manage",
    label: "Triggers",
    description: "Create, list, change and delete event triggers and webhooks",
    group: "orchestration",
    orchestratorOnly: true,
    deferred: true,
    defaultPermission: "ask",
  },
];
