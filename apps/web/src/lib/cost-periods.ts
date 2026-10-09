/** Periods the costs page offers, in days, and the one it opens on. Shared by the page and its select. */
export const COST_PERIODS = [7, 30, 90] as const;
export const DEFAULT_COST_PERIOD = 30;

/** `?days=` as one of the periods; anything else is the default. */
export function parseCostPeriod(value: string | string[] | undefined): number {
  const days = Number(Array.isArray(value) ? value[0] : value);
  return (COST_PERIODS as readonly number[]).includes(days) ? days : DEFAULT_COST_PERIOD;
}
