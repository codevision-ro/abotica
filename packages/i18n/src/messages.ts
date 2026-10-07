// One JSON file per namespace and locale, so areas can be translated independently.
// Adding a namespace: create messages/en/<ns>.json and messages/ro/<ns>.json, then list it here.
import en_common from "../messages/en/common.json";
import en_nav from "../messages/en/nav.json";
import en_shell from "../messages/en/shell.json";
import en_chat from "../messages/en/chat.json";
import en_auth from "../messages/en/auth.json";
import en_dashboard from "../messages/en/dashboard.json";
import en_agents from "../messages/en/agents.json";
import en_tools from "../messages/en/tools.json";
import en_settings from "../messages/en/settings.json";
import en_skills from "../messages/en/skills.json";
import en_mcp from "../messages/en/mcp.json";
import en_projects from "../messages/en/projects.json";
import en_tasks from "../messages/en/tasks.json";
import en_automations from "../messages/en/automations.json";
import en_memory from "../messages/en/memory.json";
import en_journals from "../messages/en/journals.json";
import en_runs from "../messages/en/runs.json";
import en_approvals from "../messages/en/approvals.json";
import en_costs from "../messages/en/costs.json";
import en_errors from "../messages/en/errors.json";
import en_telegram from "../messages/en/telegram.json";
import en_notifications from "../messages/en/notifications.json";
import en_sandbox from "../messages/en/sandbox.json";
import en_files from "../messages/en/files.json";
import en_team from "../messages/en/team.json";
import en_repos from "../messages/en/repos.json";
import en_previews from "../messages/en/previews.json";
import ro_common from "../messages/ro/common.json";
import ro_nav from "../messages/ro/nav.json";
import ro_shell from "../messages/ro/shell.json";
import ro_chat from "../messages/ro/chat.json";
import ro_auth from "../messages/ro/auth.json";
import ro_dashboard from "../messages/ro/dashboard.json";
import ro_agents from "../messages/ro/agents.json";
import ro_tools from "../messages/ro/tools.json";
import ro_settings from "../messages/ro/settings.json";
import ro_skills from "../messages/ro/skills.json";
import ro_mcp from "../messages/ro/mcp.json";
import ro_projects from "../messages/ro/projects.json";
import ro_tasks from "../messages/ro/tasks.json";
import ro_automations from "../messages/ro/automations.json";
import ro_memory from "../messages/ro/memory.json";
import ro_journals from "../messages/ro/journals.json";
import ro_runs from "../messages/ro/runs.json";
import ro_approvals from "../messages/ro/approvals.json";
import ro_costs from "../messages/ro/costs.json";
import ro_errors from "../messages/ro/errors.json";
import ro_telegram from "../messages/ro/telegram.json";
import ro_notifications from "../messages/ro/notifications.json";
import ro_sandbox from "../messages/ro/sandbox.json";
import ro_files from "../messages/ro/files.json";
import ro_team from "../messages/ro/team.json";
import ro_repos from "../messages/ro/repos.json";
import ro_previews from "../messages/ro/previews.json";

export const en = {
  common: en_common,
  nav: en_nav,
  shell: en_shell,
  chat: en_chat,
  auth: en_auth,
  dashboard: en_dashboard,
  agents: en_agents,
  tools: en_tools,
  settings: en_settings,
  skills: en_skills,
  mcp: en_mcp,
  projects: en_projects,
  tasks: en_tasks,
  automations: en_automations,
  memory: en_memory,
  journals: en_journals,
  runs: en_runs,
  approvals: en_approvals,
  costs: en_costs,
  errors: en_errors,
  telegram: en_telegram,
  notifications: en_notifications,
  sandbox: en_sandbox,
  files: en_files,
  team: en_team,
  repos: en_repos,
  previews: en_previews,
};

export type Messages = typeof en;

/** Typed against English: a key missing from Romanian fails typecheck. */
export const ro: Messages = {
  common: ro_common,
  nav: ro_nav,
  shell: ro_shell,
  chat: ro_chat,
  auth: ro_auth,
  dashboard: ro_dashboard,
  agents: ro_agents,
  tools: ro_tools,
  settings: ro_settings,
  skills: ro_skills,
  mcp: ro_mcp,
  projects: ro_projects,
  tasks: ro_tasks,
  automations: ro_automations,
  memory: ro_memory,
  journals: ro_journals,
  runs: ro_runs,
  approvals: ro_approvals,
  costs: ro_costs,
  errors: ro_errors,
  telegram: ro_telegram,
  notifications: ro_notifications,
  sandbox: ro_sandbox,
  files: ro_files,
  team: ro_team,
  repos: ro_repos,
  previews: ro_previews,
};
