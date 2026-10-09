import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as Budgets from "./budgets";

let budgetAlertKey: typeof Budgets.budgetAlertKey;
let budgetAlertThresholds: typeof Budgets.budgetAlertThresholds;
let crossedThreshold: typeof Budgets.crossedThreshold;
let monthKey: typeof Budgets.monthKey;
let tightestBudget: typeof Budgets.tightestBudget;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  ({ budgetAlertKey, budgetAlertThresholds, crossedThreshold, monthKey, tightestBudget } = await import("./budgets"));
});

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const global = (budgetUsd: number, spentUsd: number) => ({ scope: "global" as const, budgetUsd, spentUsd });
const project = (budgetUsd: number, spentUsd: number) => ({
  scope: "project" as const,
  projectId: PROJECT_ID,
  name: "Site",
  budgetUsd,
  spentUsd,
});

describe("budgetAlertThresholds", () => {
  it("warns at each configured percent and always at 100", () => {
    expect(budgetAlertThresholds([80])).toEqual([80, 100]);
    expect(budgetAlertThresholds([90, 50, 75])).toEqual([50, 75, 90, 100]);
  });

  it("alerts only at 100 when no warnings are configured", () => {
    expect(budgetAlertThresholds([])).toEqual([100]);
  });

  it("does not repeat 100 or a percent given twice", () => {
    expect(budgetAlertThresholds([100, 80, 80])).toEqual([80, 100]);
  });
});

describe("crossedThreshold", () => {
  const thresholds = [80, 100];

  it("is null below 80%", () => {
    expect(crossedThreshold(0, 50, thresholds)).toBe(null);
    expect(crossedThreshold(39.99, 50, thresholds)).toBe(null);
  });

  it("is 80 from 80% up to the budget", () => {
    expect(crossedThreshold(40, 50, thresholds)).toBe(80);
    expect(crossedThreshold(49.99, 50, thresholds)).toBe(80);
  });

  it("is 100 once the budget is reached or passed", () => {
    expect(crossedThreshold(50, 50, thresholds)).toBe(100);
    expect(crossedThreshold(120, 50, thresholds)).toBe(100);
  });

  it("does not miss 80% to floating point", () => {
    expect(crossedThreshold(0.8, 1, thresholds)).toBe(80);
    expect(crossedThreshold(1.16, 1.45, thresholds)).toBe(80);
  });

  it("sends nothing for a budget of 0", () => {
    expect(crossedThreshold(0, 0, thresholds)).toBe(null);
    expect(crossedThreshold(3, 0, thresholds)).toBe(null);
  });

  it("follows the configured percents, the highest crossed first", () => {
    const configured = budgetAlertThresholds([50, 90]);
    expect(crossedThreshold(20, 50, configured)).toBe(null);
    expect(crossedThreshold(25, 50, configured)).toBe(50);
    expect(crossedThreshold(44, 50, configured)).toBe(50);
    expect(crossedThreshold(46, 50, configured)).toBe(90);
    expect(crossedThreshold(50, 50, configured)).toBe(100);
  });

  it("with no warnings configured, alerts only once the budget is reached", () => {
    expect(crossedThreshold(49, 50, budgetAlertThresholds([]))).toBe(null);
    expect(crossedThreshold(50, 50, budgetAlertThresholds([]))).toBe(100);
  });
});

describe("budgetAlertKey", () => {
  it("names the scope, month, threshold and budget", () => {
    expect(budgetAlertKey(global(50, 45), "2026-10", 80)).toBe("abotica:budget-alert:global:2026-10:80:50");
    expect(budgetAlertKey(project(12.5, 13), "2026-10", 100)).toBe(
      `abotica:budget-alert:project:${PROJECT_ID}:2026-10:100:12.5`,
    );
  });

  it("changes with the budget, so raising it arms the alert again", () => {
    expect(budgetAlertKey(global(50, 45), "2026-10", 80)).not.toBe(budgetAlertKey(global(100, 45), "2026-10", 80));
  });

  it("does not depend on the spend", () => {
    expect(budgetAlertKey(global(50, 41), "2026-10", 80)).toBe(budgetAlertKey(global(50, 49), "2026-10", 80));
  });

  it("differs per month and threshold", () => {
    const keys = new Set([
      budgetAlertKey(global(50, 0), "2026-10", 80),
      budgetAlertKey(global(50, 0), "2026-10", 100),
      budgetAlertKey(global(50, 0), "2026-11", 80),
    ]);
    expect(keys.size).toBe(3);
  });
});

describe("monthKey", () => {
  it("follows the timezone across the month boundary", () => {
    const lateUtc = new Date("2026-10-31T22:30:00Z");
    expect(monthKey("UTC", lateUtc)).toBe("2026-10");
    expect(monthKey("Europe/Bucharest", lateUtc)).toBe("2026-11");
    expect(monthKey("America/New_York", new Date("2026-11-01T02:00:00Z"))).toBe("2026-10");
  });
});

describe("tightestBudget", () => {
  it("is null when no budget applies", () => {
    expect(tightestBudget([])).toBe(null);
  });

  it("picks the budget with the least left", () => {
    expect(tightestBudget([global(100, 90), project(20, 5)])).toEqual({ budget: global(100, 90), remainingUsd: 10 });
    expect(tightestBudget([global(100, 50), project(20, 5)])).toEqual({ budget: project(20, 5), remainingUsd: 15 });
  });

  it("goes negative once a budget is overspent", () => {
    expect(tightestBudget([project(10, 12)])?.remainingUsd).toBe(-2);
  });

  it("keeps the first on a tie", () => {
    expect(tightestBudget([global(50, 40), project(20, 10)])?.budget.scope).toBe("global");
  });
});
