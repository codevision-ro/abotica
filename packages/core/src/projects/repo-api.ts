/**
 * The GitHub and GitLab REST calls Abotica makes with a repo's token: checking a repo when it is
 * added, and opening pull (merge) requests for agents. Following them afterwards is in
 * pull-request-api.ts. Git itself runs in the sandbox.
 */
import { UserError } from "@abotica/i18n";
import { z } from "zod";
import {
  apiMessage,
  type ApiResponse,
  call,
  githubRepo,
  gitlabProject,
  parseBody,
  type RepoAccess,
  unexpectedBody,
} from "./repo-http";

export type { RepoAccess } from "./repo-http";

/** GitLab's Developer role, the lowest that can push. */
const GITLAB_DEVELOPER = 30;

export type RepoCheck = {
  defaultBranch: string;
  /** Whether the provider protects the default branch; null when the token may not read that. */
  defaultBranchProtected: boolean | null;
};

/** `headSha`: the commit at the head of the branch, as the provider saw it (null when not reported). */
export type PullRequest = { url: string; number: number; created: boolean; headSha: string | null };

const githubRepoInfo = z.object({
  default_branch: z.string().nullish(),
  permissions: z.object({ push: z.boolean().nullish() }).nullish(),
});
const githubBranch = z.object({ protected: z.boolean().nullish() });
const githubRules = z.array(z.object({ type: z.string().nullish() }));
const githubPull = z.object({
  html_url: z.string(),
  number: z.number(),
  head: z.object({ sha: z.string().nullish() }).nullish(),
});

const gitlabAccess = z.object({ access_level: z.number().nullish() }).nullish();
const gitlabProjectInfo = z.object({
  default_branch: z.string().nullish(),
  permissions: z.object({ project_access: gitlabAccess, group_access: gitlabAccess }).nullish(),
});
const gitlabMerge = z.object({ web_url: z.string(), iid: z.number(), sha: z.string().nullish() });

/** Common failures of the repository lookup, as messages for the user. */
function lookupFailure(response: ApiResponse, repo: RepoAccess): never {
  if (response.status === 401) throw new UserError("repos.errors.tokenRejected");
  if (response.status === 403 || response.status === 404) {
    throw new UserError("repos.errors.notFound", { repo: `${repo.host}/${repo.path}` });
  }
  throw new UserError("repos.errors.checkFailed", { detail: apiMessage(response) });
}

async function checkGithub(repo: RepoAccess): Promise<RepoCheck> {
  const found = await call(repo, "GET", githubRepo(repo));
  if (found.status !== 200) lookupFailure(found, repo);
  const info = parseBody(found, githubRepoInfo);
  if (!info) throw new UserError("repos.errors.checkFailed", { detail: unexpectedBody(found) });
  // These are the account's permissions; a token limited to reading shows only on the first push.
  if (info.permissions && info.permissions.push === false) throw new UserError("repos.errors.noPushAccess");
  const defaultBranch = info.default_branch || "main";
  const branch = encodeURIComponent(defaultBranch);
  const [classic, rules] = await Promise.all([
    call(repo, "GET", `${githubRepo(repo)}/branches/${branch}`),
    call(repo, "GET", `${githubRepo(repo)}/rules/branches/${branch}`),
  ]);
  // Branch protection or a ruleset that requires pull requests or restricts updates.
  const protectedByRule =
    rules.status === 200 && !!parseBody(rules, githubRules)?.some((r) => r.type === "pull_request" || r.type === "update");
  const protectedClassic = classic.status === 200 && parseBody(classic, githubBranch)?.protected === true;
  const known = classic.status === 200 || rules.status === 200;
  return { defaultBranch, defaultBranchProtected: known ? protectedClassic || protectedByRule : null };
}

async function checkGitlab(repo: RepoAccess): Promise<RepoCheck> {
  const found = await call(repo, "GET", gitlabProject(repo));
  if (found.status !== 200) lookupFailure(found, repo);
  const info = parseBody(found, gitlabProjectInfo);
  if (!info) throw new UserError("repos.errors.checkFailed", { detail: unexpectedBody(found) });
  const levels = [info.permissions?.project_access?.access_level, info.permissions?.group_access?.access_level].filter(
    (l): l is number => typeof l === "number",
  );
  // No membership is listed for administrators; the first push tells then.
  if (levels.length && Math.max(...levels) < GITLAB_DEVELOPER) throw new UserError("repos.errors.noPushAccess");
  const defaultBranch = info.default_branch || "main";
  const protection = await call(
    repo,
    "GET",
    `${gitlabProject(repo)}/protected_branches/${encodeURIComponent(defaultBranch)}`,
  );
  const defaultBranchProtected = protection.status === 200 ? true : protection.status === 404 ? false : null;
  return { defaultBranch, defaultBranchProtected };
}

/**
 * Checks that the token can reach the repository and push to it, and reads its default branch and
 * whether the provider protects it. Failures are UserErrors for the repo form.
 */
export function checkRepo(repo: RepoAccess): Promise<RepoCheck> {
  return repo.provider === "github" ? checkGithub(repo) : checkGitlab(repo);
}

async function openGithubPull(repo: RepoAccess, input: PullRequestInput): Promise<PullRequest> {
  const created = await call(repo, "POST", `${githubRepo(repo)}/pulls`, {
    title: input.title,
    head: input.branch,
    base: input.base,
    body: input.body,
    draft: input.draft,
  });
  if (created.status === 201) {
    const pull = parseBody(created, githubPull);
    if (!pull)
      throw new Error(`GitHub created the pull request but its response could not be read: ${unexpectedBody(created)}`);
    return { url: pull.html_url, number: pull.number, created: true, headSha: pull.head?.sha ?? null };
  }
  if (created.status === 422) {
    const owner = repo.path.split("/")[0]!;
    const query = new URLSearchParams({ head: `${owner}:${input.branch}`, base: input.base, state: "open" });
    const open = await call(repo, "GET", `${githubRepo(repo)}/pulls?${query}`);
    const existing = parseBody(open, z.array(githubPull))?.[0];
    if (existing) {
      return { url: existing.html_url, number: existing.number, created: false, headSha: existing.head?.sha ?? null };
    }
  }
  throw new Error(`GitHub refused the pull request: ${apiMessage(created)}`);
}

async function openGitlabMerge(repo: RepoAccess, input: PullRequestInput): Promise<PullRequest> {
  const created = await call(repo, "POST", `${gitlabProject(repo)}/merge_requests`, {
    source_branch: input.branch,
    target_branch: input.base,
    // GitLab marks drafts by the title prefix.
    title: input.draft ? `Draft: ${input.title}` : input.title,
    description: input.body,
  });
  if (created.status === 201) {
    const merge = parseBody(created, gitlabMerge);
    if (!merge)
      throw new Error(`GitLab created the merge request but its response could not be read: ${unexpectedBody(created)}`);
    return { url: merge.web_url, number: merge.iid, created: true, headSha: merge.sha ?? null };
  }
  if (created.status === 409) {
    const query = new URLSearchParams({ source_branch: input.branch, target_branch: input.base, state: "opened" });
    const open = await call(repo, "GET", `${gitlabProject(repo)}/merge_requests?${query}`);
    const existing = parseBody(open, z.array(gitlabMerge))?.[0];
    if (existing) return { url: existing.web_url, number: existing.iid, created: false, headSha: existing.sha ?? null };
  }
  throw new Error(`GitLab refused the merge request: ${apiMessage(created)}`);
}

export type PullRequestInput = { branch: string; base: string; title: string; body: string; draft: boolean };

/**
 * Opens a pull request (GitHub) or merge request (GitLab) from `branch` into `base`. When one is
 * already open for the branch, that one is returned with `created: false`.
 */
export function openPullRequest(repo: RepoAccess, input: PullRequestInput): Promise<PullRequest> {
  return repo.provider === "github" ? openGithubPull(repo, input) : openGitlabMerge(repo, input);
}
