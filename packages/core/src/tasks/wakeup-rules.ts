/**
 * The rules of task wakeups (task_wait), pure: when a condition holds, when a wakeup fires, pauses or
 * expires, and how it reads. No database: wakeups.ts applies the decisions, and client components
 * describe a wakeup with the same messages as the comments.
 */
import type { TaskWakeupCondition, taskPullRequests, tasks, taskWakeups } from "@abotica/db";

export type Wakeup = typeof taskWakeups.$inferSelect;
export type WakeupKind = Wakeup["kind"];
export type WakeupPausedReason = NonNullable<Wakeup["pausedReason"]>;
type TaskStatus = (typeof tasks.$inferSelect)["status"];

export const WAKEUP_KINDS: readonly WakeupKind[] = [
  "timer",
  "pr_checks_finished",
  "pr_merged",
  "subtasks_done",
  "task_status",
];

/**
 * The most fires a repeating wakeup may have. It is the default too, which in practice means no limit:
 * a check every 30 minutes would run for years. A repeating wait lasts as long as the work it watches
 * (a crawl, a monitor, a long CI); the agent may ask for fewer, and the hourly rate below still holds.
 */
export const MAX_FIRES_LIMIT = 100_000;
/** Fires a repeating wakeup makes unless the agent asks for fewer: effectively unlimited. */
export const DEFAULT_MAX_FIRES = MAX_FIRES_LIMIT;
/** Wake runs of one task in an hour; past them its wakeups pause. One a minute, which no real wait needs. */
export const MAX_WAKES_PER_HOUR = 60;
/** The window MAX_WAKES_PER_HOUR counts in. */
export const WAKE_RATE_WINDOW_MS = 3_600_000;
/**
 * Times a wakeup may appear in the chain behind it before it pauses as a loop. An agent that checks
 * something run after run (setting the same wait again each time) is often doing legitimate work, so
 * this only stops a chain that keeps going without a person for many runs.
 */
export const MAX_CHAIN_PASSES = 10;
/** A delayed job may run a moment before its time by the clocks: a timer this close is due. */
const DUE_SLACK_MS = 1_000;

/** What the decisions read of a wakeup. */
export type WakeupRule = Pick<
  Wakeup,
  "id" | "kind" | "condition" | "nextCheckAt" | "expiresAt" | "maxFires" | "fires" | "chain" | "fingerprint"
>;

/** What the conditions read, as stored now: the task's pull requests (as prs-sync last read them), its subtasks, watched tasks. */
export type WakeupFacts = {
  pullRequests: ReadonlyMap<string, Pick<typeof taskPullRequests.$inferSelect, "state" | "checks" | "headSha">>;
  subtasks: readonly { id: string; status: TaskStatus }[];
  taskStatuses: ReadonlyMap<string, TaskStatus>;
};

/**
 * The condition a wakeup waits for, one per task: asking again for the same one re-arms it instead of
 * adding a second, so a wakeup an agent keeps setting again shows up in its own chain (the loop guard).
 * A task has one timer: a new time replaces the old one.
 */
export function wakeupKey(kind: WakeupKind, condition: TaskWakeupCondition): string {
  switch (kind) {
    case "timer":
    case "subtasks_done":
      return kind;
    case "pr_checks_finished":
    case "pr_merged":
      return `${kind}:${condition.pullRequestId}`;
    case "task_status":
      return `${kind}:${condition.taskId}:${condition.status}`;
  }
}

/** Whether a wakeup repeats: it stays active after firing, until its fires are used up. */
export const repeats = (rule: Pick<Wakeup, "maxFires">) => rule.maxFires > 1;

/**
 * The facts the wakeup's condition holds on, or null while it does not hold. A repeating wakeup fires
 * again only once they change: a new head commit's checks, another set of subtasks, the timer's next time.
 */
export function conditionFingerprint(
  rule: Pick<WakeupRule, "kind" | "condition" | "nextCheckAt">,
  facts: WakeupFacts,
  now: Date,
): string | null {
  const { condition } = rule;
  switch (rule.kind) {
    case "timer":
      return rule.nextCheckAt && rule.nextCheckAt.getTime() <= now.getTime() + DUE_SLACK_MS
        ? `at:${rule.nextCheckAt.toISOString()}`
        : null;
    case "pr_checks_finished": {
      const pr = condition.pullRequestId ? facts.pullRequests.get(condition.pullRequestId) : undefined;
      const finished = pr?.headSha && (pr.checks === "success" || pr.checks === "failure");
      return finished ? `${pr.headSha}:${pr.checks}` : null;
    }
    case "pr_merged": {
      const pr = condition.pullRequestId ? facts.pullRequests.get(condition.pullRequestId) : undefined;
      return pr?.state === "merged" ? "merged" : null;
    }
    case "subtasks_done": {
      const { subtasks } = facts;
      if (!subtasks.length || subtasks.some((s) => s.status !== "done")) return null;
      return subtasks
        .map((s) => s.id)
        .sort()
        .join(",");
    }
    case "task_status": {
      const status = condition.taskId ? facts.taskStatuses.get(condition.taskId) : undefined;
      return status && status === condition.status ? status : null;
    }
  }
}

/**
 * The fingerprint a wakeup starts with. Checks already finished when the agent asks are not what it
 * waits for (it pushed again, or read them already); any other condition already true fires at the first check.
 */
export const armedFingerprint = (
  rule: Pick<WakeupRule, "kind" | "condition" | "nextCheckAt">,
  facts: WakeupFacts,
  now: Date,
): string | null => (rule.kind === "pr_checks_finished" ? conditionFingerprint(rule, facts, now) : null);

/**
 * The runaway limit a wakeup about to fire has reached, or null: its fires are used up, it passed
 * through the chain behind it MAX_CHAIN_PASSES times already without a person in between, or its task
 * was woken MAX_WAKES_PER_HOUR times in the last hour.
 */
export function wakeupGuard(rule: WakeupRule, wakesLastHour: number): WakeupPausedReason | null {
  if (rule.fires >= rule.maxFires) return "max_fires";
  if (rule.chain.filter((id) => id === rule.id).length >= MAX_CHAIN_PASSES) return "loop";
  if (wakesLastHour >= MAX_WAKES_PER_HOUR) return "rate";
  return null;
}

export type WakeupDecision =
  /** Not now. `fingerprint` is what to store: null once the condition stopped holding, so it can fire again. */
  | { action: "wait"; fingerprint: string | null }
  | { action: "fire"; fingerprint: string }
  | { action: "pause"; reason: WakeupPausedReason }
  | { action: "expire" };

/**
 * What to do with an active wakeup now. It fires when its condition holds on facts it did not fire on
 * yet, unless a runaway limit pauses it; a condition that held is not lost to the expiry passing meanwhile.
 */
export function decideWakeup(
  rule: WakeupRule,
  facts: WakeupFacts,
  at: { now: Date; wakesLastHour: number },
): WakeupDecision {
  const fingerprint = conditionFingerprint(rule, facts, at.now);
  if (fingerprint === null || fingerprint === rule.fingerprint) {
    if (rule.expiresAt && rule.expiresAt.getTime() <= at.now.getTime() + DUE_SLACK_MS) return { action: "expire" };
    return { action: "wait", fingerprint };
  }
  const reason = wakeupGuard(rule, at.wakesLastHour);
  return reason ? { action: "pause", reason } : { action: "fire", fingerprint };
}

/** The next time of a repeating timer: missed periods are not made up, it goes on from the next one to come. */
export function nextTimerAt(previous: Date, everyMinutes: number, now: Date): Date {
  const every = everyMinutes * 60_000;
  const missed = Math.max(0, Math.floor((now.getTime() - previous.getTime()) / every));
  return new Date(previous.getTime() + (missed + 1) * every);
}

/** A wakeup once it fired: a one-time one is done, a repeating one waits for its next time or new facts. */
export function firedState(
  rule: WakeupRule,
  fingerprint: string,
  now: Date,
): Pick<Wakeup, "status" | "fires" | "fingerprint" | "nextCheckAt"> {
  const fires = rule.fires + 1;
  if (!repeats(rule)) return { status: "fired", fires, fingerprint, nextCheckAt: rule.nextCheckAt };
  const every = rule.condition.everyMinutes;
  const nextCheckAt = rule.kind === "timer" && every && rule.nextCheckAt ? nextTimerAt(rule.nextCheckAt, every, now) : null;
  return { status: "active", fires, fingerprint, nextCheckAt };
}

/**
 * The chain behind a wake run: the wakeups that fired it, each after the chain behind the run that set
 * it. Wakeups firing together may share their past, which counts once: each id as often as the
 * longest of their chains has it.
 */
export function runChain(fired: readonly Pick<WakeupRule, "id" | "chain">[]): string[] {
  const counts = new Map<string, number>();
  const chain: string[] = [];
  for (const rule of fired) {
    const own = new Map<string, number>();
    for (const id of [...rule.chain, rule.id]) {
      const seen = (own.get(id) ?? 0) + 1;
      own.set(id, seen);
      if (seen > (counts.get(id) ?? 0)) {
        counts.set(id, seen);
        chain.push(id);
      }
    }
  }
  return chain;
}

/** When a wakeup next needs a look without anything happening: its timer or its expiry, whichever comes first. */
export function nextDueAt(rule: Pick<Wakeup, "nextCheckAt" | "expiresAt">): Date | null {
  const times = [rule.nextCheckAt, rule.expiresAt].filter((d): d is Date => d !== null);
  return times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null;
}

// How a wakeup reads

/** A wakeup as the user and the agent see it: its row with what its condition refers to. */
export type WakeupView = Pick<
  Wakeup,
  | "id"
  | "kind"
  | "status"
  | "pausedReason"
  | "notes"
  | "condition"
  | "nextCheckAt"
  | "expiresAt"
  | "fires"
  | "maxFires"
  | "createdAt"
> & {
  /** `#12` or `!12`, and its link; null once the pull request is gone. */
  pullRequest: { label: string; url: string } | null;
  /** The task a task_status wakeup waits on; null once it is gone. */
  watchedTask: { id: string; title: string } | null;
};

/** Keys under `tasks.wakeups.condition` (en and ro). */
export type WakeupConditionKey = "timer" | "timerEvery" | "prChecksFinished" | "prMerged" | "subtasksDone" | "taskStatus";

/**
 * What a wakeup waits for, as a message key under `tasks.wakeups.condition` with its values. The
 * caller formats times and statuses its own way (the web in the browser's zone, comments in the
 * configured one).
 */
export function wakeupCondition(
  wakeup: Pick<WakeupView, "kind" | "condition" | "nextCheckAt" | "pullRequest" | "watchedTask">,
  format: { time: (date: Date) => string; status: (status: TaskStatus) => string },
): { key: WakeupConditionKey; values: Record<string, string | number> } {
  const { condition } = wakeup;
  const time = wakeup.nextCheckAt ? format.time(wakeup.nextCheckAt) : "-";
  const label = wakeup.pullRequest?.label ?? "-";
  switch (wakeup.kind) {
    case "timer":
      return condition.everyMinutes
        ? { key: "timerEvery", values: { minutes: condition.everyMinutes, time } }
        : { key: "timer", values: { time } };
    case "pr_checks_finished":
      return { key: "prChecksFinished", values: { label } };
    case "pr_merged":
      return { key: "prMerged", values: { label } };
    case "subtasks_done":
      return { key: "subtasksDone", values: {} };
    case "task_status":
      return {
        key: "taskStatus",
        values: {
          title: wakeup.watchedTask?.title ?? condition.taskId ?? "-",
          status: condition.status ? format.status(condition.status) : "-",
        },
      };
  }
}
