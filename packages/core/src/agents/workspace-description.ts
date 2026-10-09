/** The text that tells an agent about its sandbox workspace. Pure, so it is tested as plain strings. */
import type { WorkspacePaths } from "@abotica/sandbox";
import type { RepoProvider } from "../projects/repo-url";
import type { NetworkPolicy, SandboxPackages } from "../sandbox/sandbox-policy";
import type { SandboxSettings } from "../settings/settings-schema";
import { TOOL_OUTPUT_RETENTION_MS } from "./tool-output";
import { INPUTS_DIR, KNOWLEDGE_DIR, repoPath, taskBranch, taskWorktreePath, TOOL_OUTPUT_DIR } from "./workspace-paths";

type DescribedRepo = {
  name: string;
  provider: RepoProvider;
  webUrl: string;
  defaultBranch: string;
};

export type WorkspaceDescriptionInput = {
  paths: WorkspacePaths;
  /** Who shares the workspace: every conversation of a project, or this conversation only. */
  scope: "project" | "conversation";
  network: NetworkPolicy;
  packages: SandboxPackages;
  /** Skill folders available under `paths.bundles`. */
  skills: string[];
  commandTimeoutSec: number;
  /** When an idle workspace is paused, stopped and (for a conversation) deleted. */
  idle: Pick<SandboxSettings, "pauseIdleMinutes" | "stopIdleHours" | "workspaceRetentionDays">;
  /** The project's git repositories. */
  repos: DescribedRepo[];
  /** The run's task, whose changes go in its own worktrees. */
  taskId: string | null;
  /** The agent may run commands as root (shell_run_root). */
  root: boolean;
};

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

const PROVIDER_LABEL: Record<RepoProvider, string> = { github: "GitHub", gitlab: "GitLab" };

function reposText(repos: DescribedRepo[], taskId: string | null): string | null {
  if (!repos.length) return null;
  const pull = repos.every((r) => r.provider === "github") ? "pull request" : "pull (merge) request";
  const lines = [
    `- Git repositories of the project, cloned in ${repoPath("<name>")} and fetched when a run opens the workspace:`,
    ...repos.map(
      (r) => `  - ${repoPath(r.name)}: ${r.webUrl} (${PROVIDER_LABEL[r.provider]}, default branch ${r.defaultBranch})`,
    ),
    "  Git is signed in to these repositories over HTTPS: clone, fetch, pull and push work with plain git commands whatever the network setting. Abotica's proxy adds the credentials on the way out, so there is no token in your environment and none to configure. Other repositories and the providers' APIs get no credentials.",
    `  Never push to a default branch. Commit on a branch, push it with \`git push -u origin HEAD\`, then open a ${pull} with repo_open_pr and share its link.`,
  ];
  if (taskId) {
    const branch = taskBranch(taskId);
    lines.push(
      `  This task has its own worktree in each repository, on branch ${branch}: ${repos.map((r) => taskWorktreePath(taskId, r.name)).join(", ")}. Make the task's changes there, never in ${repoPath("<name>")}, which other runs share. Abotica removes a worktree once the task is done and everything in it is pushed.`,
    );
  } else {
    lines.push(
      `  Before changing files in ${repoPath("<name>")}, create a branch for the change (git switch -c <branch> origin/<default branch>).`,
    );
  }
  return lines.join("\n");
}

const REGISTRIES = "PyPI, npm, Packagist with its GitHub downloads, Debian";

function networkText(network: NetworkPolicy): string {
  const blocked =
    "Requests to any other host are refused by the proxy with HTTP 403: do not retry them, tell the user which host you need instead.";
  switch (network.mode) {
    case "off":
      return "Network: none. Commands cannot reach the internet, and you cannot install packages yourself.";
    case "packages":
      return `Network: only the package registries (${REGISTRIES}), so pip, uv, npm, pnpm, yarn, Composer and apt installs work. ${blocked}`;
    case "custom":
      return `Network: the package registries (${REGISTRIES}) and ${network.domains.join(", ") || "no other hosts"}. ${blocked}`;
    case "full":
      return "Network: any public internet host, over HTTP(S), ssh, scp and rsync (they go through the proxy). Private and internal addresses are blocked.";
  }
}

function packagesText(packages: SandboxPackages): string {
  const lines: string[] = [];
  if (packages.python.length) {
    lines.push(`Python packages installed in .venv (active by default): ${packages.python.join(", ")}.`);
  }
  if (packages.node.length) {
    lines.push(`Node packages installed (resolvable through NODE_PATH, binaries on PATH): ${packages.node.join(", ")}.`);
  }
  return lines.length ? lines.join("\n- ") : "No extra packages are preinstalled.";
}

/**
 * How the agent sees what it builds: images through file_read, its pages through the browser tools
 * (which reach the workspace's own servers on localhost, and save their files where the agent reads
 * them), and Chromium for its own scripts. The browser cannot read the workspace, so a file to upload
 * goes through a script of the agent's own.
 */
function seeingText(paths: WorkspacePaths): string[] {
  const saved = paths.mcpOutput
    ? ` Their screenshots and downloads are saved in ${paths.mcpOutput}/playwright, read-only for you (file_read shows a screenshot, file_share gives it to the user).`
    : "";
  return [
    "- file_read also shows you images (PNG, JPEG, GIF, WebP): look at a screenshot or a chart you made to check it.",
    `- The browser tools (browser_*), when you have them, open web pages and the servers you run in the workspace on localhost. To check a page you build, serve it, e.g. \`nohup python3 -m http.server 8000 --directory site > http.log 2>&1 &\`, then open http://localhost:8000 (file:// is not available).${saved} They cannot read your workspace files, so to upload one to a site, use a browser script of your own.`,
    '- Chromium for your own scripts is at $CHROMIUM_PATH: Node `chromium.launch({ executablePath: process.env.CHROMIUM_PATH })` with playwright or playwright-core, Python `p.chromium.launch(executable_path=os.environ["CHROMIUM_PATH"])`. Run the script with `abotica-proxy-run` in front (e.g. `abotica-proxy-run node shot.js`) so the browser reaches the internet; localhost works either way. Do not run `playwright install`: the browsers folder is read-only.',
  ];
}

export function workspaceDescription(input: WorkspaceDescriptionInput): string {
  const { paths, idle } = input;
  const shared =
    input.scope === "project"
      ? "They persist between commands and between runs, and every conversation of this project uses the same workspace."
      : `They persist between commands and between runs of this conversation, until the workspace goes unused for ${count(idle.workspaceRetentionDays, "day")}: then it is deleted.`;
  return [
    "You have a sandboxed workspace where you can run shell commands, install packages and create files.",
    `- Working directory: ${paths.workspace}. ${shared}`,
    `- ${paths.workspace}/${INPUTS_DIR} holds copies of the files of this conversation and of your task: what the user attached, and what other agents handed to you or produced for you. Each file is in its own folder (${INPUTS_DIR}/<id>/<name>).`,
    input.scope === "project"
      ? `- ${paths.workspace}/${KNOWLEDGE_DIR} holds the project's knowledge files, read-only and kept in sync by Abotica: copy one elsewhere to change it.`
      : null,
    input.skills.length
      ? `- Your skills are available read-only at ${paths.bundles}/<skill>: ${input.skills.join(", ")}. Run their scripts from there.`
      : null,
    `- HOME is ${paths.home}; pip, npm and other caches persist there.`,
    `- ${networkText(input.network)}`,
    `- ${packagesText(input.packages)}`,
    "- Database servers: `services start mysql` (or postgres, redis) starts one on 127.0.0.1 and prints how to connect; its data stays in .services. `services status` shows which run.",
    `- After ${count(idle.pauseIdleMinutes, "minute")} without use, the workspace's processes freeze and resume with the next command; after ${count(idle.stopIdleHours, "hour")} they stop (database servers and background processes included, files stay). Start the server you need at the beginning of a run.`,
    "- A command finishes only when its output ends. Start long-running processes (a dev server, a queue worker) in the background with their output in a file, e.g. `nohup php artisan serve > serve.log 2>&1 &`.",
    ...seeingText(paths),
    input.root
      ? "- shell_run_root runs a command as root, for system packages: `apt-get update && apt-get install -y <package>`. It reaches the package registries whatever the network setting. What it installs outside the workspace lasts until the workspace is recreated (for example after a sandbox update), so install again when a tool is missing. Use shell_run for everything else."
      : null,
    reposText(input.repos, input.taskId),
    `- A command stops after ${input.commandTimeoutSec} seconds; split long jobs into smaller steps.`,
    `- Long tool output is cut in the middle, and the full text is kept under ${paths.workspace}/${TOOL_OUTPUT_DIR} for ${count(TOOL_OUTPUT_RETENTION_MS / 86_400_000, "day")}: the cut names the file, read it with file_read line ranges or grep.`,
    "- To show the user a page, a mockup or a document, publish it with preview_publish; for an app you started, use preview_open. They return a link to give the user.",
    "- The user sees no workspace file until you share it. To give them a file, including one another agent produced, call file_share with its workspace path; they get a download link. Do not paste long file contents into your answer.",
  ]
    .filter(Boolean)
    .join("\n");
}
