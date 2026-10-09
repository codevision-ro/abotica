import { describe, expect, it } from "vitest";
import { isRetryable, retryPlan } from "./retry-rules";

const NOW = new Date("2026-10-09T12:00:00Z");
const settings = { transientRetries: 6 };
/** Minutes until the retry, with the jitter at its middle (no spread). */
const waitOf = (kind: Parameters<typeof retryPlan>[0], attempt: number, retries = settings) => {
  const plan = retryPlan(kind, attempt, retries, NOW, () => 0.5);
  return plan ? (plan.at.getTime() - NOW.getTime()) / 60_000 : null;
};

describe("retryPlan", () => {
  it("backs off rate limits and unavailable providers up to 30 minutes", () => {
    expect([1, 2, 3, 4, 5, 6].map((a) => waitOf("rate_limited", a))).toEqual([1, 2, 4, 8, 16, 30]);
    expect(waitOf("providers_unavailable", 3)).toBe(4);
  });

  it("waits longer for a usage limit, at most an hour", () => {
    expect([1, 2, 3, 4].map((a) => waitOf("usage_limit", a))).toEqual([15, 30, 60, 60]);
  });

  it("retries a worker restart, a lost job and an overdue run soon", () => {
    expect([1, 2, 3, 4].map((a) => waitOf("worker_restarted", a))).toEqual([0.5, 2, 5, 5]);
    expect(waitOf("unqueued", 1)).toBe(0.5);
    expect(waitOf("overdue", 2)).toBe(2);
  });

  it("never retries what would fail again or was someone's decision", () => {
    for (const kind of [
      "kill_switch",
      "cancelled_by_user",
      "cancelled_by_agent",
      "budget",
      "provider_auth",
      "no_model",
      "other",
    ] as const) {
      expect(retryPlan(kind, 1, settings, NOW), kind).toBeNull();
      expect(isRetryable(kind), kind).toBe(false);
    }
    expect(retryPlan(null, 1, settings, NOW)).toBeNull();
    expect(isRetryable("rate_limited")).toBe(true);
  });

  it("stops once the run was the last retry Settings allow", () => {
    expect(waitOf("rate_limited", 6)).toBe(30);
    expect(waitOf("rate_limited", 7)).toBeNull();
    expect(waitOf("worker_restarted", 1, { transientRetries: 0 })).toBeNull();
    expect(waitOf("worker_restarted", 1, { transientRetries: 1 })).toBe(0.5);
    expect(waitOf("worker_restarted", 2, { transientRetries: 1 })).toBeNull();
  });

  it("spreads the wait within 10% of its value", () => {
    const at = (random: number) => retryPlan("rate_limited", 2, settings, NOW, () => random)!.at.getTime() - NOW.getTime();
    expect(at(0)).toBe(108_000);
    expect(at(1)).toBe(132_000);
  });
});
