import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_shared";
import { pullRequestChecks, pullRequestReview, pullRequestState, repoProvider } from "./enums";
import { projects } from "./projects";
import { tasks } from "./tasks";

/**
 * A git repository the agents of a project work on. It is cloned into `repos/<name>` of the
 * project's workspace, and git in the sandbox authenticates to it with `token`.
 */
export const projectRepos = pgTable(
  "project_repos",
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Folder under `repos/` in the workspace: lowercase letters, digits, dots, hyphens and underscores. */
    name: text().notNull(),
    provider: repoProvider().notNull(),
    /** Lowercase host, with the port when it is not 443: `github.com`, `gitlab.example.com:8443`. */
    host: text().notNull(),
    /** Path on the host without `.git`: `owner/repo`, or `group/subgroup/repo` on GitLab. */
    path: text().notNull(),
    defaultBranch: text().notNull(),
    /** Access token, encrypted with the vault key. Never sent to the browser. */
    token: text().notNull(),
    /** Last characters of the token, so the user can tell which one is set. */
    tokenHint: text().notNull(),
    /** Whether the provider protects the default branch, as of `checkedAt`; null when it could not be read. */
    defaultBranchProtected: boolean(),
    checkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // The first also serves lookups by project.
  (t) => [unique().on(t.projectId, t.name), unique().on(t.projectId, t.host, t.path)],
);

/**
 * The last nudge sent for each condition of a pull request, so the same CI failure or review is never
 * sent twice, a restart included: `checks` is the head SHA with the failed check names, `review` the
 * ids of the reviews and comments. `closed` marks the closed notice as sent, `checksDenied` that the
 * token could not read the checks (logged once).
 */
export type PullRequestNudges = { checks?: string; review?: string; closed?: boolean; checksDenied?: boolean };

/**
 * A pull (merge) request an agent opened for a task with repo_open_pr. The worker polls the open
 * ones (prs-sync) and reacts: failed CI and review feedback wake the assignee, a merge finishes the
 * task (see tasks/pull-requests.ts in core).
 */
export const taskPullRequests = pgTable(
  "task_pull_requests",
  {
    id: id(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    repoId: uuid()
      .notNull()
      .references(() => projectRepos.id, { onDelete: "cascade" }),
    provider: repoProvider().notNull(),
    /** The pull request number on GitHub, the merge request iid on GitLab. */
    number: integer().notNull(),
    url: text().notNull(),
    headBranch: text().notNull(),
    baseBranch: text().notNull(),
    /** The commit the checks are read for; null until the provider reported it. */
    headSha: text(),
    state: pullRequestState().notNull().default("open"),
    draft: boolean().notNull().default(false),
    checks: pullRequestChecks().notNull().default("none"),
    review: pullRequestReview().notNull().default("none"),
    nudgeSignature: jsonb().$type<PullRequestNudges>().notNull().default({}),
    /** Automatic wake-ups of the assignee for CI or review feedback; capped (see pull-requests.ts). */
    fixRounds: integer().notNull().default(0),
    /** Creation time of the newest review or comment already sent to the task. */
    lastCommentAt: timestamp({ withTimezone: true }),
    /** When the worker last took the row for a sync; null until the first one. */
    syncedAt: timestamp({ withTimezone: true }),
    mergedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.repoId, t.number), index().on(t.taskId), index().on(t.state, t.syncedAt)],
);
