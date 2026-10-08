/**
 * The state, checks and review feedback of a pull (merge) request, parsed from GitHub's and GitLab's
 * responses. Pure, so fixtures test it; pull-request-api.ts makes the calls.
 */
import { z } from "zod";

export type PullRequestState = "open" | "merged" | "closed";
export type PullRequestChecks = "none" | "pending" | "success" | "failure";
export type PullRequestReview = "none" | "approved" | "changes_requested" | "commented";

/** A failed CI check; `job` is how to read its log (a GitHub Actions job or a GitLab job), when known. */
export type FailedCheck = { name: string; status: string; url: string | null; job: number | null };

/** A review or comment left on the pull request, written by someone outside Abotica. */
export type PullRequestFeedback = {
  /** Unique within the pull request across kinds: `review:1`, `comment:2`, `note:3`. */
  id: string;
  author: string;
  body: string;
  url: string | null;
  path: string | null;
  line: number | null;
  /** A review that requests changes. */
  changesRequested: boolean;
  createdAt: Date;
};

export type PullRequestStatus = {
  state: PullRequestState;
  draft: boolean;
  headSha: string | null;
  mergedAt: Date | null;
  checks: PullRequestChecks;
  /** Only when `checks` is failure: the checks that failed on the head commit. */
  failedChecks: FailedCheck[];
  /** The token may not read the checks (GitHub 403); `checks` is then none. */
  checksDenied: boolean;
  review: PullRequestReview;
  /** Reviews and comments created after `since`, oldest first. */
  feedback: PullRequestFeedback[];
};

const date = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const after = (since: Date) => (item: PullRequestFeedback) => item.createdAt.getTime() > since.getTime();

const byDate = (a: PullRequestFeedback, b: PullRequestFeedback) => a.createdAt.getTime() - b.createdAt.getTime();

// GitHub

const githubPullStatus = z.object({
  state: z.string(),
  merged: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  draft: z.boolean().nullish(),
  head: z.object({ sha: z.string() }),
});
const githubCheckRuns = z.object({
  check_runs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullish(),
      html_url: z.string().nullish(),
      details_url: z.string().nullish(),
      app: z.object({ slug: z.string().nullish() }).nullish(),
    }),
  ),
});
export const githubWorkflowRuns = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number(),
      name: z.string().nullish(),
      status: z.string().nullish(),
      conclusion: z.string().nullish(),
    }),
  ),
});
const githubJobs = z.object({
  jobs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullish(),
      html_url: z.string().nullish(),
    }),
  ),
});
const githubCombinedStatus = z.object({
  statuses: z.array(z.object({ context: z.string(), state: z.string(), target_url: z.string().nullish() })),
});
const githubUser = z.object({ login: z.string() }).nullish();
const githubReviews = z.array(
  z.object({
    id: z.number(),
    user: githubUser,
    state: z.string(),
    body: z.string().nullish(),
    html_url: z.string().nullish(),
    submitted_at: z.string().nullish(),
  }),
);
const githubReviewComments = z.array(
  z.object({
    id: z.number(),
    user: githubUser,
    body: z.string(),
    path: z.string().nullish(),
    line: z.number().nullish(),
    original_line: z.number().nullish(),
    html_url: z.string().nullish(),
    created_at: z.string(),
  }),
);
const githubIssueComments = z.array(
  z.object({
    id: z.number(),
    user: githubUser,
    body: z.string().nullish(),
    html_url: z.string().nullish(),
    created_at: z.string(),
  }),
);

/** Conclusions that fail a pull request; neutral, skipped and cancelled do not. */
export const GITHUB_FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
/**
 * The app GitHub Actions reports its check runs as. Such a check run has the id of its job (the
 * documented job example carries its own id in `check_run_url`), which reads the job's log.
 */
const GITHUB_ACTIONS_APP = "github-actions";

/** One check of a commit, whatever reported it. */
type CheckItem = { pending: boolean; failed: FailedCheck | null };

/** Failure only once nothing is pending, so a nudge lists every failed check of the commit at once. */
function settleChecks(items: CheckItem[]): { checks: PullRequestChecks; failedChecks: FailedCheck[] } {
  if (!items.length) return { checks: "none", failedChecks: [] };
  if (items.some((i) => i.pending)) return { checks: "pending", failedChecks: [] };
  const failedChecks = items.flatMap((i) => (i.failed ? [i.failed] : []));
  return failedChecks.length ? { checks: "failure", failedChecks } : { checks: "success", failedChecks: [] };
}

function githubCheckRunItems(checkRuns: unknown): CheckItem[] {
  return (githubCheckRuns.safeParse(checkRuns).data?.check_runs ?? []).map((r) => ({
    pending: r.status !== "completed",
    failed:
      r.status === "completed" && GITHUB_FAILED.has(r.conclusion ?? "")
        ? {
            name: r.name,
            status: r.conclusion!,
            url: r.html_url ?? r.details_url ?? null,
            job: r.app?.slug === GITHUB_ACTIONS_APP ? r.id : null,
          }
        : null,
  }));
}

/**
 * The same from GitHub Actions, for a token that may not read check runs (a fine-grained token cannot
 * use the Checks API, but can read Actions): the workflow runs of the commit, and the jobs of the
 * failed ones (`jobs`, by run id).
 */
function githubActionsItems(workflowRuns: unknown, jobs: Map<number, unknown>): CheckItem[] {
  return (githubWorkflowRuns.safeParse(workflowRuns).data?.workflow_runs ?? []).flatMap((run): CheckItem[] => {
    if (run.status !== "completed") return [{ pending: true, failed: null }];
    if (!GITHUB_FAILED.has(run.conclusion ?? "")) return [{ pending: false, failed: null }];
    const failedJobs = (githubJobs.safeParse(jobs.get(run.id)).data?.jobs ?? []).filter(
      (j) => j.status === "completed" && GITHUB_FAILED.has(j.conclusion ?? ""),
    );
    if (!failedJobs.length) {
      return [
        { pending: false, failed: { name: run.name ?? `run ${run.id}`, status: run.conclusion!, url: null, job: null } },
      ];
    }
    return failedJobs.map((j) => ({
      pending: false,
      failed: {
        name: run.name ? `${run.name} / ${j.name}` : j.name,
        status: j.conclusion!,
        url: j.html_url ?? null,
        job: j.id,
      },
    }));
  });
}

/** Commit statuses (other CI services). GitHub's combined `state` is pending without any, so it is not used. */
function githubStatusItems(combinedStatus: unknown): CheckItem[] {
  return (githubCombinedStatus.safeParse(combinedStatus).data?.statuses ?? []).map((s) => ({
    pending: s.state === "pending",
    failed:
      s.state === "failure" || s.state === "error"
        ? { name: s.context, status: s.state, url: s.target_url ?? null, job: null }
        : null,
  }));
}

/**
 * The checks of a commit from its check runs, or its Actions workflow runs and jobs when check runs
 * are unreadable, and its commit statuses. Unreadable sources are null.
 */
export function githubChecks(sources: {
  checkRuns: unknown;
  workflowRuns?: unknown;
  jobs?: Map<number, unknown>;
  combinedStatus: unknown;
}): { checks: PullRequestChecks; failedChecks: FailedCheck[] } {
  const runs =
    sources.checkRuns !== null
      ? githubCheckRunItems(sources.checkRuns)
      : githubActionsItems(sources.workflowRuns ?? null, sources.jobs ?? new Map());
  return settleChecks([...runs, ...githubStatusItems(sources.combinedStatus)]);
}

export function parseGithubPull(body: unknown): Pick<PullRequestStatus, "state" | "draft" | "headSha" | "mergedAt"> | null {
  const pull = githubPullStatus.safeParse(body);
  if (!pull.success) return null;
  const { state, merged, merged_at, draft, head } = pull.data;
  return {
    state: merged || merged_at ? "merged" : state === "closed" ? "closed" : "open",
    draft: draft ?? false,
    headSha: head.sha,
    mergedAt: date(merged_at),
  };
}

/** Review states that stand until the same reviewer submits another one; comments and pending drafts do not. */
const GITHUB_DECISIONS = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/** Where the reviews stand: each reviewer's latest decision counts, a request for changes first. */
export function githubReviewState(reviews: unknown): PullRequestReview {
  const list = githubReviews.safeParse(reviews).data ?? [];
  const latest = new Map<string, string>();
  for (const review of list) {
    if (GITHUB_DECISIONS.has(review.state)) latest.set(review.user?.login ?? "", review.state);
  }
  const decisions = [...latest.values()];
  if (decisions.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (decisions.includes("APPROVED")) return "approved";
  return list.some((r) => r.state === "COMMENTED") ? "commented" : "none";
}

/**
 * The reviews requesting changes or carrying a text, inline review comments and conversation
 * comments created after `since`.
 */
export function githubFeedback(
  { reviews, reviewComments, issueComments }: { reviews: unknown; reviewComments: unknown; issueComments: unknown },
  since: Date,
): PullRequestFeedback[] {
  const items: PullRequestFeedback[] = [];
  for (const review of githubReviews.safeParse(reviews).data ?? []) {
    const changesRequested = review.state === "CHANGES_REQUESTED";
    const createdAt = date(review.submitted_at);
    if (!createdAt || !(changesRequested || (review.state === "COMMENTED" && review.body?.trim()))) continue;
    items.push({
      id: `review:${review.id}`,
      author: review.user?.login ?? "?",
      body: review.body ?? "",
      url: review.html_url ?? null,
      path: null,
      line: null,
      changesRequested,
      createdAt,
    });
  }
  for (const comment of githubReviewComments.safeParse(reviewComments).data ?? []) {
    const createdAt = date(comment.created_at);
    if (!createdAt) continue;
    items.push({
      id: `comment:${comment.id}`,
      author: comment.user?.login ?? "?",
      body: comment.body,
      url: comment.html_url ?? null,
      path: comment.path ?? null,
      line: comment.line ?? comment.original_line ?? null,
      changesRequested: false,
      createdAt,
    });
  }
  for (const comment of githubIssueComments.safeParse(issueComments).data ?? []) {
    const createdAt = date(comment.created_at);
    if (!createdAt || !comment.body?.trim()) continue;
    items.push({
      id: `issue-comment:${comment.id}`,
      author: comment.user?.login ?? "?",
      body: comment.body,
      url: comment.html_url ?? null,
      path: null,
      line: null,
      changesRequested: false,
      createdAt,
    });
  }
  return items.filter(after(since)).sort(byDate);
}

// GitLab

const gitlabUser = z.object({ username: z.string() }).nullish();
const gitlabMergeStatus = z.object({
  state: z.string(),
  merged_at: z.string().nullish(),
  draft: z.boolean().nullish(),
  sha: z.string().nullish(),
  detailed_merge_status: z.string().nullish(),
  head_pipeline: z.object({ id: z.number(), status: z.string(), web_url: z.string().nullish() }).nullish(),
});
const gitlabJobs = z.array(
  z.object({
    id: z.number(),
    name: z.string(),
    status: z.string(),
    web_url: z.string().nullish(),
    allow_failure: z.boolean().nullish(),
  }),
);
const gitlabApprovals = z.object({ approved_by: z.array(z.unknown()).nullish() });
const gitlabDiscussions = z.array(
  z.object({
    notes: z.array(
      z.object({
        id: z.number(),
        body: z.string(),
        author: gitlabUser,
        created_at: z.string(),
        system: z.boolean().nullish(),
        resolvable: z.boolean().nullish(),
        resolved: z.boolean().nullish(),
        position: z
          .object({
            new_path: z.string().nullish(),
            old_path: z.string().nullish(),
            new_line: z.number().nullish(),
            old_line: z.number().nullish(),
          })
          .nullish(),
      }),
    ),
  }),
);

/** Pipeline statuses still on their way; canceled, skipped and manual count as no checks. */
const GITLAB_PENDING = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
  "waiting_for_callback",
]);

export type GitlabMerge = Pick<PullRequestStatus, "state" | "draft" | "headSha" | "mergedAt" | "checks"> & {
  pipeline: { id: number; url: string | null } | null;
  changesRequested: boolean;
};

/** A merge request; `locked` is the moment of merging, still open. */
export function parseGitlabMerge(body: unknown): GitlabMerge | null {
  const merge = gitlabMergeStatus.safeParse(body);
  if (!merge.success) return null;
  const { state, merged_at, draft, sha, head_pipeline, detailed_merge_status } = merge.data;
  const pipeline = head_pipeline?.status;
  return {
    state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    draft: draft ?? false,
    headSha: sha ?? null,
    mergedAt: date(merged_at),
    checks: !pipeline
      ? "none"
      : pipeline === "success"
        ? "success"
        : pipeline === "failed"
          ? "failure"
          : GITLAB_PENDING.has(pipeline)
            ? "pending"
            : "none",
    pipeline: head_pipeline ? { id: head_pipeline.id, url: head_pipeline.web_url ?? null } : null,
    changesRequested: detailed_merge_status === "requested_changes",
  };
}

/** The failed jobs of a pipeline that fail it (allowed failures do not). */
export function gitlabFailedJobs(jobs: unknown): FailedCheck[] {
  return (gitlabJobs.safeParse(jobs).data ?? [])
    .filter((j) => j.status === "failed" && !j.allow_failure)
    .map((j) => ({ name: j.name, status: j.status, url: j.web_url ?? null, job: j.id }));
}

/** The notes of a merge request's discussions created after `since`: not system notes, not resolved. */
export function gitlabFeedback(discussions: unknown, mergeUrl: string, since: Date): PullRequestFeedback[] {
  const items: PullRequestFeedback[] = [];
  for (const discussion of gitlabDiscussions.safeParse(discussions).data ?? []) {
    for (const note of discussion.notes) {
      const createdAt = date(note.created_at);
      if (!createdAt || note.system || (note.resolvable && note.resolved)) continue;
      items.push({
        id: `note:${note.id}`,
        author: note.author?.username ?? "?",
        body: note.body,
        url: `${mergeUrl}#note_${note.id}`,
        path: note.position?.new_path ?? note.position?.old_path ?? null,
        line: note.position?.new_line ?? note.position?.old_line ?? null,
        changesRequested: false,
        createdAt,
      });
    }
  }
  return items.filter(after(since)).sort(byDate);
}

/** Where the reviews stand on GitLab: changes requested, approved, or only discussed. */
export function gitlabReviewState(
  merge: Pick<GitlabMerge, "changesRequested">,
  approvals: unknown,
  discussions: unknown,
): PullRequestReview {
  if (merge.changesRequested) return "changes_requested";
  if (gitlabApprovals.safeParse(approvals).data?.approved_by?.length) return "approved";
  const notes = (gitlabDiscussions.safeParse(discussions).data ?? []).flatMap((d) => d.notes);
  return notes.some((n) => !n.system) ? "commented" : "none";
}

/** Lines kept from the end of a failed job's log. */
export const LOG_TAIL_LINES = 20;
const LOG_LINE_CHARS = 400;

/**
 * The last `count` lines of a job log, without terminal colors, GitLab's section markers or lines a
 * carriage return overwrote; each line cut to a readable length.
 */
export function logTail(text: string, count = LOG_TAIL_LINES): string {
  const lines = text
    .split("\n")
    .map((line) =>
      (line.split("\r").filter(Boolean).at(-1) ?? "")
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
        .replace(/section_(?:start|end):\d+:\S*/g, "")
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
        .trimEnd(),
    )
    .filter((line) => line.trim());
  return lines
    .slice(-count)
    .map((line) => (line.length > LOG_LINE_CHARS ? `${line.slice(0, LOG_LINE_CHARS)}...` : line))
    .join("\n");
}
