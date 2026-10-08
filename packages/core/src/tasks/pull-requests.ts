/**
 * The pull (merge) requests agents open for their tasks (repo_open_pr), followed until they end:
 * the worker polls the open ones (prs-sync, every minute) and reacts to what changed. Failed CI and
 * review feedback come back to the task as a comment and wake its assignee, a merge finishes the
 * task, a close without merge is reported to the user. Each nudge is sent once: its signature is
 * stored with the pull request, so a restart does not send it again.
 */
import { db, projectRepos, taskComments, taskPullRequests, tasks, type PullRequestNudges } from "@abotica/db";
import { and, asc, eq, inArray, ne, sql } from "@abotica/db/orm";
import { getTranslator, isUserError, translateKey, type Translator } from "@abotica/i18n";
import { wrapUntrusted } from "../agents/untrusted";
import { newMarkerId } from "../agents/untrusted-id";
import { publish } from "../infra/events";
import { enqueueTaskEvent, notify } from "../infra/queues";
import { getSettings, settingsLocale } from "../platform/settings";
import { decrypt } from "../platform/vault";
import { readCheckLogTail, readPullRequest } from "../projects/pull-request-api";
import type { FailedCheck, PullRequestFeedback, PullRequestStatus } from "../projects/pull-request-status";
import type { PullRequest, RepoAccess } from "../projects/repo-api";
import type { RepoProvider } from "../projects/repo-url";
import { startTaskRun } from "../runs/runs";
import { MAX_REDELEGATIONS } from "./delegation";
import { activeTaskRun, addTaskComment, TaskBusyError, updateTask } from "./tasks";

type Row = typeof taskPullRequests.$inferSelect;

/**
 * Automatic wake-ups of the assignee per pull request; past them the task is blocked for the user,
 * whose own start gives them back (resetFixRounds).
 */
export const MAX_FIX_ROUNDS = MAX_REDELEGATIONS;

/**
 * Pull requests synced per tick (every 60 s), the longest unsynced first. A GitHub token allows 5,000
 * requests an hour and every open pull request of its repos shares it: a sync makes 4 calls (the pull
 * request, its reviews, review comments and conversation comments), 2 more while its checks are not
 * passed, and a few for a failed run's jobs and logs. 10 a tick stays near 3,600 an hour in the worst
 * case of one token for every pull request; with more open ones each is synced less often.
 */
export const PR_SYNC_BATCH = 10;

/** Failed checks whose logs are read for one nudge; the others are listed without a log. */
const MAX_LOGS = 3;
/** Feedback items listed in one comment, and characters kept of each. */
const MAX_FEEDBACK = 30;
const FEEDBACK_CHARS = 1_500;

/** Stores the pull request an agent opened for its task; opening it again updates the same row. */
export async function recordPullRequest(input: {
  taskId: string;
  repoId: string;
  provider: RepoProvider;
  pull: PullRequest;
  branch: string;
  base: string;
}): Promise<void> {
  const values = {
    taskId: input.taskId,
    url: input.pull.url,
    headBranch: input.branch,
    baseBranch: input.base,
    headSha: input.pull.headSha,
  };
  await db
    .insert(taskPullRequests)
    .values({ ...values, repoId: input.repoId, provider: input.provider, number: input.pull.number })
    .onConflictDoUpdate({
      target: [taskPullRequests.repoId, taskPullRequests.number],
      // Open again: an existing pull request is returned only while it is open.
      set: { ...values, state: "open" },
    });
  await publish({ type: "task.updated", taskId: input.taskId, projectId: null });
}

export type TaskPullRequest = Pick<
  Row,
  "id" | "provider" | "number" | "url" | "headBranch" | "baseBranch" | "state" | "draft" | "checks" | "review"
>;

/** The pull requests of a task, oldest first. */
export function listTaskPullRequests(taskId: string): Promise<TaskPullRequest[]> {
  return db
    .select({
      id: taskPullRequests.id,
      provider: taskPullRequests.provider,
      number: taskPullRequests.number,
      url: taskPullRequests.url,
      headBranch: taskPullRequests.headBranch,
      baseBranch: taskPullRequests.baseBranch,
      state: taskPullRequests.state,
      draft: taskPullRequests.draft,
      checks: taskPullRequests.checks,
      review: taskPullRequests.review,
    })
    .from(taskPullRequests)
    .where(eq(taskPullRequests.taskId, taskId))
    .orderBy(asc(taskPullRequests.createdAt));
}

// Reactions

/** What the reactions need of the stored pull request. */
export type PullRequestRecord = Pick<Row, "state" | "nudgeSignature" | "fixRounds">;

/** A condition the assignee has to fix: failed checks on the head commit, or new review feedback. */
export type PullRequestNudge =
  | { kind: "checks"; signature: string; headSha: string; failedChecks: FailedCheck[] }
  | { kind: "review"; signature: string; feedback: PullRequestFeedback[] };

export type PullRequestReactions = {
  /** Merged since the last sync: the task is done once no other pull request of it is open. */
  merged: boolean;
  /** Closed without merge, not reported yet. */
  closed: boolean;
  /** The token cannot read the checks, newly: logged once. */
  checksDenied: boolean;
  nudges: PullRequestNudge[];
  /** For the nudges: wake the assignee, or block the task since the fix rounds are used up. */
  action: "wake" | "block";
};

const checksSignature = (headSha: string, checks: FailedCheck[]) =>
  `${headSha}:${[...new Set(checks.map((c) => c.name))].sort().join(",")}`;

const feedbackSignature = (feedback: PullRequestFeedback[]) =>
  feedback
    .map((f) => f.id)
    .sort()
    .join(",");

/**
 * What to do about a pull request, from its stored record and what the provider reports now. Pure:
 * the caller applies it and stores the signatures only once applied, so a reaction that could not be
 * applied (its task busy) comes back at the next poll, and one applied never does.
 */
export function prReactions(before: PullRequestRecord, after: PullRequestStatus): PullRequestReactions {
  const sent = before.nudgeSignature;
  const reactions: PullRequestReactions = {
    merged: after.state === "merged" && before.state !== "merged",
    closed: after.state === "closed" && !sent.closed,
    checksDenied: after.checksDenied && !sent.checksDenied,
    nudges: [],
    action: before.fixRounds >= MAX_FIX_ROUNDS ? "block" : "wake",
  };
  if (after.state !== "open") return reactions;
  if (after.checks === "failure" && after.headSha && after.failedChecks.length) {
    const signature = checksSignature(after.headSha, after.failedChecks);
    if (signature !== sent.checks) {
      reactions.nudges.push({ kind: "checks", signature, headSha: after.headSha, failedChecks: after.failedChecks });
    }
  }
  if (after.feedback.length) {
    const signature = feedbackSignature(after.feedback);
    if (signature !== sent.review) reactions.nudges.push({ kind: "review", signature, feedback: after.feedback });
  }
  return reactions;
}

// Comments

/** `#12` on GitHub, `!12` on GitLab, as each provider writes its own. */
export const pullRequestLabel = (row: Pick<Row, "number" | "provider">) =>
  `${row.provider === "gitlab" ? "!" : "#"}${row.number}`;

const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);

/** The failed checks with their log tails, as untrusted data: names, URLs and logs come from the CI. */
export function checksBlock(checks: (FailedCheck & { log: string | null })[]): string {
  const lines = checks.flatMap((c) => [
    `- ${c.name} (${c.status})${c.url ? `: ${c.url}` : ""}`,
    ...(c.log ? c.log.split("\n").map((line) => `    ${line}`) : []),
  ]);
  return wrapUntrusted(lines.join("\n"), { source: "pull-request", id: newMarkerId() });
}

/** Each review or comment as `path:line (author): body` and its URL, as untrusted data. */
export function feedbackBlock(feedback: PullRequestFeedback[], t: Translator): string {
  const items = feedback.slice(0, MAX_FEEDBACK).map((f) => {
    const where = f.path ? `${f.path}${f.line ? `:${f.line}` : ""} ` : "";
    const what = f.changesRequested ? ` [${t("tasks.pr.comments.changesRequested")}]` : "";
    const body = clipText(f.body.trim(), FEEDBACK_CHARS);
    return [`- ${where}(${f.author})${what}${body ? `: ${body}` : ""}`, f.url ? `  ${f.url}` : null]
      .filter(Boolean)
      .join("\n");
  });
  if (feedback.length > MAX_FEEDBACK) items.push(`- ... ${feedback.length - MAX_FEEDBACK}`);
  return wrapUntrusted(items.join("\n"), { source: "pull-request", id: newMarkerId() });
}

async function nudgeComment(row: Row, repo: RepoAccess, nudge: PullRequestNudge, t: Translator): Promise<string> {
  const pr = { label: pullRequestLabel(row), url: row.url };
  if (nudge.kind === "review") {
    return t("tasks.pr.comments.review", { ...pr, items: feedbackBlock(nudge.feedback, t) });
  }
  const checks = await Promise.all(
    nudge.failedChecks.map(async (check, i) => ({
      ...check,
      log: i < MAX_LOGS ? await readCheckLogTail(repo, check) : null,
    })),
  );
  return t("tasks.pr.comments.checksFailed", { ...pr, sha: nudge.headSha.slice(0, 12), checks: checksBlock(checks) });
}

// Sync

type TaskInfo = Pick<typeof tasks.$inferSelect, "id" | "title" | "status" | "assigneeAgentId" | "projectId">;

/** Changes to the row once the reactions are applied; the nudges that were applied add their signatures. */
type Applied = { nudges: PullRequestNudges; fixRounds: number; lastCommentAt: Date | null };

/** Another pull request of the task still open: the task is not done with this one merged. */
async function otherOpenPullRequest(row: Row): Promise<boolean> {
  const [open] = await db
    .select({ id: taskPullRequests.id })
    .from(taskPullRequests)
    .where(
      and(eq(taskPullRequests.taskId, row.taskId), ne(taskPullRequests.id, row.id), eq(taskPullRequests.state, "open")),
    )
    .limit(1);
  return Boolean(open);
}

/** Records the nudges as sent; review feedback is then read from its newest item on. */
function markSent(applied: Applied, nudges: PullRequestNudge[]) {
  for (const nudge of nudges) {
    applied.nudges[nudge.kind] = nudge.signature;
    if (nudge.kind === "review") {
      const newest = Math.max(...nudge.feedback.map((f) => f.createdAt.getTime()));
      applied.lastCommentAt = new Date(Math.max(newest, applied.lastCommentAt?.getTime() ?? 0));
    }
  }
}

/**
 * Applies the nudges: comments on the task, then wakes the assignee, or blocks the task once the fix
 * rounds are used up. A task with a run going is left for the next poll; a done task is not reopened.
 */
async function applyNudges(
  row: Row,
  repo: RepoAccess,
  task: TaskInfo,
  reactions: PullRequestReactions,
  applied: Applied,
  t: Translator,
): Promise<void> {
  const { nudges } = reactions;
  if (!nudges.length) return;
  // The user finished the task: what happens on the pull request is theirs to follow.
  if (task.status === "done") return markSent(applied, nudges);
  if (reactions.action === "wake" && task.assigneeAgentId && (await activeTaskRun(task.id))) return;

  const comments = [];
  for (const nudge of nudges)
    comments.push(await addTaskComment(task.id, await nudgeComment(row, repo, nudge, t), "system"));
  const notice = (key: "capReached" | "notWoken", reason?: string) =>
    notify({
      kind: "text",
      text: t(`tasks.pr.notices.${key}`, {
        title: task.title,
        label: pullRequestLabel(row),
        url: row.url,
        rounds: MAX_FIX_ROUNDS,
        reason: reason ?? "",
      }),
      projectId: task.projectId,
    });

  if (reactions.action === "block") {
    await addTaskComment(
      task.id,
      t("tasks.pr.comments.capReached", { label: pullRequestLabel(row), rounds: MAX_FIX_ROUNDS }),
      "system",
    );
    if (task.status !== "blocked") await updateTask(task.id, { status: "blocked" }, "system");
    await notice("capReached");
    return markSent(applied, nudges);
  }
  if (!task.assigneeAgentId) {
    await notice("notWoken", t("tasks.errors.notAssigned"));
    return markSent(applied, nudges);
  }
  try {
    await startTaskRun(task.id);
  } catch (error) {
    if (error instanceof TaskBusyError || !isUserError(error)) {
      // Started meanwhile, or a failure that may pass: the comments go, and the next poll sends them again.
      await db.delete(taskComments).where(
        inArray(
          taskComments.id,
          comments.map((c) => c.id),
        ),
      );
      if (error instanceof TaskBusyError) return;
      throw error;
    }
    // Circuit open, unfinished dependencies: the comments stay for the user, who is told.
    const reason = translateKey(t, error.key, error.values);
    console.warn(`[prs] task ${task.id} not woken for pull request ${row.url}: ${reason}`);
    await notice("notWoken", reason);
    return markSent(applied, nudges);
  }
  applied.fixRounds += 1;
  markSent(applied, nudges);
}

/** Reads one pull request and applies what changed. */
async function syncPullRequest(row: Row, repo: RepoAccess, t: Translator): Promise<void> {
  const status = await readPullRequest(repo, row, {
    since: row.lastCommentAt ?? row.createdAt,
    settledChecks: row.headSha && row.checks === "success" ? { headSha: row.headSha, checks: row.checks } : null,
  });
  const reactions = prReactions(row, status);
  const [task] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      assigneeAgentId: tasks.assigneeAgentId,
      projectId: tasks.projectId,
    })
    .from(tasks)
    .where(eq(tasks.id, row.taskId));
  if (!task) return;

  const applied: Applied = {
    nudges: { ...row.nudgeSignature, checksDenied: status.checksDenied },
    fixRounds: row.fixRounds,
    lastCommentAt: row.lastCommentAt,
  };
  if (reactions.checksDenied) {
    console.warn(
      `[prs] the token of ${repo.host}/${repo.path} cannot read the checks of ${row.url}: CI is not followed, the state and reviews are`,
    );
  }
  await applyNudges(row, repo, task, reactions, applied, t);
  if (reactions.closed) {
    await addTaskComment(task.id, t("tasks.pr.comments.closed", { label: pullRequestLabel(row), url: row.url }), "system");
    await notify({
      kind: "text",
      text: t("tasks.pr.notices.closed", { title: task.title, label: pullRequestLabel(row), url: row.url }),
      projectId: task.projectId,
    });
    applied.nudges.closed = true;
  }
  // Before the row says merged, so a failure here is retried at the next poll.
  if (reactions.merged) {
    await addTaskComment(task.id, t("tasks.pr.comments.merged", { label: pullRequestLabel(row), url: row.url }), "system");
    // Done emits task.done: its triggers fire, its dependents start, its worktree goes at the next prepare.
    if (task.status !== "done" && !(await otherOpenPullRequest(row))) {
      await updateTask(task.id, { status: "done" }, "system");
    }
  }

  await db
    .update(taskPullRequests)
    .set({
      state: status.state,
      draft: status.draft,
      headSha: status.headSha ?? row.headSha,
      checks: status.checks,
      review: status.review,
      mergedAt: status.mergedAt,
      nudgeSignature: applied.nudges,
      fixRounds: applied.fixRounds,
      lastCommentAt: applied.lastCommentAt,
    })
    .where(eq(taskPullRequests.id, row.id));

  const changed =
    status.state !== row.state ||
    status.checks !== row.checks ||
    status.review !== row.review ||
    status.draft !== row.draft;
  if (changed) await publish({ type: "task.updated", taskId: task.id, projectId: task.projectId });
  // Its wakeups read the stored state: checks finished on a new head (even with the same result), a merge.
  if (changed || (status.headSha && status.headSha !== row.headSha)) {
    await enqueueTaskEvent({ taskId: task.id, event: "wakeups" });
  }
}

/**
 * One tick of prs-sync: takes the open pull requests synced longest ago (PR_SYNC_BATCH), each only
 * once across workers, and syncs them. A failure is logged and the pull request comes up again in turn.
 * Returns how many were synced.
 */
export async function syncPullRequests(limit = PR_SYNC_BATCH): Promise<number> {
  const due = db
    .select({ id: taskPullRequests.id })
    .from(taskPullRequests)
    .where(eq(taskPullRequests.state, "open"))
    .orderBy(sql`${taskPullRequests.syncedAt} asc nulls first`)
    .limit(limit)
    .for("update", { skipLocked: true });
  const rows = await db
    .update(taskPullRequests)
    .set({ syncedAt: new Date() })
    .where(inArray(taskPullRequests.id, due))
    .returning();
  if (!rows.length) return 0;
  const repos = await db
    .select()
    .from(projectRepos)
    .where(
      inArray(
        projectRepos.id,
        rows.map((r) => r.repoId),
      ),
    );
  const t = getTranslator(settingsLocale(await getSettings()));
  let synced = 0;
  for (const row of rows) {
    const repo = repos.find((r) => r.id === row.repoId);
    if (!repo) continue;
    try {
      await syncPullRequest(row, { ...repo, token: decrypt(repo.token) }, t);
      synced++;
    } catch (error) {
      console.warn(`[prs] syncing ${row.url} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return synced;
}
