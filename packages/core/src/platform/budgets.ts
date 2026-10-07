import { db, projects, runs } from "@abotica/db";
import { and, eq, gte, isNotNull, sum } from "@abotica/db/orm";
import { getTranslator } from "@abotica/i18n";
import { costSince, dayBounds, startOfMonth } from "./costs";
import { notify } from "../infra/queues";
import { redis } from "../infra/redis";
import { getSettings, settingsLocale } from "./settings";

/**
 * A monthly budget with what was spent against it since the start of the month (settings timezone).
 * `global` is the one from Settings > General, across all projects; `project` a project's own.
 */
export type MonthlyBudget =
  | { scope: "global"; budgetUsd: number; spentUsd: number }
  | { scope: "project"; projectId: string; name: string; budgetUsd: number; spentUsd: number };

type ProjectBudgetFields = { id: string; name: string; budgetUsd: number | null };

/** Total cost of a project's runs this month, background "system" runs included. */
export async function projectSpendThisMonth(projectId: string): Promise<number> {
  const start = startOfMonth((await getSettings()).timezone);
  const [row] = await db
    .select({ total: sum(runs.costUsd) })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), gte(runs.createdAt, start)));
  return Number(row?.total ?? 0);
}

/** This month's spend of every project that has a budget, in one query, by name. */
export async function projectBudgetsThisMonth(): Promise<Extract<MonthlyBudget, { scope: "project" }>[]> {
  const start = startOfMonth((await getSettings()).timezone);
  const rows = await db
    .select({ id: projects.id, name: projects.name, budgetUsd: projects.budgetUsd, spent: sum(runs.costUsd) })
    .from(projects)
    .leftJoin(runs, and(eq(runs.projectId, projects.id), gte(runs.createdAt, start)))
    .where(isNotNull(projects.budgetUsd))
    .groupBy(projects.id)
    .orderBy(projects.name);
  return rows.map((r) => ({
    scope: "project",
    projectId: r.id,
    name: r.name,
    budgetUsd: Number(r.budgetUsd ?? 0),
    spentUsd: Number(r.spent ?? 0),
  }));
}

/** The global budget with this month's spend across all projects; null when none is set. */
export async function globalBudgetThisMonth(): Promise<Extract<MonthlyBudget, { scope: "global" }> | null> {
  const { monthlyBudgetUsd, timezone } = await getSettings();
  if (monthlyBudgetUsd == null) return null;
  return { scope: "global", budgetUsd: monthlyBudgetUsd, spentUsd: await costSince(startOfMonth(timezone)) };
}

/** The monthly budgets that work in `project` counts against (null: work outside any project). */
export async function applicableBudgets(project: ProjectBudgetFields | null): Promise<MonthlyBudget[]> {
  const budgets: MonthlyBudget[] = [];
  const global = await globalBudgetThisMonth();
  if (global) budgets.push(global);
  if (project?.budgetUsd != null) {
    budgets.push({
      scope: "project",
      projectId: project.id,
      name: project.name,
      budgetUsd: project.budgetUsd,
      spentUsd: await projectSpendThisMonth(project.id),
    });
  }
  return budgets;
}

/** The budget with the least left (negative once overspent), null when no budget applies. On a tie, the first. */
export function tightestBudget(budgets: MonthlyBudget[]): { budget: MonthlyBudget; remainingUsd: number } | null {
  let tightest: { budget: MonthlyBudget; remainingUsd: number } | null = null;
  for (const budget of budgets) {
    const remainingUsd = budget.budgetUsd - budget.spentUsd;
    if (!tightest || remainingUsd < tightest.remainingUsd) tightest = { budget, remainingUsd };
  }
  return tightest;
}

/** The reached budget a background model call of `projectId` must not spend past, null when it may run. */
export async function reachedBudget(projectId: string | null): Promise<MonthlyBudget | null> {
  const [project] = projectId
    ? await db
        .select({ id: projects.id, name: projects.name, budgetUsd: projects.budgetUsd })
        .from(projects)
        .where(eq(projects.id, projectId))
    : [];
  const tightest = tightestBudget(await applicableBudgets(project ?? null));
  return tightest && tightest.remainingUsd <= 0 ? tightest.budget : null;
}

/** Percentages of a budget that send an alert, ascending. */
export const BUDGET_ALERT_THRESHOLDS = [80, 100] as const;
export type BudgetAlertThreshold = (typeof BUDGET_ALERT_THRESHOLDS)[number];

/** Absorbs float error, so 1.16 counts as 80% of 1.45. */
const EPSILON = 1e-9;

/** The highest alert threshold the spend has crossed, null below the first. A budget of 0 sends no alerts. */
export function crossedThreshold(spentUsd: number, budgetUsd: number): BudgetAlertThreshold | null {
  if (budgetUsd <= 0) return null;
  let crossed: BudgetAlertThreshold | null = null;
  for (const threshold of BUDGET_ALERT_THRESHOLDS) {
    if (spentUsd * 100 >= budgetUsd * threshold - EPSILON) crossed = threshold;
  }
  return crossed;
}

/** The month (YYYY-MM) containing `date` in the timezone. */
export const monthKey = (timezone: string, date: Date = new Date()) => dayBounds(timezone, date).day.slice(0, 7);

/**
 * Redis key that marks an alert as sent: one per scope, month, threshold and budget value, so raising
 * the budget arms the alerts again.
 */
export function budgetAlertKey(budget: MonthlyBudget, month: string, threshold: BudgetAlertThreshold): string {
  const scope = budget.scope === "global" ? "global" : `project:${budget.projectId}`;
  return `abotica:budget-alert:${scope}:${month}:${threshold}:${budget.budgetUsd}`;
}

/** Outlives the month it marks, so an alert is never sent twice within it. */
const ALERT_TTL_SECONDS = 40 * 24 * 3600;

const usd = (amount: number) => amount.toFixed(2);

/**
 * Sends one notification when a budget's spend crosses 80% and one when it crosses 100%, once per
 * scope, month, threshold and budget value. Spend that jumps past both in one check sends only the
 * 100% one. Returns how many were sent.
 */
export async function sendBudgetAlerts(): Promise<number> {
  const settings = await getSettings();
  const t = getTranslator(settingsLocale(settings));
  const month = monthKey(settings.timezone);
  const global = await globalBudgetThisMonth();
  const budgets: MonthlyBudget[] = [...(global ? [global] : []), ...(await projectBudgetsThisMonth())];
  let sent = 0;
  for (const budget of budgets) {
    const threshold = crossedThreshold(budget.spentUsd, budget.budgetUsd);
    if (threshold === null) continue;
    const key = budgetAlertKey(budget, month, threshold);
    if ((await redis().set(key, "1", "EX", ALERT_TTL_SECONDS, "NX")) !== "OK") continue;
    const kind = threshold === 100 ? "reached" : "warning";
    const values = { threshold, spent: usd(budget.spentUsd), budget: usd(budget.budgetUsd) };
    try {
      await notify(
        budget.scope === "global"
          ? { kind: "text", text: t(`notifications.budget.global.${kind}`, values) }
          : {
              kind: "text",
              text: t(`notifications.budget.project.${kind}`, { ...values, project: budget.name }),
              projectId: budget.projectId,
            },
      );
    } catch (error) {
      // Not marked as sent, so the next check tries again.
      await redis().del(key);
      throw error;
    }
    sent += 1;
  }
  return sent;
}
