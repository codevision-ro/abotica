import { describe, expect, it } from "vitest";
import {
  githubChecks,
  githubFeedback,
  githubReviewState,
  gitlabFailedJobs,
  gitlabFeedback,
  gitlabReviewState,
  logTail,
  parseGithubPull,
  parseGitlabMerge,
} from "./pull-request-status";

const since = new Date("2026-10-01T10:00:00Z");

// Fixtures in the shape the providers document.
const reviewsRequestingChanges = [
  { id: 1, user: { login: "ana" }, state: "COMMENTED", body: "", html_url: "u1", submitted_at: "2026-10-01T09:00:00Z" },
  {
    id: 2,
    user: { login: "ana" },
    state: "CHANGES_REQUESTED",
    body: "Two things to fix.",
    html_url: "https://github.com/acme/site/pull/7#pullrequestreview-2",
    submitted_at: "2026-10-01T11:00:00Z",
  },
];
const inlineComments = [
  {
    id: 21,
    user: { login: "ana" },
    body: "Handle the empty list.",
    path: "src/list.ts",
    line: 14,
    html_url: "https://github.com/acme/site/pull/7#discussion_r21",
    created_at: "2026-10-01T11:00:01Z",
  },
  {
    id: 22,
    user: { login: "ana" },
    body: "Rename this.",
    path: "src/util.ts",
    line: null,
    original_line: 3,
    html_url: "https://github.com/acme/site/pull/7#discussion_r22",
    created_at: "2026-10-01T11:00:02Z",
  },
];

describe("GitHub responses", () => {
  it("reads the state of a pull request", () => {
    expect(
      parseGithubPull({
        state: "closed",
        merged: true,
        merged_at: "2026-10-02T08:00:00Z",
        draft: false,
        head: { sha: "abc" },
      }),
    ).toEqual({ state: "merged", draft: false, headSha: "abc", mergedAt: new Date("2026-10-02T08:00:00Z") });
    expect(parseGithubPull({ state: "closed", merged: false, merged_at: null, head: { sha: "abc" } })?.state).toBe(
      "closed",
    );
    expect(parseGithubPull({ state: "open", merged: false, draft: true, head: { sha: "abc" } })).toMatchObject({
      state: "open",
      draft: true,
    });
    expect(parseGithubPull({ message: "Not Found" })).toBeNull();
  });

  const run = (over: object) => ({
    id: 1,
    name: "test",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/acme/site/runs/1",
    details_url: "https://github.com/acme/site/actions/runs/9/job/1",
    app: { slug: "github-actions" },
    ...over,
  });

  it("settles the checks from check runs and commit statuses", () => {
    const statuses = (state: string) => ({
      state,
      statuses: [{ context: "ci/deploy", state, target_url: "https://ci/9" }],
    });
    expect(
      githubChecks({ checkRuns: { total_count: 0, check_runs: [] }, combinedStatus: { state: "pending", statuses: [] } }),
    ).toEqual({ checks: "none", failedChecks: [] });
    expect(
      githubChecks({
        checkRuns: { check_runs: [run({}), run({ id: 2, status: "in_progress", conclusion: null })] },
        combinedStatus: null,
      }).checks,
    ).toBe("pending");
    // Failure waits for the pending ones, then lists every failed check.
    expect(
      githubChecks({ checkRuns: { check_runs: [run({ conclusion: "failure" })] }, combinedStatus: statuses("pending") })
        .checks,
    ).toBe("pending");
    expect(
      githubChecks({
        checkRuns: {
          check_runs: [
            run({ conclusion: "failure" }),
            run({ id: 3, name: "external", conclusion: "timed_out", app: { slug: "circleci" } }),
            run({ id: 4, name: "skipped", conclusion: "skipped" }),
            run({ id: 5, name: "cancelled", conclusion: "cancelled" }),
          ],
        },
        combinedStatus: statuses("error"),
      }),
    ).toEqual({
      checks: "failure",
      failedChecks: [
        { name: "test", status: "failure", url: "https://github.com/acme/site/runs/1", job: 1 },
        { name: "external", status: "timed_out", url: "https://github.com/acme/site/runs/1", job: null },
        { name: "ci/deploy", status: "error", url: "https://ci/9", job: null },
      ],
    });
    expect(githubChecks({ checkRuns: { check_runs: [run({})] }, combinedStatus: statuses("success") }).checks).toBe(
      "success",
    );
  });

  it("falls back to the Actions runs and jobs of the commit", () => {
    const workflowRuns = {
      total_count: 2,
      workflow_runs: [
        { id: 9, name: "CI", status: "completed", conclusion: "failure" },
        { id: 10, name: "Docs", status: "completed", conclusion: "success" },
      ],
    };
    const jobs = new Map<number, unknown>([
      [
        9,
        {
          total_count: 2,
          jobs: [
            {
              id: 91,
              name: "test",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/acme/site/actions/runs/9/job/91",
            },
            { id: 92, name: "lint", status: "completed", conclusion: "success", html_url: null },
          ],
        },
      ],
    ]);
    expect(githubChecks({ checkRuns: null, workflowRuns, jobs, combinedStatus: null })).toEqual({
      checks: "failure",
      failedChecks: [
        { name: "CI / test", status: "failure", url: "https://github.com/acme/site/actions/runs/9/job/91", job: 91 },
      ],
    });
    const running = { workflow_runs: [{ id: 11, name: "CI", status: "in_progress", conclusion: null }] };
    expect(githubChecks({ checkRuns: null, workflowRuns: running, combinedStatus: null }).checks).toBe("pending");
  });

  it("reads the review decision of each reviewer", () => {
    expect(githubReviewState([])).toBe("none");
    expect(githubReviewState([{ id: 1, user: { login: "a" }, state: "COMMENTED", body: "?" }])).toBe("commented");
    const approvedAfterChanges = [
      { id: 1, user: { login: "a" }, state: "CHANGES_REQUESTED" },
      { id: 2, user: { login: "a" }, state: "APPROVED" },
    ];
    expect(githubReviewState(approvedAfterChanges)).toBe("approved");
    expect(githubReviewState([...approvedAfterChanges, { id: 3, user: { login: "b" }, state: "CHANGES_REQUESTED" }])).toBe(
      "changes_requested",
    );
  });

  it("keeps the feedback created after the last one sent, oldest first", () => {
    const issueComments = [
      { id: 31, user: { login: "bo" }, body: "Old.", html_url: "c31", created_at: "2026-10-01T08:00:00Z" },
      {
        id: 32,
        user: { login: "bo" },
        body: "Ship it after the fix.",
        html_url: "c32",
        created_at: "2026-10-01T12:00:00Z",
      },
    ];
    const feedback = githubFeedback(
      { reviews: reviewsRequestingChanges, reviewComments: inlineComments, issueComments },
      since,
    );
    expect(feedback.map((f) => f.id)).toEqual(["review:2", "comment:21", "comment:22", "issue-comment:32"]);
    expect(feedback[1]).toMatchObject({ author: "ana", path: "src/list.ts", line: 14, changesRequested: false });
    expect(githubFeedback({ reviews: null, reviewComments: null, issueComments: null }, since)).toEqual([]);
  });
});

describe("GitLab responses", () => {
  const merge = (over: object) => ({
    iid: 7,
    state: "opened",
    merged_at: null,
    draft: false,
    sha: "def456",
    web_url: "https://gitlab.com/acme/site/-/merge_requests/7",
    detailed_merge_status: "mergeable",
    head_pipeline: { id: 55, status: "running", web_url: "https://gitlab.com/acme/site/-/pipelines/55" },
    ...over,
  });

  it("reads the state and pipeline of a merge request", () => {
    expect(parseGitlabMerge(merge({}))).toEqual({
      state: "open",
      draft: false,
      headSha: "def456",
      mergedAt: null,
      checks: "pending",
      pipeline: { id: 55, url: "https://gitlab.com/acme/site/-/pipelines/55" },
      changesRequested: false,
    });
    expect(parseGitlabMerge(merge({ head_pipeline: { id: 55, status: "failed" } }))?.checks).toBe("failure");
    expect(parseGitlabMerge(merge({ head_pipeline: { id: 55, status: "success" } }))?.checks).toBe("success");
    expect(parseGitlabMerge(merge({ head_pipeline: null }))?.checks).toBe("none");
    expect(parseGitlabMerge(merge({ state: "locked" }))?.state).toBe("open");
    expect(parseGitlabMerge(merge({ state: "merged", merged_at: "2026-10-02T08:00:00Z" }))).toMatchObject({
      state: "merged",
      mergedAt: new Date("2026-10-02T08:00:00Z"),
    });
    expect(parseGitlabMerge(merge({ state: "closed" }))?.state).toBe("closed");
  });

  it("lists the failed jobs that fail the pipeline", () => {
    expect(
      gitlabFailedJobs([
        { id: 1, name: "test", status: "failed", allow_failure: false, web_url: "https://gitlab.com/acme/site/-/jobs/1" },
        { id: 2, name: "flaky", status: "failed", allow_failure: true, web_url: null },
        { id: 3, name: "build", status: "success", allow_failure: false, web_url: null },
      ]),
    ).toEqual([{ name: "test", status: "failed", url: "https://gitlab.com/acme/site/-/jobs/1", job: 1 }]);
  });

  const discussions = [
    {
      id: "d1",
      individual_note: false,
      notes: [
        {
          id: 301,
          type: "DiffNote",
          body: "Handle the empty list.",
          author: { username: "ana" },
          created_at: "2026-10-01T11:00:00Z",
          system: false,
          resolvable: true,
          resolved: false,
          position: { new_path: "src/list.ts", new_line: 14, old_path: "src/list.ts", old_line: null },
        },
        {
          id: 302,
          type: "DiffNote",
          body: "Done earlier.",
          author: { username: "ana" },
          created_at: "2026-10-01T11:01:00Z",
          system: false,
          resolvable: true,
          resolved: true,
        },
      ],
    },
    {
      id: "d2",
      individual_note: true,
      notes: [
        {
          id: 303,
          type: null,
          body: "added 1 commit",
          author: { username: "bot" },
          created_at: "2026-10-01T11:02:00Z",
          system: true,
        },
        {
          id: 304,
          type: null,
          body: "Old remark.",
          author: { username: "bo" },
          created_at: "2026-10-01T09:00:00Z",
          system: false,
        },
      ],
    },
  ];

  it("keeps the unresolved notes created after the last one sent", () => {
    expect(gitlabFeedback(discussions, "https://gitlab.com/acme/site/-/merge_requests/7", since)).toEqual([
      {
        id: "note:301",
        author: "ana",
        body: "Handle the empty list.",
        url: "https://gitlab.com/acme/site/-/merge_requests/7#note_301",
        path: "src/list.ts",
        line: 14,
        changesRequested: false,
        createdAt: new Date("2026-10-01T11:00:00Z"),
      },
    ]);
  });

  it("reads where the reviews stand", () => {
    expect(gitlabReviewState({ changesRequested: true }, { approved_by: [{ user: {} }] }, discussions)).toBe(
      "changes_requested",
    );
    expect(gitlabReviewState({ changesRequested: false }, { approved_by: [{ user: {} }] }, [])).toBe("approved");
    expect(gitlabReviewState({ changesRequested: false }, { approved_by: [] }, discussions)).toBe("commented");
    expect(gitlabReviewState({ changesRequested: false }, null, null)).toBe("none");
  });
});

describe("logTail", () => {
  it("keeps the last 20 readable lines", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `2026-10-01T10:00:00.0000000Z line ${i + 1}`);
    const tail = logTail(lines.join("\n")).split("\n");
    expect(tail).toHaveLength(20);
    expect(tail[0]).toContain("line 11");
    expect(tail[19]).toContain("line 30");
  });

  it("drops colors, GitLab section markers and overwritten progress", () => {
    const trace =
      "section_start:1700000000:step_script\r\x1b[0K\x1b[32;1m$ npm test\x1b[0;m\nprogress 10%\rprogress 100%\r\n\n\x1b[31mFAIL\x1b[0m src/list.test.ts\n";
    expect(logTail(trace)).toBe("$ npm test\nprogress 100%\nFAIL src/list.test.ts");
  });
});
