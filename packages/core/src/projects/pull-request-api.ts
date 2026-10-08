/**
 * Following a pull (merge) request with the repo's token (tasks/pull-requests.ts): reads its state,
 * the checks of its head commit, its review feedback and the log tails of failed checks.
 */
import type { Response as UndiciResponse } from "undici";
import { safeFetch } from "../platform/safe-fetch";
import {
  type FailedCheck,
  GITHUB_FAILED,
  githubChecks,
  githubFeedback,
  githubReviewState,
  githubWorkflowRuns,
  gitlabFailedJobs,
  gitlabFeedback,
  gitlabReviewState,
  logTail,
  parseGithubPull,
  parseGitlabMerge,
  type PullRequestChecks,
  type PullRequestStatus,
} from "./pull-request-status";
import { apiMessage, call, githubRepo, gitlabProject, okBody, type RepoAccess, request, TIMEOUT_MS } from "./repo-http";

/** Failed workflow runs whose jobs are listed; the others still count, by their run. */
const MAX_FAILED_RUNS = 5;

/** Check runs, or the Actions runs and failed jobs of the commit when the token may not read them. */
async function readGithubChecks(
  repo: RepoAccess,
  sha: string,
): Promise<{ checks: PullRequestChecks; failedChecks: FailedCheck[]; checksDenied: boolean }> {
  const base = githubRepo(repo);
  const [checkRuns, combinedStatus] = await Promise.all([
    call(repo, "GET", `${base}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`),
    call(repo, "GET", `${base}/commits/${encodeURIComponent(sha)}/status?per_page=100`),
  ]);
  if (checkRuns.status !== 403) {
    return {
      ...githubChecks({ checkRuns: okBody(checkRuns), combinedStatus: okBody(combinedStatus) }),
      checksDenied: combinedStatus.status === 403 && checkRuns.status !== 200,
    };
  }
  const query = new URLSearchParams({ head_sha: sha, per_page: "100" });
  const workflowRuns = await call(repo, "GET", `${base}/actions/runs?${query}`);
  const failedRuns = (githubWorkflowRuns.safeParse(okBody(workflowRuns)).data?.workflow_runs ?? []).filter(
    (r) => r.status === "completed" && GITHUB_FAILED.has(r.conclusion ?? ""),
  );
  const jobs = new Map<number, unknown>();
  for (const run of failedRuns.slice(0, MAX_FAILED_RUNS)) {
    jobs.set(run.id, okBody(await call(repo, "GET", `${base}/actions/runs/${run.id}/jobs?per_page=100`)));
  }
  return {
    ...githubChecks({ checkRuns: null, workflowRuns: okBody(workflowRuns), jobs, combinedStatus: okBody(combinedStatus) }),
    checksDenied: workflowRuns.status === 403 && combinedStatus.status === 403,
  };
}

async function readGithubPull(
  repo: RepoAccess,
  number: number,
  opts: { since: Date; settledChecks: { headSha: string; checks: PullRequestChecks } | null },
): Promise<PullRequestStatus> {
  const base = githubRepo(repo);
  const found = await call(repo, "GET", `${base}/pulls/${number}`);
  const pull = found.status === 200 ? parseGithubPull(found.body) : null;
  if (!pull) throw new Error(`Reading pull request #${number} failed: ${apiMessage(found)}`);
  const since = new URLSearchParams({ since: opts.since.toISOString(), per_page: "100" });
  const [reviews, reviewComments, issueComments] = await Promise.all([
    call(repo, "GET", `${base}/pulls/${number}/reviews?per_page=100`),
    call(repo, "GET", `${base}/pulls/${number}/comments?${since}`),
    call(repo, "GET", `${base}/issues/${number}/comments?${since}`),
  ]);
  const status: PullRequestStatus = {
    ...pull,
    checks: "none",
    failedChecks: [],
    checksDenied: false,
    review: githubReviewState(okBody(reviews)),
    feedback: githubFeedback(
      { reviews: okBody(reviews), reviewComments: okBody(reviewComments), issueComments: okBody(issueComments) },
      opts.since,
    ),
  };
  // Checks of a closed pull request no longer matter; settled ones of a commit already read stay as they were.
  if (pull.state !== "open") return status;
  if (opts.settledChecks?.headSha === pull.headSha) return { ...status, checks: opts.settledChecks.checks };
  return { ...status, ...(await readGithubChecks(repo, pull.headSha!)) };
}

/** Pages of discussions read at most (100 each, oldest first); a longer review misses its newest notes. */
const MAX_DISCUSSION_PAGES = 5;

async function readGitlabDiscussions(repo: RepoAccess, base: string): Promise<unknown[] | null> {
  const all: unknown[] = [];
  for (let page = 1; page <= MAX_DISCUSSION_PAGES; page++) {
    const res = await call(repo, "GET", `${base}/discussions?per_page=100&page=${page}`);
    if (res.status !== 200 || !Array.isArray(res.body)) return page === 1 ? null : all;
    all.push(...(res.body as unknown[]));
    if (res.body.length < 100) break;
  }
  return all;
}

async function readGitlabMerge(
  repo: RepoAccess,
  pull: { number: number; url: string },
  since: Date,
): Promise<PullRequestStatus> {
  const project = gitlabProject(repo);
  const base = `${project}/merge_requests/${pull.number}`;
  const found = await call(repo, "GET", base);
  const merge = found.status === 200 ? parseGitlabMerge(found.body) : null;
  if (!merge) throw new Error(`Reading merge request !${pull.number} failed: ${apiMessage(found)}`);
  const [discussions, approvals] = await Promise.all([
    readGitlabDiscussions(repo, base),
    call(repo, "GET", `${base}/approvals`),
  ]);
  let failedChecks: FailedCheck[] = [];
  if (merge.state === "open" && merge.checks === "failure" && merge.pipeline) {
    const jobs = await call(repo, "GET", `${project}/pipelines/${merge.pipeline.id}/jobs?per_page=100`);
    failedChecks = gitlabFailedJobs(okBody(jobs));
    // Jobs the token may not list: the pipeline itself stands for them.
    if (!failedChecks.length) failedChecks = [{ name: "pipeline", status: "failed", url: merge.pipeline.url, job: null }];
  }
  return {
    state: merge.state,
    draft: merge.draft,
    headSha: merge.headSha,
    mergedAt: merge.mergedAt,
    checks: merge.checks,
    failedChecks,
    checksDenied: false,
    review: gitlabReviewState(merge, okBody(approvals), discussions),
    feedback: gitlabFeedback(discussions, pull.url, since),
  };
}

/**
 * Reads a pull (merge) request: its state, the checks of its head commit and the feedback created
 * after `since`. `settledChecks`: checks already read as passed for a head SHA; a GitHub pull request
 * still on that SHA keeps them without reading them again. Throws when the pull request itself cannot
 * be read; the other reads degrade (no feedback, no checks).
 */
export function readPullRequest(
  repo: RepoAccess,
  pull: { number: number; url: string },
  opts: { since: Date; settledChecks: { headSha: string; checks: PullRequestChecks } | null },
): Promise<PullRequestStatus> {
  return repo.provider === "github" ? readGithubPull(repo, pull.number, opts) : readGitlabMerge(repo, pull, opts.since);
}

/** Bytes kept from the end of the log while it streams; the tail lines come out of these. */
const LOG_TAIL_BYTES = 32 * 1024;
/** A longer log is not read to its end: its tail is left out and the agent fetches the log itself. */
const LOG_MAX_BYTES = 8 * 1024 * 1024;

/** The end of a streamed body, reading at most LOG_MAX_BYTES; null when the body is longer. */
async function readEnd(res: Response | UndiciResponse): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LOG_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
    kept += value.byteLength;
    while (chunks.length > 1 && kept - chunks[0]!.byteLength >= LOG_TAIL_BYTES) kept -= chunks.shift()!.byteLength;
  }
  // The first kept line may start mid-line or mid-character; logTail keeps only the last lines.
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * The last lines of a failed check's log, or null when it cannot be read (no job, no permission, too
 * long). GitHub answers with a redirect to a short-lived download URL: it is followed without the
 * token, and only to a public address (safeFetch).
 */
export async function readCheckLogTail(repo: RepoAccess, check: FailedCheck): Promise<string | null> {
  if (check.job === null) return null;
  try {
    if (repo.provider === "gitlab") {
      const res = await request(repo, "GET", `${gitlabProject(repo)}/jobs/${check.job}/trace`);
      if (res.status !== 200) {
        await res.body?.cancel();
        return null;
      }
      const text = await readEnd(res);
      return text === null ? null : logTail(text);
    }
    const res = await request(repo, "GET", `${githubRepo(repo)}/actions/jobs/${check.job}/logs`, {
      redirect: "manual",
    });
    const location = res.headers.get("location");
    await res.body?.cancel();
    if (res.status !== 302 || !location) return null;
    const download = await safeFetch(location, { timeoutMs: TIMEOUT_MS });
    if (download.status !== 200) {
      await download.body?.cancel();
      return null;
    }
    const text = await readEnd(download);
    return text === null ? null : logTail(text);
  } catch (error) {
    console.warn(`[repos] reading the log of ${check.name} in ${repo.host}/${repo.path} failed:`, error);
    return null;
  }
}
