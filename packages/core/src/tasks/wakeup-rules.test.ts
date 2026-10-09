import { describe, expect, it } from "vitest";
import {
  armedFingerprint,
  decideWakeup,
  DEFAULT_MAX_FIRES,
  firedState,
  MAX_CHAIN_PASSES,
  MAX_FIRES_LIMIT,
  MAX_WAKES_PER_HOUR,
  nextDueAt,
  nextTimerAt,
  runChain,
  type WakeupFacts,
  type WakeupRule,
  wakeupCondition,
  wakeupGuard,
  wakeupKey,
} from "./wakeup-rules";

const NOW = new Date("2026-10-08T12:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

/** A chain in which `id` passed `n` times. */
const passes = (n: number, id = "w1") => Array.from({ length: n }, () => id);

const rule = (over: Partial<WakeupRule> = {}): WakeupRule => ({
  id: "w1",
  kind: "timer",
  condition: {},
  nextCheckAt: null,
  expiresAt: null,
  maxFires: 1,
  fires: 0,
  chain: [],
  fingerprint: null,
  ...over,
});

const facts = (over: Partial<WakeupFacts> = {}): WakeupFacts => ({
  pullRequests: new Map(),
  subtasks: [],
  taskStatuses: new Map(),
  ...over,
});

const pr = (checks: "none" | "pending" | "success" | "failure", headSha = "aaa", state: "open" | "merged" = "open") =>
  facts({ pullRequests: new Map([["pr1", { state, checks, headSha }]]) });

const decide = (r: WakeupRule, f = facts(), wakesLastHour = 0) => decideWakeup(r, f, { now: NOW, wakesLastHour });

describe("wakeupKey", () => {
  it("gives a task one timer, and one wakeup per pull request, watched status or subtasks", () => {
    expect(wakeupKey("timer", { everyMinutes: 30 })).toBe(wakeupKey("timer", {}));
    expect(wakeupKey("pr_merged", { pullRequestId: "pr1" })).not.toBe(wakeupKey("pr_merged", { pullRequestId: "pr2" }));
    expect(wakeupKey("pr_merged", { pullRequestId: "pr1" })).not.toBe(
      wakeupKey("pr_checks_finished", { pullRequestId: "pr1" }),
    );
    expect(wakeupKey("task_status", { taskId: "t2", status: "review" })).not.toBe(
      wakeupKey("task_status", { taskId: "t2", status: "done" }),
    );
    expect(wakeupKey("subtasks_done", {})).toBe("subtasks_done");
  });
});

describe("decideWakeup", () => {
  it("fires a timer once its time came, a moment early included, and not before", () => {
    expect(decide(rule({ nextCheckAt: minutes(5) }))).toEqual({ action: "wait", fingerprint: null });
    expect(decide(rule({ nextCheckAt: new Date(NOW.getTime() + 500) }))).toMatchObject({ action: "fire" });
    expect(decide(rule({ nextCheckAt: minutes(-1) }))).toEqual({
      action: "fire",
      fingerprint: `at:${minutes(-1).toISOString()}`,
    });
  });

  it("fires when the checks finish on the head commit, passed or failed", () => {
    const checks = rule({ kind: "pr_checks_finished", condition: { pullRequestId: "pr1" } });
    expect(decide(checks, pr("pending"))).toMatchObject({ action: "wait" });
    expect(decide(checks, pr("none"))).toMatchObject({ action: "wait" });
    expect(decide(checks, pr("failure"))).toEqual({ action: "fire", fingerprint: "aaa:failure" });
    expect(decide(checks, pr("success", "bbb"))).toEqual({ action: "fire", fingerprint: "bbb:success" });
    expect(decide(checks, facts())).toMatchObject({ action: "wait" });
  });

  it("ignores checks already finished when the wakeup was set, and fires on the next head's", () => {
    const base = rule({ kind: "pr_checks_finished", condition: { pullRequestId: "pr1" } });
    const armed = { ...base, fingerprint: armedFingerprint(base, pr("failure"), NOW) };
    expect(armed.fingerprint).toBe("aaa:failure");
    expect(decide(armed, pr("failure"))).toEqual({ action: "wait", fingerprint: "aaa:failure" });
    // The push: checks run again, and the stale result is forgotten.
    expect(decide(armed, pr("pending", "bbb"))).toEqual({ action: "wait", fingerprint: null });
    expect(decide(armed, pr("failure", "bbb"))).toEqual({ action: "fire", fingerprint: "bbb:failure" });
  });

  it("fires on a merge, and starts any other condition already true at its first check", () => {
    const merged = rule({ kind: "pr_merged", condition: { pullRequestId: "pr1" } });
    expect(armedFingerprint(merged, pr("success", "aaa", "merged"), NOW)).toBeNull();
    expect(decide(merged, pr("success"))).toMatchObject({ action: "wait" });
    expect(decide(merged, pr("success", "aaa", "merged"))).toEqual({ action: "fire", fingerprint: "merged" });
  });

  it("fires once every subtask is done, and a repeating one again for a new set", () => {
    const subtasks = rule({ kind: "subtasks_done", maxFires: 20 });
    const done = (ids: string[]) => facts({ subtasks: ids.map((id) => ({ id, status: "done" as const })) });
    expect(decide(subtasks, facts())).toMatchObject({ action: "wait" });
    expect(
      decide(
        subtasks,
        facts({
          subtasks: [
            { id: "s1", status: "done" },
            { id: "s2", status: "review" },
          ],
        }),
      ),
    ).toMatchObject({ action: "wait" });
    expect(decide(subtasks, done(["s2", "s1"]))).toEqual({ action: "fire", fingerprint: "s1,s2" });
    const fired = { ...subtasks, fires: 1, fingerprint: "s1,s2" };
    expect(decide(fired, done(["s1", "s2"]))).toMatchObject({ action: "wait" });
    expect(decide(fired, done(["s1", "s2", "s3"]))).toEqual({ action: "fire", fingerprint: "s1,s2,s3" });
  });

  it("fires when the watched task reaches the status", () => {
    const watching = rule({ kind: "task_status", condition: { taskId: "t2", status: "review" } });
    expect(decide(watching, facts({ taskStatuses: new Map([["t2", "in_progress"]]) }))).toMatchObject({
      action: "wait",
    });
    expect(decide(watching, facts({ taskStatuses: new Map([["t2", "review"]]) }))).toEqual({
      action: "fire",
      fingerprint: "review",
    });
  });

  it("expires past its expiry, unless what it waited for happened meanwhile", () => {
    const merged = rule({ kind: "pr_merged", condition: { pullRequestId: "pr1" }, expiresAt: minutes(-1) });
    expect(decide(merged, pr("success"))).toEqual({ action: "expire" });
    expect(decide(merged, pr("success", "aaa", "merged"))).toMatchObject({ action: "fire" });
    expect(decide({ ...merged, expiresAt: minutes(10) }, pr("success"))).toMatchObject({ action: "wait" });
  });

  it("pauses instead of firing once a runaway limit is reached", () => {
    const due = rule({ nextCheckAt: minutes(-1) });
    expect(decide({ ...due, maxFires: 20, fires: 20 })).toEqual({ action: "pause", reason: "max_fires" });
    expect(decide({ ...due, chain: [...passes(MAX_CHAIN_PASSES), "w0"] })).toEqual({ action: "pause", reason: "loop" });
    expect(decide(due, facts(), MAX_WAKES_PER_HOUR)).toEqual({ action: "pause", reason: "rate" });
    expect(decide(due, facts(), MAX_WAKES_PER_HOUR - 1)).toMatchObject({ action: "fire" });
  });
});

describe("wakeupGuard", () => {
  it(`lets a wakeup pass through its chain ${MAX_CHAIN_PASSES} times, and pauses the next pass as a loop`, () => {
    expect(wakeupGuard(rule({ chain: [] }), 0)).toBeNull();
    expect(wakeupGuard(rule({ chain: passes(MAX_CHAIN_PASSES - 1) }), 0)).toBeNull();
    expect(wakeupGuard(rule({ chain: passes(MAX_CHAIN_PASSES) }), 0)).toBe("loop");
    // Other wakeups in the chain do not count against this one.
    expect(wakeupGuard(rule({ chain: [...passes(MAX_CHAIN_PASSES, "w2"), "w1"] }), 0)).toBeNull();
  });

  it("checks the fires first, then the loop, then the rate", () => {
    const looped = passes(MAX_CHAIN_PASSES);
    expect(wakeupGuard(rule({ maxFires: 3, fires: 3, chain: looped }), MAX_WAKES_PER_HOUR)).toBe("max_fires");
    expect(wakeupGuard(rule({ chain: looped }), MAX_WAKES_PER_HOUR)).toBe("loop");
  });

  it("leaves a repeating wakeup with the default fires practically unlimited, within the hourly rate", () => {
    expect(DEFAULT_MAX_FIRES).toBe(MAX_FIRES_LIMIT);
    expect(MAX_FIRES_LIMIT).toBeGreaterThanOrEqual(100_000);
    expect(MAX_WAKES_PER_HOUR).toBe(60);
    expect(wakeupGuard(rule({ maxFires: DEFAULT_MAX_FIRES, fires: 10_000 }), MAX_WAKES_PER_HOUR - 1)).toBeNull();
  });
});

describe("a timer through its life", () => {
  it("wakes the agent once at its time", () => {
    const timer = rule({ nextCheckAt: minutes(-1) });
    const decision = decide(timer);
    expect(decision.action).toBe("fire");
    if (decision.action !== "fire") return;
    expect(firedState(timer, decision.fingerprint, NOW)).toEqual({
      status: "fired",
      fires: 1,
      fingerprint: decision.fingerprint,
      nextCheckAt: timer.nextCheckAt,
    });
  });

  it("is paused as a loop when the runs it wakes keep setting it again", () => {
    // Each wake run sets the same timer again: it carries the chain behind that run.
    let timer = rule({ nextCheckAt: minutes(-1) });
    const actions: string[] = [];
    for (let run = 0; run <= MAX_CHAIN_PASSES; run++) {
      const decision = decide(timer);
      actions.push(decision.action);
      if (decision.action !== "fire") break;
      timer = { ...timer, chain: runChain([timer]), fires: 0, fingerprint: null, nextCheckAt: minutes(-1) };
    }
    expect(actions).toEqual([...Array(MAX_CHAIN_PASSES).fill("fire"), "pause"]);
    expect(decide(timer)).toEqual({ action: "pause", reason: "loop" });
  });

  it("repeats on its period until its fires are used up", () => {
    const every = rule({ condition: { everyMinutes: 30 }, nextCheckAt: minutes(-1), maxFires: 2 });
    const first = firedState(every, "at:1", NOW);
    expect(first).toMatchObject({ status: "active", fires: 1, nextCheckAt: minutes(29) });
    const second = { ...every, ...first, nextCheckAt: minutes(-1) };
    expect(decide(second)).toMatchObject({ action: "fire" });
    expect(decide({ ...second, fires: 2 })).toEqual({ action: "pause", reason: "max_fires" });
  });
});

describe("nextTimerAt", () => {
  it("goes on from the next period, without making up the missed ones", () => {
    expect(nextTimerAt(minutes(0), 30, NOW)).toEqual(minutes(30));
    expect(nextTimerAt(minutes(-95), 30, NOW)).toEqual(minutes(25));
    expect(nextTimerAt(minutes(-90), 30, NOW)).toEqual(minutes(30));
  });
});

describe("runChain", () => {
  it("is the chain behind each wakeup that fired, then the wakeup", () => {
    expect(runChain([{ id: "w1", chain: [] }])).toEqual(["w1"]);
    expect(runChain([{ id: "w1", chain: ["w1"] }])).toEqual(["w1", "w1"]);
  });

  it("counts a past the wakeups firing together share once", () => {
    const chain = runChain([
      { id: "w1", chain: ["w0"] },
      { id: "w2", chain: ["w0"] },
    ]);
    expect(chain.filter((id) => id === "w0")).toHaveLength(1);
    expect([...chain].sort()).toEqual(["w0", "w1", "w2"]);
    // As often as the longest of their chains has it.
    const repeated = runChain([
      { id: "w1", chain: ["w0", "w0"] },
      { id: "w2", chain: ["w0"] },
    ]);
    expect(repeated.filter((id) => id === "w0")).toHaveLength(2);
  });
});

describe("nextDueAt", () => {
  it("is the timer or the expiry, whichever comes first", () => {
    expect(nextDueAt({ nextCheckAt: null, expiresAt: null })).toBeNull();
    expect(nextDueAt({ nextCheckAt: minutes(10), expiresAt: null })).toEqual(minutes(10));
    expect(nextDueAt({ nextCheckAt: minutes(10), expiresAt: minutes(5) })).toEqual(minutes(5));
  });
});

describe("wakeupCondition", () => {
  const format = { time: (date: Date) => date.toISOString(), status: (status: string) => status.toUpperCase() };
  const view = {
    condition: {},
    nextCheckAt: minutes(10),
    pullRequest: { label: "#12", url: "https://github.com/acme/site/pull/12" },
    watchedTask: { id: "t2", title: "Ship the API" },
  };

  it("names what each kind waits for, with its values", () => {
    expect(wakeupCondition({ ...view, kind: "timer" }, format)).toEqual({
      key: "timer",
      values: { time: minutes(10).toISOString() },
    });
    expect(wakeupCondition({ ...view, kind: "timer", condition: { everyMinutes: 30 } }, format)).toEqual({
      key: "timerEvery",
      values: { minutes: 30, time: minutes(10).toISOString() },
    });
    expect(wakeupCondition({ ...view, kind: "pr_checks_finished" }, format)).toEqual({
      key: "prChecksFinished",
      values: { label: "#12" },
    });
    expect(
      wakeupCondition({ ...view, kind: "task_status", condition: { taskId: "t2", status: "review" } }, format),
    ).toEqual({ key: "taskStatus", values: { title: "Ship the API", status: "REVIEW" } });
  });

  it("still reads when what it refers to is gone", () => {
    expect(wakeupCondition({ ...view, kind: "pr_merged", pullRequest: null }, format)).toEqual({
      key: "prMerged",
      values: { label: "-" },
    });
  });
});
