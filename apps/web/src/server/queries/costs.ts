import "server-only";
import {
  costSince,
  dayBounds,
  getSettings,
  globalBudgetThisMonth,
  isProviderId,
  projectBudgetsThisMonth,
  PROVIDERS,
  startOfMonth,
} from "@abotica/core";
import { agents, db, projects, runs } from "@abotica/db";
import { and, count, desc, eq, gte, sql, sum } from "@abotica/db/orm";
import { query } from "@/server/query";

type DailyCostPoint = { day: string } & Record<string, number | string>;

/** Days and months follow the configured timezone, like the budget checks in core. */
const timezone = async () => (await getSettings()).general.timezone;

/** The YYYY-MM-DD day `offset` days away from `day`. */
function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** UTC instant of local midnight for a YYYY-MM-DD day. Noon UTC falls on that day, or on the next one east of UTC+12. */
function startOfDay(tz: string, day: string): Date {
  const bounds = dayBounds(tz, new Date(`${day}T12:00:00Z`));
  return bounds.day === day ? bounds.start : dayBounds(tz, new Date(bounds.start.getTime() - 1)).start;
}

/** First day (YYYY-MM-DD) of the last `days` days, today included. */
const firstDay = (tz: string, days: number) => shiftDay(dayBounds(tz).day, -(days - 1));

/** Cost per day for the last `days` days, one key per provider, days without runs filled with 0. */
export const getDailyCostByProvider = query(
  async (
    days: number,
  ): Promise<{
    points: DailyCostPoint[];
    series: { key: string; label: string }[];
  }> => {
    const tz = await timezone();
    const first = firstDay(tz, days);
    const day = sql<string>`to_char(date_trunc('day', ${runs.createdAt} at time zone ${tz}), 'YYYY-MM-DD')`;
    // Runs without a provider get the series key "unknown", translated by the cost chart.
    const rows = await db
      .select({ day, provider: sql<string>`coalesce(${runs.provider}, 'unknown')`, cost: sum(runs.costUsd) })
      .from(runs)
      .where(gte(runs.createdAt, startOfDay(tz, first)))
      .groupBy(sql`1`, sql`2`);

    const providers = [...new Set(rows.filter((r) => Number(r.cost) > 0).map((r) => r.provider))].sort();
    const byDay = new Map<string, DailyCostPoint>();
    for (let i = 0; i < days; i++) {
      const key = shiftDay(first, i);
      const point: DailyCostPoint = { day: key };
      for (const p of providers) point[p] = 0;
      byDay.set(key, point);
    }
    for (const r of rows) {
      const point = byDay.get(r.day);
      if (point && providers.includes(r.provider)) point[r.provider] = Number(r.cost ?? 0);
    }
    const series = providers.map((p) => ({ key: p, label: isProviderId(p) ? PROVIDERS[p].label : p }));
    return { points: [...byDay.values()], series };
  },
);

export const getMonthCosts = query(async () => {
  const tz = await timezone();
  const thisMonth = startOfMonth(tz);
  const lastMonth = startOfMonth(tz, -1);
  const [current, previous] = await Promise.all([costSince(thisMonth), costSince(lastMonth, thisMonth)]);
  return { current, previous };
});

export const getCostReport = query(async (days: number) => {
  const tz = await timezone();
  const from = startOfDay(tz, firstDay(tz, days));
  const inPeriod = gte(runs.createdAt, from);
  const totals = {
    cost: sum(runs.costUsd),
    inputTokens: sum(runs.inputTokens),
    outputTokens: sum(runs.outputTokens),
    runs: count(),
  };
  const notSystem = sql`${runs.trigger} <> 'system'`;

  const [[total], [system], byAgent, byProject, byModel, daily, budgets] = await Promise.all([
    db.select(totals).from(runs).where(inPeriod),
    db
      .select(totals)
      .from(runs)
      .where(and(inPeriod, eq(runs.trigger, "system"))),
    db
      .select({ agentId: agents.id, name: agents.name, avatar: agents.avatar, ...totals })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .where(and(inPeriod, notSystem))
      .groupBy(agents.id, agents.name, agents.avatar)
      .orderBy(desc(sum(runs.costUsd))),
    db
      .select({ projectId: runs.projectId, name: projects.name, ...totals })
      .from(runs)
      .leftJoin(projects, eq(projects.id, runs.projectId))
      .where(inPeriod)
      .groupBy(runs.projectId, projects.name)
      .orderBy(desc(sum(runs.costUsd))),
    db
      .select({ provider: runs.provider, model: runs.model, ...totals })
      .from(runs)
      .where(inPeriod)
      .groupBy(runs.provider, runs.model)
      .orderBy(desc(sum(runs.costUsd))),
    getDailyCostByProvider(days),
    listMonthlyBudgets(),
  ]);

  const num = <T extends { cost: string | null; inputTokens: string | null; outputTokens: string | null }>(r: T) => ({
    ...r,
    cost: Number(r.cost ?? 0),
    inputTokens: Number(r.inputTokens ?? 0),
    outputTokens: Number(r.outputTokens ?? 0),
  });

  return {
    total: num(total ?? { cost: null, inputTokens: null, outputTokens: null, runs: 0 }),
    byAgent: byAgent.map(num),
    /** Background jobs (trigger "system") shown as their own row, not under an agent. */
    system: system && system.runs > 0 ? num(system) : null,
    byProject: byProject.map(num),
    byModel: byModel.map(num),
    daily,
    budgets,
  };
});

/** This month's spend against the global budget (null when none is set) and the projects' own budgets. */
async function listMonthlyBudgets() {
  const [global, projectBudgets] = await Promise.all([globalBudgetThisMonth(), projectBudgetsThisMonth()]);
  return {
    global: global && { budgetUsd: global.budgetUsd, spent: global.spentUsd },
    projects: projectBudgets.map((b) => ({ id: b.projectId, name: b.name, budgetUsd: b.budgetUsd, spent: b.spentUsd })),
  };
}
