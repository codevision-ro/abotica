/**
 * The project's repositories inside a sandbox workspace: how git authenticates to them, which
 * hosts it may reach, and the clones and task worktrees Abotica keeps there. Git always runs inside
 * the sandbox; nothing here touches the host's files.
 */
import { type CommandResult, runCommand, shellQuote, type Workspace } from "@abotica/sandbox";
import type { RepoProvider } from "../projects/repo-url";
import { REPOS_DIR, repoPath, taskBranch, taskWorktreePath, WORK_DIR } from "./workspace-paths";

export type WorkspaceRepo = {
  name: string;
  provider: RepoProvider;
  host: string;
  cloneUrl: string;
  defaultBranch: string;
  token: string;
};

export type GitAuthor = { name: string; email: string };

/** Username sent with the token; GitHub and GitLab both take the token as the password. */
const TOKEN_USERNAME: Record<RepoProvider, string> = { github: "x-access-token", gitlab: "oauth2" };

const CLONE_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 2 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const tokenVariable = (index: number) => `ABOTICA_GIT_TOKEN_${index}`;

/**
 * Environment of every command in a workspace with repositories. Git reads its configuration from
 * GIT_CONFIG_COUNT/KEY/VALUE (git 2.31+), so no file holds a token: each repository URL, with and
 * without `.git`, gets a credential helper that answers from its token's variable. The empty
 * helper first drops any helper of the system configuration, which would otherwise answer before
 * ours or store the token. Commits are authored by the agent.
 */
export function repoGitEnv(repos: WorkspaceRepo[], author: GitAuthor): Record<string, string> {
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    // A missing or rejected credential fails at once instead of waiting for a prompt nobody answers.
    GIT_TERMINAL_PROMPT: "0",
  };
  if (!repos.length) return env;
  const config: [string, string][] = [
    ["credential.helper", ""],
    ["credential.useHttpPath", "true"],
  ];
  repos.forEach((repo, index) => {
    env[tokenVariable(index)] = repo.token;
    const helper = `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' ${TOKEN_USERNAME[repo.provider]} "$${tokenVariable(index)}"; }; f`;
    for (const url of [repo.cloneUrl, repo.cloneUrl.replace(/\.git$/, "")]) {
      config.push([`credential.${url}.helper`, helper]);
    }
  });
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** Hosts git must reach for the repositories, on top of the project's network policy. */
export const repoHosts = (repos: Pick<WorkspaceRepo, "host">[]) => [...new Set(repos.map((r) => r.host))];

export type PrepareReposOptions = {
  repos: WorkspaceRepo[];
  /** `repoGitEnv` of the run. */
  env: Record<string, string>;
  /** The run's task: it gets a worktree in each repository. */
  taskId: string | null;
  /** Of these task ids, the ones whose worktrees may go (finished or deleted tasks). */
  finishedTasks: (taskIds: string[]) => Promise<Set<string>>;
  signal: AbortSignal;
  /** Reports a step that failed; preparing never throws for one repository. */
  onError: (message: string) => void;
};

const failure = (result: CommandResult) =>
  result.timedOut ? "timed out" : result.stderr.trim().slice(-500) || `exit code ${result.exitCode}`;

/**
 * Brings the repositories up to date when a run opens the workspace: clones the missing ones,
 * fetches the others, gives the run's task its worktrees and removes the worktrees of finished
 * tasks whose work is safe on the remote. Each step that fails is reported and skipped.
 */
export async function prepareRepos(workspace: Workspace, options: PrepareReposOptions): Promise<void> {
  const { repos, signal } = options;
  if (!repos.length) return;
  const run = (command: string, timeoutMs: number) =>
    runCommand(workspace, { command, env: options.env, egress: repoHosts(repos), signal, timeoutMs });

  for (const repo of repos) {
    if (signal.aborted) return;
    const synced = await run(syncScript(repo), CLONE_TIMEOUT_MS);
    if (synced.exitCode !== 0) options.onError(`Updating ${repoPath(repo.name)} failed: ${failure(synced)}`);
  }

  if (options.taskId) {
    for (const repo of repos) {
      if (signal.aborted) return;
      const result = await run(worktreeScript(repo, options.taskId), GIT_TIMEOUT_MS);
      if (result.exitCode !== 0) {
        options.onError(`Creating the worktree ${taskWorktreePath(options.taskId, repo.name)} failed: ${failure(result)}`);
      }
    }
  }

  const listed = await run(`if [ -d ${WORK_DIR} ]; then ls -1A ${WORK_DIR}; fi`, GIT_TIMEOUT_MS);
  const taskIds = listed.stdout.split("\n").filter((id) => UUID_RE.test(id) && id !== options.taskId);
  const finished = taskIds.length ? [...(await options.finishedTasks(taskIds))] : [];
  if (!finished.length || signal.aborted) return;
  const cleaned = await run(cleanupScript(finished), GIT_TIMEOUT_MS);
  if (cleaned.exitCode !== 0) options.onError(`Removing finished worktrees failed: ${failure(cleaned)}`);
}

/**
 * Fetches a clone, or clones a missing repository. Concurrent runs may race to clone: git refuses a
 * destination that exists, so one wins.
 */
function syncScript(repo: WorkspaceRepo): string {
  const dir = shellQuote(repoPath(repo.name));
  return [
    `if [ -e ${dir}/.git ]; then exec git -C ${dir} fetch --prune --quiet origin; fi`,
    `if [ -e ${dir} ]; then echo ${shellQuote(`${repoPath(repo.name)} exists but is not a git repository`)} >&2; exit 3; fi`,
    `mkdir -p ${REPOS_DIR} && exec git clone --quiet ${shellQuote(repo.cloneUrl)} ${dir}`,
  ].join("\n");
}

/**
 * Adds the task's worktree unless it exists: on the task's branch when the clone or the remote has
 * it, otherwise on a new branch from the default one.
 */
function worktreeScript(repo: WorkspaceRepo, taskId: string): string {
  const q = {
    repo: shellQuote(repoPath(repo.name)),
    dir: shellQuote(taskWorktreePath(taskId, repo.name)),
    parent: shellQuote(`${WORK_DIR}/${taskId}`),
    branch: shellQuote(taskBranch(taskId)),
    remoteBranch: shellQuote(`origin/${taskBranch(taskId)}`),
    base: shellQuote(`origin/${repo.defaultBranch}`),
    baseCommit: shellQuote(`origin/${repo.defaultBranch}^{commit}`),
  };
  return [
    "set -eu",
    `if [ -e ${q.dir} ] || [ ! -e ${q.repo}/.git ]; then exit 0; fi`,
    `git -C ${q.repo} worktree prune`,
    `mkdir -p ${q.parent}`,
    `target="$PWD"/${q.dir}`,
    `if git -C ${q.repo} show-ref --verify --quiet refs/heads/${q.branch}; then`,
    `  git -C ${q.repo} worktree add --quiet "$target" ${q.branch}`,
    `elif git -C ${q.repo} show-ref --verify --quiet refs/remotes/${q.remoteBranch}; then`,
    `  git -C ${q.repo} worktree add --quiet --track -b ${q.branch} "$target" ${q.remoteBranch}`,
    `elif git -C ${q.repo} rev-parse --verify --quiet ${q.baseCommit} >/dev/null; then`,
    `  git -C ${q.repo} worktree add --quiet --no-track -b ${q.branch} "$target" ${q.base}`,
    "else",
    `  echo ${shellQuote(`origin/${repo.defaultBranch} does not exist: the repository has no commits on it yet`)} >&2`,
    "  exit 3",
    "fi",
  ].join("\n");
}

/**
 * Removes the worktrees of finished tasks, with their local branches, when nothing would be lost:
 * no uncommitted change and every commit on a remote branch. A worktree `work/<task>/<name>`
 * belongs to `repos/<name>`. Anything that cannot be checked stays.
 */
function cleanupScript(taskIds: string[]): string {
  return [
    `for id in ${taskIds.map(shellQuote).join(" ")}; do`,
    `  for dir in ${WORK_DIR}/"$id"/*/; do`,
    "    dir=${dir%/}; repo=" + REPOS_DIR + '/"${dir##*/}"',
    '    [ -e "$dir/.git" ] && [ -e "$repo/.git" ] || continue',
    '    changes=$(git -C "$dir" status --porcelain) && [ -z "$changes" ] || continue',
    '    unpushed=$(git -C "$dir" rev-list -n 1 HEAD --not --remotes) && [ -z "$unpushed" ] || continue',
    '    branch=$(git -C "$dir" symbolic-ref --quiet --short HEAD) || branch=',
    '    git -C "$repo" worktree remove "$PWD/$dir" || continue',
    '    if [ -n "$branch" ]; then git -C "$repo" branch -D --quiet "$branch" || true; fi',
    "  done",
    `  rmdir ${WORK_DIR}/"$id" 2>/dev/null || true`,
    "done",
  ].join("\n");
}
